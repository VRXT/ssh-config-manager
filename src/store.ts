import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Backup, backupDir, listBackups, writeBackup } from './backups';
import { ReadProblem, explainReadError, problemReport, readText } from './readFile';
import { Doc, finalize, parse } from './sshConfig';
import { hasInclude } from './sync';

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function collapseHome(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

export const DEFAULT_CONFIG = path.join(os.homedir(), '.ssh', 'config');

/** Owns the config file on disk: loads it, watches it, backs it up, and is the only thing that writes it. */
export class Store implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly autoFormatted = new vscode.EventEmitter<void>();
  /** fires the one time the Remote-SSH list formatting is switched on by default */
  readonly onDidAutoFormat = this.autoFormatted.event;

  doc: Doc = parse('');
  included: Doc[] = [];
  /** set while the config file cannot be read: one line for a message */
  error: string | undefined;
  /** the same, with the likely reason and what to do about it */
  problem: ReadProblem | undefined;

  private watched: string | undefined;
  private lastText = '';
  /** the file the current hosts were read from, when that read worked */
  private loaded: string | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retries = 0;

  /** `legacyBackupDir`: where versions before 0.6 kept backups; still listed for restore. */
  constructor(private readonly legacyBackupDir: string, private readonly log: (line: string) => void = () => undefined) {
    this.reload();
  }

  get configPath(): string {
    const raw = vscode.workspace.getConfiguration('sshManager').get<string>('configFile') || '~/.ssh/config';
    return path.resolve(expandHome(raw.trim()));
  }

  get isDefaultPath(): boolean {
    return this.configPath === DEFAULT_CONFIG;
  }

  /** The file's current text as last read from disk. */
  get text(): string {
    return this.lastText;
  }

  get exists(): boolean {
    return fs.existsSync(this.configPath);
  }

  /**
   * `-F <file>` for ssh when it would not read this config on its own: not needed for
   * ~/.ssh/config, nor for a shared file that ~/.ssh/config pulls in with Include.
   */
  get sshConfigFile(): string | undefined {
    if (this.isDefaultPath) {
      return undefined;
    }
    try {
      if (hasInclude(fs.readFileSync(DEFAULT_CONFIG, 'utf8'), this.configPath)) {
        return undefined;
      }
    } catch {
      // no ~/.ssh/config
    }
    return this.configPath;
  }

  reload(): void {
    const file = this.configPath;
    this.watch(file);
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const before = this.problem;
    let text = '';
    this.error = undefined;
    this.problem = undefined;
    try {
      text = readText(file);
    } catch (e: any) {
      if (e?.code !== 'ENOENT') {
        this.problem = explainReadError(e, file, this.realPath(file), collapseHome);
        this.error = `${this.problem.title}. ${this.problem.why}`;
      }
    }
    if (this.problem) {
      if (!before || before.code !== this.problem.code) {
        for (const line of problemReport(this.problem)) {
          this.log(line);
        }
      }
      // A file in a cloud folder is often back a moment later: look again by itself, less and
      // less often (2 s, 5 s, 15 s, then every 30 s). The watcher only notices a changed file.
      const wait = [2000, 5000, 15000][this.retries] ?? 30000;
      this.retries++;
      this.retryTimer = setTimeout(() => this.reload(), wait);
      if (this.loaded === file) {
        // keep showing the hosts that were read last: an unreadable file is not an empty one
        this.changed.fire();
        return;
      }
    } else {
      if (before) {
        this.log(`${collapseHome(file)} can be read again.`);
      }
      this.retries = 0;
      this.loaded = file;
    }
    this.lastText = text;
    this.doc = parse(text, file);
    this.included = this.loadIncludes(this.doc, file);
    this.changed.fire();
  }

  private realPath(file: string): string {
    try {
      return fs.realpathSync(file);
    } catch {
      return file;
    }
  }

  /** Re-reads the file, applies `edit` to the fresh contents, backs up, writes. */
  async mutate(edit: (doc: Doc) => string): Promise<boolean> {
    try {
      this.reload();
      if (this.error) {
        throw new Error(this.error);
      }
      const edited = edit(this.doc);
      if (edited === this.lastText) {
        return true;
      }
      // Remote-SSH list rows and the generated favorites block are rebuilt on every save
      const { text: next, autoEnabled } = finalize(edited, this.configPath);
      this.write(next);
      if (autoEnabled) {
        this.autoFormatted.fire();
      }
      return true;
    } catch (e: any) {
      vscode.window.showErrorMessage(`SSH Config Manager: ${e?.message ?? e}`);
      return false;
    }
  }

  /** Replaces the whole file (restore, or a newer copy from another computer). The old content is backed up first. */
  replace(text: string): void {
    this.reload();
    if (text !== this.lastText) {
      this.write(text);
    }
  }

  private write(next: string): void {
    const file = this.configPath;
    if (fs.existsSync(file)) {
      this.backup(this.lastText);
      fs.writeFileSync(file, next); // follows symlinks, keeps permissions
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, next, { mode: 0o600 });
    }
    this.reload();
  }

  // ---- backups: a folder next to the config file

  get backupDir(): string {
    return backupDir(this.configPath);
  }

  private get keep(): number {
    const n = vscode.workspace.getConfiguration('sshManager').get<number>('backup.keep') ?? 30;
    return Math.min(500, Math.max(1, Math.floor(n)));
  }

  /** Newest first; includes the ones older versions kept in VS Code's own storage. */
  backups(): Backup[] {
    return [...listBackups(this.backupDir), ...listBackups(this.legacyBackupDir)].sort((a, b) => b.date.getTime() - a.date.getTime());
  }

  /** Saves the current file as a backup now. Returns the file, or undefined when nothing changed since the last one. */
  backupNow(): string | undefined {
    this.reload();
    return writeBackup(this.backupDir, this.lastText, this.keep);
  }

  private backup(text: string): void {
    try {
      writeBackup(this.backupDir, text, this.keep);
    } catch {
      // a failed backup must not block the edit
    }
  }

  private loadIncludes(doc: Doc, mainFile: string): Doc[] {
    const out: Doc[] = [];
    const base = path.join(os.homedir(), '.ssh');
    for (const inc of doc.includes) {
      const full = path.resolve(base, expandHome(inc));
      for (const file of this.glob(full)) {
        if (file === mainFile) {
          continue;
        }
        try {
          const d = parse(readText(file), file, true);
          if (d.hosts.length) {
            out.push(d);
          }
        } catch {
          // missing include: ssh ignores it too
        }
      }
    }
    return out;
  }

  private glob(full: string): string[] {
    const name = path.basename(full);
    if (!/[*?]/.test(name)) {
      return [full];
    }
    const re = new RegExp('^' + name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    try {
      return fs.readdirSync(path.dirname(full)).filter(f => re.test(f)).sort().map(f => path.join(path.dirname(full), f));
    } catch {
      return [];
    }
  }

  private watch(file: string): void {
    if (this.watched === file) {
      return;
    }
    this.unwatch();
    this.watched = file;
    // polling survives symlinks and cloud-synced folders, where fs.watch is unreliable
    fs.watchFile(file, { interval: 1500 }, () => {
      let text: string | undefined = '';
      try {
        text = readText(file);
      } catch (e: any) {
        // deleted = empty; anything else = could not look, which reload() reports
        text = e?.code === 'ENOENT' ? '' : undefined;
      }
      if (text !== this.lastText || this.problem) {
        this.reload();
      }
    });
  }

  private unwatch(): void {
    if (this.watched) {
      fs.unwatchFile(this.watched);
      this.watched = undefined;
    }
  }

  dispose(): void {
    clearTimeout(this.retryTimer);
    this.unwatch();
    this.changed.dispose();
    this.autoFormatted.dispose();
  }
}
