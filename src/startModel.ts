/**
 * What the home page shows, worked out from the config. Kept free of the vscode API so it can be
 * tested in plain node.
 */
import { Doc, Host, connectName, hostTags, option, providerOf, skipsSectionLevel } from './sshConfig';

export const START_MODES = ['emptyWindow', 'always', 'never'] as const;
export type StartMode = (typeof START_MODES)[number];

export function startMode(value: unknown): StartMode {
  return (START_MODES as readonly string[]).includes(String(value)) ? (value as StartMode) : 'emptyWindow';
}

/**
 * Whether the home page opens by itself when a window starts.
 * - `emptyWindow`: only in a window with no folder open, no file open and not connected to a
 *   server, i.e. the window you get when you start the editor to go somewhere. A window that was
 *   opened to show a file (double-clicked in the file manager, `code notes.txt`) is left alone
 * - `always`: in every local window
 * - never inside a window that is already connected to a server, and not on the very first run,
 *   when the setup wizard opens instead
 */
export function opensOnStartup(mode: StartMode, w: { folders: number; files: number; remote: boolean; firstRun: boolean }): boolean {
  if (mode === 'never' || w.remote || w.firstRun) {
    return false;
  }
  return mode === 'always' || (w.folders === 0 && w.files === 0);
}

/** What a click (or Enter) on a host does on the home page. `panel` = whatever a click in the Hosts panel does. */
export const START_CLICKS = ['panel', 'terminal', 'window', 'newWindow'] as const;
export type StartClick = (typeof START_CLICKS)[number];
export type ConnectHow = 'terminal' | 'window' | 'newWindow';

export function startClick(value: unknown): StartClick {
  return (START_CLICKS as readonly string[]).includes(String(value)) ? (value as StartClick) : 'panel';
}

/**
 * The way a click on the home page connects. The Hosts panel's click can also be "just select" or
 * "edit", which make no sense on a page whose only job is connecting: those fall back to a new window.
 */
export function primaryAction(click: StartClick, panelClick: string | undefined): ConnectHow {
  const c = click === 'panel' ? panelClick : click;
  return c === 'terminal' ? 'terminal' : c === 'window' ? 'window' : 'newWindow';
}

export const DENSITIES = ['comfortable', 'compact'] as const;
export type Density = (typeof DENSITIES)[number];

export function startDensity(value: unknown): Density {
  return value === 'compact' ? 'compact' : 'comfortable';
}

/** How many recent hosts are remembered at most; the page shows `recentCount` of them. */
export const RECENT_MAX = 12;

export function recentCount(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && value !== null && value !== '' ? Math.max(0, Math.min(RECENT_MAX, n)) : 8;
}

export interface RecentEntry {
  name: string;
  /** when it was connected to, ms since 1970; 0 when not known */
  at: number;
}

/** What is stored, made safe: older versions stored plain names. */
export function readRecent(raw: unknown): RecentEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: RecentEntry[] = [];
  for (const x of raw) {
    const name = typeof x === 'string' ? x : x && typeof x.name === 'string' ? x.name : '';
    if (name && !out.some(e => e.name === name)) {
      out.push({ name, at: x && typeof x.at === 'number' ? x.at : 0 });
    }
  }
  return out.slice(0, RECENT_MAX);
}

/** Most recent first, no duplicates, capped. */
export function pushRecent(recent: readonly RecentEntry[], name: string, at: number): RecentEntry[] {
  return [{ name, at }, ...recent.filter(e => e.name !== name)].slice(0, RECENT_MAX);
}

export type Status = 'up' | 'down' | 'unknown';

export interface StartHost {
  /** the name handed to ssh; also what the page sends back to connect */
  name: string;
  /** false for hosts of an included file: they cannot be starred or edited here */
  editable: boolean;
  alias: string;
  /** user@address */
  detail: string;
  provider: string;
  /** lan | vpn | cloud | '' */
  kind: string;
  color: string;
  tags: string[];
  note: string;
  fav: boolean;
  status: Status;
  /** "Project" or "Project / subfolder" */
  folder: string;
  readonly: boolean;
  /** lower-cased text the search box matches against */
  hay: string;
}

