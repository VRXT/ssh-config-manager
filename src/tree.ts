import * as path from 'path';
import * as vscode from 'vscode';
import { Container, Doc, Host, connectName, containerPath, findContainer, hostTags, isDisabled, moveGroup, moveHost, moveSection, option, parse, providerOf } from './sshConfig';
import { HostFilter, emptyFilter, hostMatches, isFilterEmpty } from './search';
import { Store } from './store';

export type Node =
  | { type: 'host'; host: Host; fav?: boolean }
  | { type: 'container'; c: Container }
  | { type: 'favorites' }
  | { type: 'include'; doc: Doc };

export const ICONS = [
  'server', 'vm', 'database', 'cloud', 'home', 'device-desktop', 'device-mobile', 'globe', 'terminal',
  'package', 'rocket', 'beaker', 'shield', 'key', 'lock', 'link', 'broadcast', 'plug', 'organization',
  'code', 'tools', 'flame', 'heart', 'star-full', 'circle-filled', 'folder', 'folder-library',
];

export const COLORS: Record<string, string> = {
  red: 'charts.red',
  orange: 'charts.orange',
  yellow: 'charts.yellow',
  green: 'charts.green',
  blue: 'charts.blue',
  purple: 'charts.purple',
};

/** The same six colors as round emoji, for places VS Code cannot color an icon (quick picks). */
export const COLOR_DOTS: Record<string, string> = {
  red: '\u{1F534}',
  orange: '\u{1F7E0}',
  yellow: '\u{1F7E1}',
  green: '\u{1F7E2}',
  blue: '\u{1F535}',
  purple: '\u{1F7E3}',
};

const OFF_COLOR = new vscode.ThemeColor('disabledForeground');
// not the `application/vnd.code.tree.<viewId>` type: VS Code fills that one with its own data
const MIME = 'application/vnd.ssh-config-manager.items';

function themeIcon(icon: string, color?: string): vscode.ThemeIcon {
  const c = color && COLORS[color] ? new vscode.ThemeColor(COLORS[color]) : undefined;
  return new vscode.ThemeIcon(/^[a-z0-9-]+$/.test(icon) ? icon : 'server', c);
}

/** Icon guessed from where the host lives when it has none of its own. */
export function autoIcon(host: Host): string {
  if (host.isPattern) {
    return 'settings';
  }
  const kind = providerOf(host)?.kind;
  return kind === 'lan' ? 'home' : kind === 'vpn' ? 'link' : kind === 'cloud' ? 'cloud' : 'server';
}

export function hostDetail(host: Host): string {
  const hostName = option(host, 'HostName');
  const user = option(host, 'User');
  const port = option(host, 'Port');
  let s = hostName ? (user ? `${user}@${hostName}` : hostName) : user ? `${user}@` : '';
  if (port && port !== '22') {
    s += `:${port}`;
  }
  return s;
}

/** `user@address · Provider` */
export function hostSummary(host: Host): string {
  return [hostDetail(host), providerOf(host)?.label].filter(Boolean).join(' · ');
}

export class HostTree implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node> {
  readonly dragMimeTypes = [MIME];
  readonly dropMimeTypes = [MIME];

  private readonly changed = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private filter: HostFilter = emptyFilter();
  private readonly filterChanged = new vscode.EventEmitter<HostFilter>();
  /** fires whenever the search text or a filter chip changes, from any place */
  readonly onDidChangeFilter = this.filterChanged.event;

  constructor(private readonly store: Store) {
    store.onDidChange(() => this.changed.fire());
  }

  setFilter(patch: Partial<HostFilter>): void {
    this.filter = { ...this.filter, ...patch };
    vscode.commands.executeCommand('setContext', 'sshManager.filtered', this.filtered);
    this.changed.fire();
    this.filterChanged.fire(this.filter);
  }

  get currentFilter(): HostFilter {
    return this.filter;
  }

  get filtered(): boolean {
    return !isFilterEmpty(this.filter);
  }

  /**
   * Folders get other ids while a search is on: VS Code then shows them expanded (so every match is
   * visible) instead of reusing the collapsed state the user left them in, which comes back afterwards.
   */
  private get idSuffix(): string {
    return this.filtered ? '|search' : '';
  }

  // ---- data

  private matches = (h: Host): boolean => hostMatches(h, this.filter);

