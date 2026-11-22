import * as vscode from 'vscode';
import { ago } from './backups';
import { Host, connectName } from './sshConfig';
import {
  ConnectHow, DENSITIES, START_CLICKS, START_MODES, StartMode, Status, buildStartModel, primaryAction, pushRecent, readRecent, recentCount,
  startClick, startDensity, startMode,
} from './startModel';
import { Store, collapseHome } from './store';
import { page, webviewOptions } from './ui';

export const RECENT_KEY = 'start.recent';
const COLLAPSED_KEY = 'start.collapsed';

export interface StartActions {
  terminal(h: Host): unknown;
  window(h: Host): unknown;
  newWindow(h: Host): unknown;
  edit(h: Host): unknown;
  toggleFavorite(h: Host): unknown;
  /** up / down of a host by its ssh name, undefined when status checks are off */
  status(name: string): Status | undefined;
  recheck(): unknown;
}

/** The home page settings, as stored (per computer) under `sshManager.startPage.*`. */
export function startSettings(): { open: StartMode; click: ReturnType<typeof startClick>; banner: boolean; density: ReturnType<typeof startDensity>; recent: number } {
  const cfg = vscode.workspace.getConfiguration('sshManager');
  return {
    open: startMode(cfg.get('startPage.open')),
    click: startClick(cfg.get('startPage.click')),
    banner: cfg.get<boolean>('startPage.banner') !== false,
    density: startDensity(cfg.get('startPage.density')),
    recent: recentCount(cfg.get('startPage.recent')),
  };
}

/** Changes one home page setting; refuses values the setting does not have. Returns whether it was written. */
export async function setStartSetting(key: string, value: unknown): Promise<boolean> {
  const ok =
    (key === 'open' && (START_MODES as readonly string[]).includes(String(value))) ||
    (key === 'click' && (START_CLICKS as readonly string[]).includes(String(value))) ||
    (key === 'density' && (DENSITIES as readonly string[]).includes(String(value))) ||
    (key === 'banner' && typeof value === 'boolean') ||
    (key === 'recent' && [0, 4, 8, 12].includes(Number(value)));
  if (ok) {
    await vscode.workspace.getConfiguration('sshManager').update(`startPage.${key}`, key === 'recent' ? Number(value) : value, vscode.ConfigurationTarget.Global);
  }
  return ok;
}

/**
 * The home page: every host on one screen, favorites and recent ones first, a search box that
 * has the focus, and one click (or Enter) to connect. Opens by itself when a window starts,
 * depending on the `sshManager.startPage.open` setting.
 */
