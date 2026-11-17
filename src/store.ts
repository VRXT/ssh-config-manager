import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Doc, parse, setSpacers, syncMirror } from './sshConfig';

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function collapseHome(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

/** Owns the config file on disk: loads it, watches it, and is the only thing that writes it. */
export class Store implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  doc: Doc = parse('');
  included: Doc[] = [];
  error: string | undefined;

  private watched: string | undefined;
  private lastText = '';

  constructor(private readonly backupDir: string) {
    this.reload();
  }

  get configPath(): string {
    const raw = vscode.workspace.getConfiguration('sshManager').get<string>('configFile') || '~/.ssh/config';
    return path.resolve(expandHome(raw.trim()));
  }

  get isDefaultPath(): boolean {
    return this.configPath === path.join(os.homedir(), '.ssh', 'config');
  }

  reload(): void {
    const file = this.configPath;
    this.watch(file);
    let text = '';
    this.error = undefined;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e: any) {
      if (e?.code !== 'ENOENT') {
        this.error = String(e?.message ?? e);
      }
    }
    this.lastText = text;
    this.doc = parse(text, file);
    this.included = this.loadIncludes(this.doc, file);
    this.changed.fire();
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
      const file = this.configPath;
      // keep the generated favorites block (if that setting is on) in step with the edit
      // and, when the Remote-SSH picker rows are in use, rebuild them so new or renamed folders get theirs
      let after = parse(edited, file);
      if (after.spacers.length) {
        after = parse(setSpacers(after, true), file);
      }
      const next = syncMirror(after);
      if (fs.existsSync(file)) {
        this.backup(this.lastText);
        fs.writeFileSync(file, next); // follows symlinks, keeps permissions
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, next, { mode: 0o600 });
      }
      this.reload();
      return true;
    } catch (e: any) {
      vscode.window.showErrorMessage(`SSH Config Manager: ${e?.message ?? e}`);
      return false;
    }
  }

  private backup(text: string): void {
    try {
      fs.mkdirSync(this.backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(this.backupDir, `config-${stamp}.bak`), text, { mode: 0o600 });
      const old = fs.readdirSync(this.backupDir).filter(f => f.endsWith('.bak')).sort();
      for (const f of old.slice(0, Math.max(0, old.length - 20))) {
        fs.unlinkSync(path.join(this.backupDir, f));
      }
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
          const d = parse(fs.readFileSync(file, 'utf8'), file, true);
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
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        // deleted
      }
      if (text !== this.lastText) {
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
    this.unwatch();
    this.changed.dispose();
  }
}