  private hostNodes(hosts: Host[], fav = false): Node[] {
    let list = hosts.filter(this.matches);
    if (this.store.doc.settings.sort === 'name') {
      list = list.slice().sort((a, b) => a.alias.localeCompare(b.alias, undefined, { sensitivity: 'base', numeric: true }));
    }
    return list.map(host => ({ type: 'host', host, fav }));
  }

  private visible(c: Container): boolean {
    if (!this.filtered) {
      return true;
    }
    return c.hosts.some(this.matches) || c.sections.some(s => s.hosts.some(this.matches));
  }

  getChildren(node?: Node): Node[] {
    const { doc, included } = this.store;
    if (!node) {
      const out: Node[] = [];
      if (doc.settings.favorites !== 'off' && doc.hosts.some(h => isFav(h) && this.matches(h))) {
        out.push({ type: 'favorites' });
      }
      out.push(...this.hostNodes(doc.rootHosts));
      out.push(...doc.groups.filter(g => this.visible(g)).map(c => ({ type: 'container', c }) as Node));
      out.push(...included.filter(d => d.hosts.some(this.matches)).map(d => ({ type: 'include', doc: d }) as Node));
      return out;
    }
    switch (node.type) {
      case 'favorites':
        return this.hostNodes(doc.hosts.filter(isFav), true);
      case 'include':
        return this.hostNodes(node.doc.hosts);
      case 'container':
        // a group whose hosts all sit under one sub-header: skip the extra level
        if (node.c.kind === 'group' && !node.c.hosts.length && node.c.sections.length === 1) {
          return this.hostNodes(node.c.sections[0].hosts);
        }
        return [
          ...this.hostNodes(node.c.hosts),
          ...node.c.sections.filter(s => this.visible(s)).map(c => ({ type: 'container', c }) as Node),
        ];
      default:
        return [];
    }
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const settings = this.store.doc.settings;
    const expanded = this.filtered ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;

    if (node.type === 'favorites') {
      const item = new vscode.TreeItem('Favorites', vscode.TreeItemCollapsibleState.Expanded);
      item.id = 'favorites';
      item.iconPath = new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'));
      item.contextValue = 'favorites';
      return item;
    }

    if (node.type === 'include') {
      const item = new vscode.TreeItem(path.basename(path.dirname(node.doc.file)) + '/' + path.basename(node.doc.file), expanded);
      item.id = 'inc|' + node.doc.file + this.idSuffix;
      item.description = `included · ${node.doc.hosts.length}`;
      item.tooltip = `${node.doc.file}\nPulled in by an Include line. Read-only here.`;
      item.iconPath = new vscode.ThemeIcon('references');
      item.contextValue = 'include';
      return item;
    }

    if (node.type === 'container') {
      const c = node.c;
      const count = c.kind === 'group' ? c.total : c.hosts.length;
      const item = new vscode.TreeItem(c.title, expanded);
      item.id = `c|${c.id}|${c.title}${this.idSuffix}`;
      const offGroup = isDisabled(c);
      item.description = offGroup ? `${count} · disabled` : String(count);
      const groupIcon = c.attrs.icon || (c.kind === 'group' ? 'folder-library' : 'folder');
      item.iconPath = offGroup ? new vscode.ThemeIcon(/^[a-z0-9-]+$/.test(groupIcon) ? groupIcon : 'folder', OFF_COLOR) : themeIcon(groupIcon, c.attrs.color);
      item.contextValue = c.kind;
      return item;
    }

    const h = node.host;
    const item = new vscode.TreeItem(h.alias, vscode.TreeItemCollapsibleState.None);
    item.id = `${node.fav ? 'fav' : 'h'}|${h.file}|${h.id}`;
    const tags = hostTags(h).map(t => '#' + t).join(' ');
    const fav = isFav(h) && !node.fav ? '★ ' : '';
    item.description = [fav + hostSummary(h), tags].filter(Boolean).join('  ');
    const icon = h.attrs.icon || (settings.autoicon === 'off' ? 'server' : autoIcon(h));
    item.iconPath = themeIcon(icon, h.attrs.color);
    if (h.disabled) {
      item.description = ['disabled', item.description].filter(Boolean).join('  ');
      item.iconPath = new vscode.ThemeIcon('circle-slash', OFF_COLOR);
    }
    item.contextValue = h.isPattern ? 'pattern' : h.readonly ? 'hostReadonly' : 'host';
    item.tooltip = tooltip(h);
    const click = settings.click;
    if (click && click !== 'none' && connectName(h)) {
      item.command = { command: 'sshManager.connect', title: 'Connect', arguments: [node] };
    }
    return item;
  }