export class StartPage implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly subs: vscode.Disposable[] = [];
  private readonly visibility = new vscode.EventEmitter<boolean>();
  /** fires when the page is shown or hidden, so status checks can run while it is on screen */
  readonly onDidChangeVisibility = this.visibility.event;

  constructor(private readonly context: vscode.ExtensionContext, private readonly store: Store, private readonly actions: StartActions) {
    this.subs.push(
      store.onDidChange(() => this.post()),
      vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('sshManager') && this.post()),
    );
  }

  get visible(): boolean {
    return !!this.panel?.visible;
  }

  get mode(): StartMode {
    return startSettings().open;
  }

  /** Call when a host's status changed. */
  refresh(): void {
    this.post();
  }

  /** Remembers a connection for the "Recent" row. Called for every connect, from any part of the extension. */
  noteConnected(h: Host): void {
    const name = connectName(h);
    if (name) {
      void this.context.globalState.update(RECENT_KEY, pushRecent(this.recent, name, Date.now())).then(() => this.post());
    }
  }

  async clearRecent(): Promise<void> {
    await this.context.globalState.update(RECENT_KEY, []);
    this.post();
  }

  private get recent() {
    return readRecent(this.context.globalState.get(RECENT_KEY));
  }

  /** `quiet`: opened by the editor starting, not by the user, so it must not steal the keyboard from a file. */
  show(quiet = false): void {
    if (this.panel) {
      this.panel.reveal(undefined, quiet);
      return;
    }
    const uri = this.context.extensionUri;
    // Not kept alive while hidden: a tab in the background costs no memory, and the page comes
    // back in a few milliseconds with its search text (it keeps that in the webview state).
    const panel = vscode.window.createWebviewPanel(
      'sshManager.start', 'SSH Home', { viewColumn: vscode.ViewColumn.Active, preserveFocus: quiet }, webviewOptions(uri),
    );
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(uri, 'media', 'icon.png');
    panel.webview.html = page(panel.webview, uri, { title: 'SSH Home', scripts: ['components.js', 'start.js'], styles: ['start.css'] });
    panel.webview.onDidReceiveMessage(msg => void this.handle(msg));
    panel.onDidChangeViewState(() => this.visibility.fire(panel.visible));
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.visibility.fire(false);
    });
    this.visibility.fire(true);
  }

  private state(webview: vscode.Webview): object {
    const { store } = this;
    const art = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'art', `${name}.jpg`)).toString();
    const o = startSettings();
    const recent = this.recent.slice(0, o.recent);
    const now = new Date();
    const collapsed = this.context.globalState.get<unknown>(COLLAPSED_KEY);
    return {
      model: buildStartModel(store.doc, store.included, recent.map(e => e.name), this.actions.status),
      // "2 hours ago" under a recent host
      when: Object.fromEntries(recent.filter(e => e.at > 0).map(e => [e.name, ago(new Date(e.at), now)])),
      art: { banner: art('start'), empty: art('start-empty') },
      primary: primaryAction(o.click, store.doc.settings.click),
      opts: o,
      collapsed: Array.isArray(collapsed) ? collapsed.filter(x => typeof x === 'string') : [],
      config: collapseHome(store.configPath),
      error: store.problem ? store.problem.why + (store.problem.retrying ? ' Trying again by itself.' : '') : '',
      errorTitle: store.problem?.title ?? '',
      mac: process.platform === 'darwin',
    };
  }

  private post(): void {
    if (this.panel?.visible) {
      void this.panel.webview.postMessage({ type: 'state', state: this.state(this.panel.webview) });
    }
  }

  /** Only names that are hosts of this config right now. */
  private host(name: unknown): Host | undefined {
    return [...this.store.doc.hosts, ...this.store.included.flatMap(d => d.hosts)].find(x => connectName(x) === name);
  }

  private async handle(msg: any): Promise<void> {
    switch (msg?.type) {
      case 'ready':
        this.post();
        return;
      case 'connect': {
        const h = this.host(msg.name);
        const how: ConnectHow = msg.how === 'terminal' || msg.how === 'window' ? msg.how : 'newWindow';
        if (h) {
          await this.actions[how](h);
        }
        return;
      }
      case 'favorite':
      case 'edit': {
        const h = this.host(msg.name);
        if (h && !h.readonly) {
          await (msg.type === 'edit' ? this.actions.edit(h) : this.actions.toggleFavorite(h));
        }
        return;
      }
      case 'collapsed':
        if (Array.isArray(msg.keys)) {
          await this.context.globalState.update(COLLAPSED_KEY, msg.keys.filter((k: unknown) => typeof k === 'string').slice(0, 500));
        }
        return;
      case 'recheck':
        await this.actions.recheck();
        return;
      case 'clearRecent':
        await this.clearRecent();
        return;
      case 'settings':
        await vscode.commands.executeCommand('sshManager.settingsPage', 'home');
        return;
      case 'command': {
        const allowed = ['sshManager.refresh', 'sshManager.showLog', 'sshManager.addHost', 'sshManager.addGroup', 'sshManager.wizard', 'sshManager.openConfig', 'sshManager.hosts.focus'];
        if (allowed.includes(String(msg.id))) {
          await vscode.commands.executeCommand(String(msg.id));
        }
        return;
      }
    }
  }

  dispose(): void {
    this.panel?.dispose();
    this.visibility.dispose();
    this.subs.forEach(s => s.dispose());
  }
}
