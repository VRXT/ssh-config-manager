import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ago } from './backups';
import { HEALTH_METHODS, intervalSeconds } from './health';
import { missingKeys } from './keys';
import { SHORTCUTS, keyCaps } from './shortcuts';
import { pickerFormatting, setPickerFormatting, setSettings } from './sshConfig';
import { Store, collapseHome } from './store';
import { SYNC_MODES, SyncMode } from './sync';
import { SyncController } from './syncController';
import { remoteListPreview } from './preview';
import { artUris, page, webviewOptions } from './ui';

/** Settings a page may change in the `#@ssh-manager` line, with the values it may set. */
const FILE_SETTINGS: Record<string, string[]> = {
  sort: ['file', 'name'],
  click: ['none', 'terminal', 'window', 'newWindow', 'edit'],
  favorites: ['on', 'off'],
  autoicon: ['on', 'off'],
  'remote-subfolders': ['dashes', 'arrow', 'off'],
  'remote-favorites': ['on', 'off'],
};

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The settings page and the setup wizard: two webview panels over the same state and actions. */
export class Panels implements vscode.Disposable {
  private settingsPanel: vscode.WebviewPanel | undefined;
  private wizardPanel: vscode.WebviewPanel | undefined;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext, private readonly store: Store, private readonly sync: SyncController) {
    const refresh = () => this.post();
    this.subs.push(
      store.onDidChange(refresh),
      sync.onDidChange(refresh),
      vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('sshManager') && refresh()),
    );
  }

  /** Opens the settings page, optionally at a section (general, status, folders, picker, backups, sync, keys, shortcuts, help). */
  showSettings(section?: string): void {
    if (!this.settingsPanel) {
      this.settingsPanel = this.create('sshManager.settingsPage', 'SSH Manager Settings', ['components.js', 'settings.js']);
      this.settingsPanel.onDidDispose(() => (this.settingsPanel = undefined));
    }
    this.settingsPanel.reveal();
    if (section) {
      void this.settingsPanel.webview.postMessage({ type: 'section', id: section });
    }
  }

  /** Opens the setup wizard. `restart` goes back to its first step. */
  showWizard(restart = false): void {
    if (!this.wizardPanel) {
      this.wizardPanel = this.create('sshManager.wizard', 'SSH Manager Setup', ['components.js', 'wizard.js']);
      this.wizardPanel.onDidDispose(() => (this.wizardPanel = undefined));
    } else if (restart) {
      void this.wizardPanel.webview.postMessage({ type: 'restart' });
    }
    this.wizardPanel.reveal();
  }

  private create(viewType: string, title: string, scripts: string[]): vscode.WebviewPanel {
    const uri = this.context.extensionUri;
    const panel = vscode.window.createWebviewPanel(viewType, title, vscode.ViewColumn.Active, { ...webviewOptions(uri), retainContextWhenHidden: true });
    panel.iconPath = vscode.Uri.joinPath(uri, 'media', 'icon.png');
    panel.webview.html = page(panel.webview, uri, { title, scripts });
    panel.webview.onDidReceiveMessage(msg => void this.handle(panel, msg));
    panel.onDidChangeViewState(() => panel.visible && this.post());
    return panel;
  }

  private post(): void {
    for (const panel of [this.settingsPanel, this.wizardPanel]) {
      if (panel?.visible) {
        void panel.webview.postMessage({ type: 'state', state: this.state(panel.webview) });
      }
    }
  }

  private state(webview: vscode.Webview): object {
    const { store, sync } = this;
    const doc = store.doc;
    const hosts = doc.hosts.filter(h => !h.isPattern);
    const preview = remoteListPreview(doc);
    const missing = new Map<string, { hostId: string; alias: string; keys: string[] }>();
    for (const m of missingKeys(doc, os.homedir())) {
      const entry = missing.get(m.hostId) ?? { hostId: m.hostId, alias: m.alias, keys: [] };
      entry.keys.push(m.key);
      missing.set(m.hostId, entry);
    }
    const status = sync.status;
    const now = new Date();
    return {
      version: String(this.context.extension.packageJSON.version ?? ''),
      art: artUris(webview, this.context.extensionUri),
      config: {
        path: collapseHome(store.configPath),
        exists: store.exists,
        isDefault: store.isDefaultPath,
        hosts: hosts.length,
        folders: doc.groups.length,
        subfolders: doc.groups.reduce((n, g) => n + g.sections.length, 0),
        loose: doc.rootHosts.filter(h => !h.isPattern).length,
      },
      s: {
        sort: doc.settings.sort ?? 'file',
        click: doc.settings.click ?? 'none',
        favorites: doc.settings.favorites ?? 'on',
        autoicon: doc.settings.autoicon ?? 'on',
        // what is in the file now; "undecided" = no choice recorded yet, it comes on with the next save
        picker: doc.settings['remote-picker'] === 'on' || doc.spacers.length > 0 ? 'on' : 'off',
        pickerUndecided: doc.settings['remote-picker'] === undefined && doc.spacers.length === 0 && pickerFormatting(doc) === 'on',
        subfolders: doc.settings['remote-subfolders'] ?? 'dashes',
        remoteFavorites: doc.settings['remote-favorites'] ?? 'off',
      },
      preview: preview.rows,
      previewMore: preview.more,
      backups: {
        dir: collapseHome(store.backupDir),
        keep: vscode.workspace.getConfiguration('sshManager').get<number>('backup.keep') ?? 30,
        items: store.backups().slice(0, 60).map(b => ({
          file: b.file,
          ago: ago(b.date, now),
          when: b.date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
          hosts: b.hosts,
          size: size(b.size),
        })),
      },
      sync: { ...status, lastAgo: status.last ? ago(new Date(status.last), now) : '', modes: SYNC_MODES },
      keys: { withKeys: doc.hosts.filter(h => !h.disabled && h.options.some(o => o.key.toLowerCase() === 'identityfile')).length, missing: [...missing.values()] },
      health: {
        check: vscode.workspace.getConfiguration('sshManager').get<string>('health.check') ?? 'ssh',
        interval: intervalSeconds(vscode.workspace.getConfiguration('sshManager').get('health.interval') ?? 300),
      },
      shortcuts: SHORTCUTS.map(s => ({ label: s.label, caps: keyCaps(s, process.platform), where: s.where, group: s.group })),
    };
  }

  private async handle(panel: vscode.WebviewPanel, msg: any): Promise<void> {
    const { store, sync } = this;
    const cfg = vscode.workspace.getConfiguration('sshManager');
    switch (msg?.type) {
      case 'ready':
        void panel.webview.postMessage({ type: 'state', state: this.state(panel.webview) });
        return;
      case 'set': {
        const key = String(msg.key);
        const value = String(msg.value);
        if (FILE_SETTINGS[key]?.includes(value)) {
          await store.mutate(d => setSettings(d, { [key]: value }));
        }
        return;
      }
      case 'picker':
        await store.mutate(d => setPickerFormatting(d, !!msg.on));
        return;
      case 'keep': {
        const n = Math.floor(Number(msg.value));
        if (n >= 1 && n <= 500) {
          await cfg.update('backup.keep', n, vscode.ConfigurationTarget.Global);
        }
        return;
      }
      case 'health': {
        if (msg.key === 'check' && (HEALTH_METHODS as readonly string[]).includes(String(msg.value))) {
          await cfg.update('health.check', String(msg.value), vscode.ConfigurationTarget.Global);
        } else if (msg.key === 'interval' && [0, 60, 300, 900].includes(Number(msg.value))) {
          await cfg.update('health.interval', Number(msg.value), vscode.ConfigurationTarget.Global);
        }
        return;
      }
      case 'backupNow':
        await vscode.commands.executeCommand('sshManager.backupNow');
        return;
      case 'openBackups':
        await vscode.commands.executeCommand('sshManager.openBackups');
        return;
      case 'restoreBackup':
      case 'compareBackup': {
        // only files that really are backups of this config
        const backup = store.backups().find(b => b.file === msg.file);
        if (backup) {
          await vscode.commands.executeCommand(msg.type === 'restoreBackup' ? 'sshManager.restoreBackup' : 'sshManager.compareBackup', backup.file);
        }
        return;
      }
      case 'syncSetup': {
        const mode = String(msg.mode) as SyncMode;
        await sync.setup(['copy', 'link', 'include'].includes(mode) ? mode : undefined);
        return;
      }
      case 'syncNow':
        await sync.syncNow(true);
        return;
      case 'syncOff':
        await vscode.commands.executeCommand('sshManager.syncOff');
        return;
      case 'checkKeys':
        await vscode.commands.executeCommand('sshManager.checkKeys');
        return;
      case 'setupKey': {
        const host = store.doc.hosts.find(h => h.id === msg.hostId);
        if (host) {
          await vscode.commands.executeCommand('sshManager.setupKey', { type: 'host', host });
        }
        return;
      }
      case 'keybindings':
        await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', `@ext:${this.context.extension.id}`);
        return;
      case 'browseConfig': {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          defaultUri: vscode.Uri.file(path.dirname(store.configPath)),
          openLabel: 'Manage This File',
          title: 'Choose the SSH config file to manage',
        });
        if (picked?.length) {
          await cfg.update('configFile', collapseHome(picked[0].fsPath), vscode.ConfigurationTarget.Global);
        }
        return;
      }
      case 'resetConfig':
        await cfg.update('configFile', undefined, vscode.ConfigurationTarget.Global);
        return;
      case 'command': {
        const id = String(msg.id);
        if (/^sshManager\.[A-Za-z]+$/.test(id)) {
          await vscode.commands.executeCommand(id);
        }
        return;
      }
      case 'finish':
        this.wizardPanel?.dispose();
        await vscode.commands.executeCommand('sshManager.hosts.focus');
        return;
    }
  }

  dispose(): void {
    this.settingsPanel?.dispose();
    this.wizardPanel?.dispose();
    this.subs.forEach(s => s.dispose());
  }
}