  // ---- drag & drop: drop on a group = move to its end, drop on a host = place before it

  handleDrag(source: readonly Node[], data: vscode.DataTransfer): void {
    const payload: DragPayload = {
      hosts: source.filter(n => n.type === 'host' && !n.host.readonly).map(n => (n as { host: Host }).host.id),
      container: source.find(n => n.type === 'container')?.c.id as string | undefined,
    };
    if (payload.hosts.length || payload.container) {
      data.set(MIME, new vscode.DataTransferItem(JSON.stringify(payload)));
    }
  }

  async handleDrop(target: Node | undefined, data: vscode.DataTransfer): Promise<void> {
    let payload: DragPayload;
    try {
      payload = JSON.parse((await data.get(MIME)?.asString()) ?? '');
    } catch {
      return;
    }
    if (target?.type === 'favorites' || target?.type === 'include') {
      return;
    }
    if (target?.type === 'host' && (target.host.readonly || target.fav)) {
      return;
    }
    const ids = Array.isArray(payload.hosts) ? payload.hosts : [];

    await this.store.mutate(doc => {
      const same = doc.lines.join(doc.eol) + doc.eol;

      // a project or sub-folder was dragged
      if (!ids.length && payload.container) {
        const c = findContainer(doc, payload.container);
        if (!c || (target?.type === 'container' && target.c.id === c.id)) {
          return same;
        }
        if (c.kind === 'group') {
          // onto a project (or anything inside one): place before that project; onto empty space: last
          const over = target?.type === 'container' ? target.c : target?.type === 'host' ? target.host.container : undefined;
          const group = over?.parent ?? over;
          return group?.id === c.id ? same : moveGroup(doc, c.id, group?.id);
        }
        if (target?.type === 'container') {
          // sub-folder onto a sub-folder: before it; onto a project: last in that project
          return target.c.kind === 'section'
            ? moveSection(doc, c.id, target.c.parent!.id, target.c.id)
            : moveSection(doc, c.id, target.c.id);
        }
        return same;
      }

      // hosts were dragged: onto a folder = to its end, onto a host = right before it
      let text = same;
      let d = doc;
      for (const id of ids) {
        if (target?.type === 'host') {
          if (id === target.host.id) {
            continue;
          }
          text = moveHost(d, id, '', target.host.id);
        } else {
          text = moveHost(d, id, target?.type === 'container' ? target.c.id : '');
        }
        d = parse(text, doc.file);
      }
      return text;
    });
  }
}

interface DragPayload {
  hosts: string[];
  container?: string;
}

export function isFav(h: Host): boolean {
  return !!h.attrs.fav && h.attrs.fav !== '0' && !h.readonly && !h.disabled;
}

function tooltip(h: Host): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${esc(h.alias)}**`);
  const detail = hostDetail(h);
  if (detail) {
    md.appendMarkdown(` — \`${detail}\``);
  }
  md.appendMarkdown('\n\n');
  if (h.attrs.note) {
    md.appendMarkdown(`${esc(h.attrs.note)}\n\n`);
  }
  const rows: [string, string][] = [];
  const group = containerPath(h.container);
  if (group) {
    rows.push(['Group', group]);
  }
  const tags = hostTags(h);
  if (tags.length) {
    rows.push(['Tags', tags.join(', ')]);
  }
  const provider = providerOf(h);
  if (provider) {
    rows.push(['Provider', provider.auto ? `${provider.label} (detected)` : provider.label]);
  }
  if (h.attrs.folder) {
    rows.push(['Folder', h.attrs.folder]);
  }
  for (const o of h.options) {
    if (!['hostname', 'user'].includes(o.key.toLowerCase())) {
      rows.push([o.key, o.value]);
    }
  }
  if (rows.length) {
    md.appendMarkdown('| | |\n|---|---|\n' + rows.map(([k, v]) => `| ${esc(k)} | ${esc(v)} |`).join('\n'));
  }
  if (h.readonly) {
    md.appendMarkdown(`\n\n_Read-only: defined in ${esc(h.file)}_`);
  }
  return md;
}

function esc(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}
