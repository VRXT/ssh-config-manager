import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { writeBackup } from './backups';
import { missingKeys } from './keys';
import { DEFAULT_CONFIG, Store, collapseHome, expandHome } from './store';
import {
  SYNC_MODES, SyncMode, addInclude, cloudFolders, decideCopy, hasInclude, hashFile, hashText, isLinkTo, makeLink, removeInclude, samePath,
  unlinkToCopy, writeContent,
} from './sync';

export interface SyncStatus {
  mode: SyncMode;
  /** the shared file, as the user would write it (~ for home) */
  file: string;
  state: 'off' | 'ok' | 'conflict' | 'error';
  /** one line for the settings page and the tooltip */
  message: string;
  /** last time the two copies were confirmed equal (copy mode) */
  last?: number;
}

const SHARED_NAME = 'ssh_config';

/** Connects the three sync modes of sync.ts to VS Code: settings, prompts, watching, status. */
export class SyncController implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  private watchedShared: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private asking = false;
  private error: string | undefined;
  private conflict = false;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly store: Store, private readonly state: vscode.Memento) {
    this.subs.push(
      store.onDidChange(() => this.schedule()),
      vscode.window.onDidChangeWindowState(s => s.focused && this.schedule(200)),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('sshManager.sync')) {
          this.watch();
          this.schedule(200);
          this.changed.fire();
        }
      }),
    );
    this.watch();
    this.schedule(1500);
  }

  // ---- settings (per computer: paths differ between machines)

  private get cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('sshManager');
  }

  get mode(): SyncMode {
    const m = this.cfg.get<string>('sync.mode');
    return m === 'copy' || m === 'link' || m === 'include' ? m : 'off';
  }

  /** Full path of the shared file ('' when none is set). */
  get shared(): string {
    const raw = (this.cfg.get<string>('sync.file') ?? '').trim();
    return raw ? path.resolve(expandHome(raw)) : '';
  }

  private async save(mode: SyncMode, shared: string): Promise<void> {
    await this.cfg.update('sync.mode', mode === 'off' ? undefined : mode, vscode.ConfigurationTarget.Global);
    await this.cfg.update('sync.file', shared ? collapseHome(shared) : undefined, vscode.ConfigurationTarget.Global);
  }

  private get baseKey(): string {
    return `sync.base:${this.shared}`;
  }

  get status(): SyncStatus {
    const mode = this.mode;
    const shared = this.shared;
    const file = shared ? collapseHome(shared) : '';
    if (mode === 'off' || !shared) {
      return { mode: 'off', file, state: 'off', message: 'Not syncing. Your config lives on this computer only.' };
    }
    if (this.error) {
      return { mode, file, state: 'error', message: this.error };
    }
    if (mode === 'link') {
      return isLinkTo(this.store.configPath, shared)
        ? { mode, file, state: 'ok', message: 'Your config is a link to the shared file.' }
        : { mode, file, state: 'error', message: 'Your config is no longer a link to the shared file. Set up sync again to repair it.' };
    }
    if (mode === 'include') {
      let included = false;
      try {
        included = hasInclude(fs.readFileSync(DEFAULT_CONFIG, 'utf8'), shared);
      } catch {
        // no ~/.ssh/config
      }
      return included && samePath(this.store.configPath, shared)
        ? { mode, file, state: 'ok', message: 'ssh reads the shared file through the Include line in ~/.ssh/config.' }
        : { mode, file, state: 'error', message: 'The Include line for the shared file is missing from ~/.ssh/config. Set up sync again to repair it.' };
    }
    if (this.conflict) {
      return { mode, file, state: 'conflict', message: 'This computer and the shared file were both changed. Choose which one to keep.' };
    }
    const last = this.state.get<number>(`sync.last:${shared}`);
    return { mode, file, state: 'ok', message: 'In sync with the shared file.', last };
  }

  // ---- copy mode: keep the two files equal

  private watch(): void {
    const want = this.mode === 'copy' ? this.shared : '';
    if (want === (this.watchedShared ?? '')) {
      return;
    }
    if (this.watchedShared) {
      fs.unwatchFile(this.watchedShared);
    }
    this.watchedShared = want || undefined;
    if (want) {
      // polling: fs.watch is unreliable in cloud-synced folders
      fs.watchFile(want, { interval: 3000 }, () => this.schedule(300));
    }
  }

  private schedule(delay = 700): void {
    if (this.mode !== 'copy' || !this.shared) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.syncNow(false), delay);
  }

  /** Brings the two copies in line. `interactive`: asked for by the user, so report the result. */
  async syncNow(interactive: boolean): Promise<void> {
    if (this.mode !== 'copy' || !this.shared) {
      if (interactive) {
        vscode.window.showInformationMessage(this.status.message);
      }
      return;
    }
    if (this.busy) {
      return;
    }
    this.busy = true;
    const shared = this.shared;
    const before = JSON.stringify(this.status);
    try {
      this.error = undefined;
      const local = this.store.exists ? hashText(fs.readFileSync(this.store.configPath, 'utf8')) : undefined;
      const remote = hashFile(shared);
      const action = decideCopy(local, remote, this.state.get<string>(this.baseKey));
      if (action === 'push') {
        writeContent(shared, fs.readFileSync(this.store.configPath, 'utf8'));
        await this.settled(local);
      } else if (action === 'pull') {
        this.store.replace(fs.readFileSync(shared, 'utf8'));
        await this.settled(remote);
        this.pulled();
      } else if (action === 'noop') {
        if (local !== undefined) {
          await this.settled(local);
        }
      } else {
        this.conflict = true;
        void this.askConflict();
      }
      if (interactive && action !== 'conflict') {
        vscode.window.showInformationMessage(
          action === 'push' ? 'Copied this computer’s config to the shared file.' : action === 'pull' ? 'Updated this computer from the shared file.' : 'Already in sync.',
        );
      }
    } catch (e: any) {
      this.error = `Sync failed: ${e?.message ?? e}`;
      if (interactive) {
        vscode.window.showErrorMessage(`SSH Config Manager: ${this.error}`);
      }
    } finally {
      this.busy = false;
      if (JSON.stringify(this.status) !== before) {
        this.changed.fire();
      }
    }
  }

  private async settled(hash: string | undefined): Promise<void> {
    this.conflict = false;
    await this.state.update(this.baseKey, hash);
    await this.state.update(`sync.last:${this.shared}`, Date.now());
  }

  private pulled(): void {
    const missing = new Set(missingKeys(this.store.doc, os.homedir()).map(m => m.alias));
    const text = 'SSH config updated from your other computer.';
    if (missing.size) {
      void vscode.window
        .showWarningMessage(`${text} ${missing.size} host${missing.size === 1 ? ' uses' : 's use'} an SSH key that is not on this computer.`, 'Check Keys')
        .then(pick => pick && vscode.commands.executeCommand('sshManager.checkKeys'));
    } else {
      void vscode.window.showInformationMessage(text);
    }
  }

  private async askConflict(): Promise<void> {
    if (this.asking) {
      return;
    }
    this.asking = true;
    try {
      const mine = 'Keep This Computer’s';
      const theirs = 'Use the Shared File';
      const compare = 'Compare';
      for (;;) {
        const pick = await vscode.window.showWarningMessage(
          'SSH config sync: this computer and the shared file were both changed. Which one do you want to keep? The other is saved as a backup.',
          mine, theirs, compare,
        );
        if (pick === compare) {
          await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(this.shared), vscode.Uri.file(this.store.configPath), 'Shared file ↔ This computer');
          continue;
        }
        if (pick === mine || pick === theirs) {
          await this.resolve(pick === mine ? 'local' : 'shared');
        }
        break;
      }
    } finally {
      this.asking = false;
    }
  }

  /** Makes both copies equal to one side; the losing side is kept as a backup. */
  private async resolve(keep: 'local' | 'shared'): Promise<void> {
    const shared = this.shared;
    try {
      if (keep === 'local') {
        const theirs = fs.existsSync(shared) ? fs.readFileSync(shared, 'utf8') : '';
        writeBackup(this.store.backupDir, theirs);
        writeContent(shared, fs.readFileSync(this.store.configPath, 'utf8'));
      } else {
        this.store.replace(fs.readFileSync(shared, 'utf8')); // backs up this computer's copy
      }
      await this.settled(hashFile(shared));
      this.error = undefined;
    } catch (e: any) {
      this.error = `Sync failed: ${e?.message ?? e}`;
      vscode.window.showErrorMessage(`SSH Config Manager: ${this.error}`);
    }
    this.changed.fire();
  }

  // ---- setting it up and turning it off

  /** The guided setup: pick a way, pick the file, bring the two in line, explain the keys. */
  async setup(preset?: SyncMode): Promise<boolean> {
    let mode = preset && preset !== 'off' ? preset : undefined;
    if (!mode) {
      const picked = await vscode.window.showQuickPick(
        SYNC_MODES.map(m => ({ label: m.label, description: m.summary, detail: m.detail, id: m.id })),
        { title: 'Sync your SSH config between computers (1/2)', placeHolder: 'How should this computer use the shared file?', matchOnDetail: true },
      );
      if (!picked) {
        return false;
      }
      mode = picked.id;
    }
    if (mode === 'include' && !this.store.isDefaultPath && this.mode !== 'include') {
      vscode.window.showWarningMessage('"Include the shared file" works with the standard ~/.ssh/config. Set "Config file" back to ~/.ssh/config first, or pick another way to sync.');
      return false;
    }

    const shared = await this.pickShared();
    if (!shared) {
      return false;
    }
    const local = this.mode === 'include' ? DEFAULT_CONFIG : this.store.configPath;
    if (samePath(local, shared) && !isLinkTo(local, shared)) {
      vscode.window.showWarningMessage('That is the config file itself. Pick a file in your Dropbox, iCloud Drive or OneDrive folder instead.');
      return false;
    }

    // leave the previous arrangement cleanly before making the new one
    if (this.mode !== 'off' && (this.mode !== mode || !samePath(this.shared || shared, shared))) {
      await this.turnOff(true);
    }

    try {
      this.store.backupNow();
      const which = await this.reconcile(this.store.configPath, shared);
      if (!which) {
        return false;
      }
      if (mode === 'copy') {
        await this.save('copy', shared);
        await this.state.update(`sync.base:${shared}`, hashFile(shared));
        await this.state.update(`sync.last:${shared}`, Date.now());
      } else if (mode === 'link') {
        makeLink(this.store.configPath, shared);
        await this.save('link', shared);
      } else {
        // the hosts now live in the shared file: ~/.ssh/config keeps only the Include line
        // (its old content is in the backup taken above)
        fs.mkdirSync(path.dirname(DEFAULT_CONFIG), { recursive: true, mode: 0o700 });
        fs.writeFileSync(DEFAULT_CONFIG, addInclude('', shared), { mode: 0o600 });
        await this.cfg.update('configFile', collapseHome(shared), vscode.ConfigurationTarget.Global);
        await this.save('include', shared);
      }
      this.error = undefined;
      this.conflict = false;
    } catch (e: any) {
      const hint = mode === 'link' && (e?.code === 'EPERM' || e?.code === 'EACCES')
        ? ' Windows needs Developer Mode or administrator rights for links. "Copy both ways" works without them.'
        : '';
      vscode.window.showErrorMessage(`SSH Config Manager: could not set up sync: ${e?.message ?? e}.${hint}`);
      return false;
    }
    this.store.reload();
    this.watch();
    this.changed.fire();

    const pick = await vscode.window.showInformationMessage(
      'Sync is set up. One thing is NOT synced: your SSH keys.',
      {
        modal: true,
        detail:
          'Only the config file is shared. Private keys stay on each computer for safety, so on every other computer you need to:\n\n' +
          '• copy your keys there yourself (for example into ~/.ssh), at the same path the config uses, or\n' +
          '• make a new key there with "Set Up SSH Key…" on each host.\n\n' +
          'Then run this same sync setup on that computer and pick the same shared file.',
      },
      'Check Keys on This Computer',
    );
    if (pick) {
      await vscode.commands.executeCommand('sshManager.checkKeys');
    }
    return true;
  }

  /** Step 2 of the setup: which file in the synced folder. */
  private async pickShared(): Promise<string | undefined> {
    type Item = vscode.QuickPickItem & { dir?: string; action?: 'file' | 'folder' };
    const items: Item[] = cloudFolders().map(c => ({
      label: `$(cloud) ${c.label}`,
      description: collapseHome(path.join(c.dir, 'SSH', SHARED_NAME)),
      detail: fs.existsSync(path.join(c.dir, 'SSH', SHARED_NAME)) ? 'A shared config is already there (from another computer?)' : 'Creates a new shared file there',
      dir: c.dir,
    }));
    if (items.length) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    }
    items.push(
      { label: '$(file) Choose an existing file…', detail: 'A shared config your other computer already created', action: 'file' },
      { label: '$(folder) Choose a folder…', detail: `Creates a new file named ${SHARED_NAME} in a folder you pick`, action: 'folder' },
    );
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Sync your SSH config between computers (2/2)',
      placeHolder: 'Where is the shared file? Pick a folder that Dropbox, iCloud Drive or OneDrive keeps in sync',
    });
    if (!picked) {
      return undefined;
    }
    if (picked.dir) {
      return path.join(picked.dir, 'SSH', SHARED_NAME);
    }
    const chosen = await vscode.window.showOpenDialog({
      canSelectFiles: picked.action === 'file',
      canSelectFolders: picked.action === 'folder',
      canSelectMany: false,
      defaultUri: vscode.Uri.file(cloudFolders()[0]?.dir ?? os.homedir()),
      openLabel: picked.action === 'file' ? 'Use This File' : 'Use This Folder',
    });
    if (!chosen?.length) {
      return undefined;
    }
    return picked.action === 'file' ? chosen[0].fsPath : path.join(chosen[0].fsPath, SHARED_NAME);
  }

  /**
   * Before linking the two files: make the shared file hold the content the user wants.
   * Returns how it went ('moved' = this computer's config was put into the shared file),
   * or undefined when the user cancelled.
   */
  private async reconcile(local: string, shared: string): Promise<'moved' | 'shared' | 'same' | undefined> {
    const mine = fs.existsSync(local) ? fs.readFileSync(local, 'utf8') : '';
    if (!fs.existsSync(shared)) {
      writeContent(shared, mine);
      return 'moved';
    }
    const theirs = fs.readFileSync(shared, 'utf8');
    if (hashText(mine) === hashText(theirs)) {
      return 'same';
    }
    if (!mine.trim()) {
      this.store.replace(theirs);
      return 'shared';
    }
    const useShared = 'Use the Shared File';
    const useMine = 'Use This Computer’s';
    const pick = await vscode.window.showWarningMessage(
      'The shared file already has a config that is different from this computer’s.',
      { modal: true, detail: 'Which one should both use from now on? The other one is saved as a backup, so nothing is lost.' },
      useShared, useMine,
    );
    if (pick === useShared) {
      this.store.replace(theirs);
      return 'shared';
    }
    if (pick === useMine) {
      writeBackup(this.store.backupDir, theirs);
      writeContent(shared, mine);
      return 'moved';
    }
    return undefined;
  }

  /** Stops syncing and leaves this computer with a normal, complete config of its own. */
  async turnOff(quiet = false): Promise<void> {
    const mode = this.mode;
    const shared = this.shared;
    try {
      if (mode === 'link' && shared) {
        this.store.backupNow();
        unlinkToCopy(this.store.configPath);
      } else if (mode === 'include' && shared) {
        const local = fs.existsSync(DEFAULT_CONFIG) ? fs.readFileSync(DEFAULT_CONFIG, 'utf8') : '';
        const own = removeInclude(local, shared).trim();
        const theirs = fs.existsSync(shared) ? fs.readFileSync(shared, 'utf8') : '';
        writeBackup(backupFolderOf(DEFAULT_CONFIG), local);
        fs.writeFileSync(DEFAULT_CONFIG, theirs + (own ? (theirs.endsWith('\n') ? '\n' : '\n\n') + own + '\n' : ''), { mode: 0o600 });
        await this.cfg.update('configFile', undefined, vscode.ConfigurationTarget.Global);
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`SSH Config Manager: could not turn sync off cleanly: ${e?.message ?? e}`);
    }
    await this.save('off', '');
    this.error = undefined;
    this.conflict = false;
    this.watch();
    this.store.reload();
    this.changed.fire();
    if (!quiet && mode !== 'off') {
      vscode.window.showInformationMessage('Sync is off. This computer keeps its own copy of the config; the shared file was left as it is.');
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    if (this.watchedShared) {
      fs.unwatchFile(this.watchedShared);
    }
    this.subs.forEach(s => s.dispose());
    this.changed.dispose();
  }
}

function backupFolderOf(file: string): string {
  return path.join(path.dirname(file), 'ssh-config-backups');
}