export interface StartFolder {
  title: string;
  color: string;
  hosts: StartHost[];
  subfolders: { title: string; hosts: StartHost[] }[];
  up: number;
  down: number;
  total: number;
}

export interface StartModel {
  favorites: StartHost[];
  recent: StartHost[];
  /** hosts that are in no folder */
  loose: StartHost[];
  folders: StartFolder[];
  included: { title: string; hosts: StartHost[] }[];
  total: number;
  up: number;
  down: number;
}

function detail(h: Host): string {
  const hostName = option(h, 'HostName');
  const user = option(h, 'User');
  const port = option(h, 'Port');
  let s = hostName ? (user ? `${user}@${hostName}` : hostName) : user ? `${user}@` : '';
  if (port && port !== '22') {
    s += `:${port}`;
  }
  return s;
}

export function buildStartModel(
  doc: Doc,
  included: readonly Doc[],
  recent: readonly string[],
  statusOf: (name: string) => Status | undefined,
): StartModel {
  const usable = (h: Host) => !!connectName(h);
  const seen = new Map<Host, StartHost>();
  const row = (h: Host): StartHost => {
    let r = seen.get(h);
    if (!r) {
      const name = connectName(h)!;
      const p = providerOf(h);
      const c = h.container;
      const folder = !c ? '' : c.parent ? (skipsSectionLevel(c.parent) ? c.parent.title : `${c.parent.title} / ${c.title}`) : c.title;
      const tags = hostTags(h);
      r = {
        name,
        editable: !h.readonly,
        alias: h.alias,
        detail: detail(h),
        provider: p?.label ?? '',
        kind: p?.kind ?? '',
        color: h.attrs.color ?? '',
        tags,
        note: h.attrs.note ?? '',
        fav: !!h.attrs.fav && h.attrs.fav !== '0' && !h.readonly,
        status: statusOf(name) ?? 'unknown',
        folder,
        readonly: h.readonly,
        hay: '',
      };
      r.hay = [r.alias, r.detail, r.provider, r.folder, r.note, ...tags].join(' ').toLowerCase();
      seen.set(h, r);
    }
    return r;
  };
  const rows = (hosts: readonly Host[]) => hosts.filter(usable).map(row);

  const folders: StartFolder[] = [];
  for (const g of doc.groups) {
    const flat = skipsSectionLevel(g);
    const hosts = rows(flat ? g.sections[0].hosts : g.hosts);
    const subfolders = flat ? [] : g.sections.map(s => ({ title: s.title, hosts: rows(s.hosts) })).filter(s => s.hosts.length);
    const all = [...hosts, ...subfolders.flatMap(s => s.hosts)];
    if (all.length) {
      folders.push({
        title: g.title,
        color: g.attrs.color ?? '',
        hosts,
        subfolders,
        total: all.length,
        up: all.filter(h => h.status === 'up').length,
        down: all.filter(h => h.status === 'down').length,
      });
    }
  }

  const own = rows(doc.hosts);
  const extra = included.map(d => ({ title: d.file.split(/[\\/]/).slice(-2).join('/'), hosts: rows(d.hosts) })).filter(d => d.hosts.length);
  const everything = [...own, ...extra.flatMap(d => d.hosts)];
  const byName = new Map(everything.map(h => [h.name, h] as const));
  return {
    favorites: doc.settings.favorites === 'off' ? [] : own.filter(h => h.fav),
    recent: recent.map(a => byName.get(a)).filter((h): h is StartHost => !!h),
    loose: rows(doc.rootHosts),
    folders,
    included: extra,
    total: everything.length,
    up: everything.filter(h => h.status === 'up').length,
    down: everything.filter(h => h.status === 'down').length,
  };
}
