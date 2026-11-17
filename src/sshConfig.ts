/**
 * ssh_config parser + line-level editor.
 *
 * Design rules:
 *  - The file is the single source of truth. Everything the GUI needs beyond what
 *    OpenSSH understands is stored as `#@...` comment lines, which ssh ignores:
 *        #@ssh-manager sort=name click=terminal        (settings, anywhere in the file)
 *        #@group "My Project" icon=cloud color=blue     (starts a group)
 *        #@section Hetzner                              (starts a sub-group)
 *        #@host icon=database color=green tags=prod,db fav=1 note="Main DB"
 *        Host my-db                                     (the #@host line sits directly above)
 *  - Hand-written layouts are understood too, read-only as far as their text goes:
 *        # =====================        `Host -----NAME-----`        # --- NAME ---
 *        # PROJECT 1 - NAME             (fake separator host)        (sub-group)
 *        # =====================
 *  - Edits only touch the lines of the thing being edited; every other line is
 *    kept byte-for-byte.
 */

export type Attrs = Record<string, string>;

export type MarkerKind = 'explicit' | 'separator' | 'banner' | 'subheader';

export interface Marker {
  kind: MarkerKind;
  start: number; // first line
  end: number; // exclusive
  /** the line is commented out with `#@off` */
  off?: boolean;
}

export interface Container {
  id: string;
  kind: 'group' | 'section';
  title: string;
  prio: number;
  attrs: Attrs;
  markers: Marker[];
  parent?: Container;
  hosts: Host[];
  sections: Container[];
  /** hosts directly inside + hosts inside sections */
  total: number;
  start: number;
  headerEnd: number;
}

export interface Option {
  key: string;
  value: string;
  line: number;
}

export interface Host {
  id: string;
  alias: string;
  patterns: string[];
  /** first line of the block (the #@host line when present, else the Host line) */
  start: number;
  metaLine?: number;
  hostLine: number;
  /** exclusive */
  end: number;
  options: Option[];
  attrs: Attrs;
  container?: Container;
  file: string;
  readonly: boolean;
  /** every line of the block is commented out with `#@off`: ssh does not see it */
  disabled: boolean;
  /** true for `Host *`, `Host *.example.com`, negations… — not something you can connect to */
  isPattern: boolean;
}

export interface Doc {
  file: string;
  lines: string[];
  eol: string;
  settings: Attrs;
  settingsLine?: number;
  groups: Container[];
  rootHosts: Host[];
  hosts: Host[];
  includes: string[];
  /** `Host <invisible name>` lines: blank rows faked for the Remote-SSH host picker */
  spacers: Marker[];
  /** generated `#@favorites-begin … #@favorites-end` block for the Remote-SSH picker */
  mirror?: Marker;
}

export interface HostForm {
  alias: string;
  hostName: string;
  user: string;
  port: string;
  identityFiles: string[];
  identitiesOnly: string;
  proxyJump: string;
  forwardAgent: string;
  /** every other line of the block, raw, one per line */
  extra: string;
  icon: string;
  color: string;
  tags: string;
  note: string;
  fav: boolean;
  /** provider id or free text, '' = detect automatically */
  provider: string;
  /** folder on the server opened on connect ('' = none) */
  folder: string;
  /** container id, '' = ungrouped */
  container: string;
}

// ---------------------------------------------------------------- tokens

// ssh splits on space and tab only; a non-breaking space is part of the word
const TOKEN = /(?:[^ \t"]+|"(?:[^"\\]|\\.)*")+/g;
const DIRECTIVE = /^#@(ssh-manager|group|section|host)\b\s*(.*)$/;
const RULE = /^#\s*[=\-*#~_]{8,}\s*$/;
const SUBHEADER = /^#\s*-{2,}\s*(\S.*?)\s*-{2,}\s*$/;
const SEPARATOR = /^([-=_*~#+.]{2,}\s*)(.*?)(\s*[-=_*~#+.]{2,})$/;
const HAS_WORD = /[\p{L}\p{N}]/u;
/** Characters that render as nothing but are not whitespace to ssh: a Host named only with these is a blank row. */
const BLANK_NAME = /^[\u2800\u3164\u00a0\u200b-\u200d\ufeff]+$/;
const BLANK_START = /^[\u2800\u3164\u00a0\u200b-\u200d\ufeff]/;
export const SPACER_CHAR = '\u2800';

export function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return s;
}

function quoteIf(s: string, re: RegExp): string {
  return s === '' || re.test(s) ? '"' + s.replace(/(["\\])/g, '\\$1') + '"' : s;
}

const quoteValue = (s: string) => quoteIf(s, /[\s"]/);
const quoteName = (s: string) => quoteIf(s, /[\s"=]/);

function tokens(s: string): string[] {
  return s.match(TOKEN) ?? [];
}

function parseAttrs(toks: string[]): Attrs {
  const out: Attrs = {};
  for (const t of toks) {
    const i = t.indexOf('=');
    if (i <= 0) {
      out[unquote(t)] = '1';
    } else {
      out[t.slice(0, i)] = unquote(t.slice(i + 1));
    }
  }
  return out;
}

export function formatAttrs(attrs: Attrs): string {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${quoteValue(v)}`)
    .join(' ');
}

function directiveLine(kind: string, name: string | undefined, attrs: Attrs, indent = ''): string {
  const parts = ['#@' + kind];
  if (name !== undefined) {
    parts.push(quoteName(name));
  }
  const a = formatAttrs(attrs);
  if (a) {
    parts.push(a);
  }
  return indent + parts.join(' ');
}

function splitOption(trimmed: string): { key: string; value: string } {
  const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(trimmed);
  return m ? { key: m[1], value: m[2].trim() } : { key: trimmed, value: '' };
}

const indentOf = (line: string) => /^\s*/.exec(line)![0];

/** Disabled lines are the original line behind this prefix, so enabling restores them exactly. */
const OFF = '#@off ';
const isOff = (line: string) => /^#@off(\s|$)/.test(line.trimStart());
/** The line as it reads when enabled. */
const bare = (line: string) => (isOff(line) ? line.trimStart().slice(5).replace(/^ /, '') : line);
const keepOff = (original: string, next: string) => (isOff(original) ? OFF + next : next);
const isBlank = (line: string | undefined) => line !== undefined && line.trim() === '';

// ---------------------------------------------------------------- parse

export function parse(text: string, file = '', readonly = false): Doc {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const doc: Doc = { file, lines, eol, settings: {}, groups: [], rootHosts: [], hosts: [], includes: [], spacers: [] };
  const seen = new Map<string, number>();

  let group: Container | undefined;
  let section: Container | undefined;
  let pendingMeta: { line: number; attrs: Attrs } | undefined;
  /** the Host block (real or separator) currently collecting option lines */
  let cur: { end: () => number; setEnd: (n: number) => void; host?: Host } | undefined;

  const canMerge = (c: Container | undefined, m: Marker): c is Container => {
    if (!c || c.total > 0 || c.hosts.length > 0 || c.markers.some(x => x.kind === m.kind)) {
      return false;
    }
    // A `Host ---NAME---` separator completes the banner written above it; a banner always
    // starts a new group. A #@ line only adopts the marker on the very next line.
    const completesBanner = m.kind === 'separator' && c.markers.some(x => x.kind !== 'explicit');
    const adjacent = c.markers.some(x => x.kind === 'explicit' && x.end === m.start);
    return completesBanner || adjacent;
  };

  const open = (kind: 'group' | 'section', title: string, prio: number, marker: Marker, attrs: Attrs = {}): Container => {
    const current = kind === 'group' ? group : section;
    if (marker.kind !== 'explicit' && canMerge(current, marker)) {
      current.markers.push(marker);
      current.headerEnd = marker.end;
      if (prio > current.prio) {
        current.title = title;
        current.prio = prio;
      }
      return current;
    }
    const c: Container = {
      id: '', kind, title, prio, attrs, markers: [marker], hosts: [], sections: [], total: 0,
      start: marker.start, headerEnd: marker.end,
    };
    if (kind === 'group') {
      c.id = 'g' + doc.groups.length;
      doc.groups.push(c);
      group = c;
      section = undefined;
    } else {
      c.parent = group!;
      c.id = `${group!.id}.s${group!.sections.length}`;
      group!.sections.push(c);
      section = c;
    }
    return c;
  };

  for (let i = 0; i < lines.length; i++) {
    let t = lines[i].trim();

    if (t.startsWith('#@favorites-begin')) {
      const start = i;
      while (i < lines.length - 1 && !lines[i].trim().startsWith('#@favorites-end')) {
        i++;
      }
      doc.mirror = { kind: 'explicit', start, end: i + 1 };
      cur = undefined;
      pendingMeta = undefined;
      continue;
    }

    const off = isOff(t);
    if (off) {
      t = t.slice(5).trim();
    }

    if (t === '') {
      if (!off) {
        pendingMeta = undefined;
      }
      continue;
    }

    if (t.startsWith('#')) {
      const d = DIRECTIVE.exec(t);
      if (d) {
        const toks = tokens(d[2]);
        if (d[1] === 'ssh-manager') {
          doc.settings = { ...doc.settings, ...parseAttrs(toks) };
          doc.settingsLine ??= i;
        } else if (d[1] === 'host') {
          pendingMeta = { line: i, attrs: parseAttrs(toks) };
          continue;
        } else {
          const name = toks.length ? unquote(toks[0]) : 'Untitled';
          const kind = d[1] === 'section' && group ? 'section' : 'group';
          open(kind, name, 3, { kind: 'explicit', start: i, end: i + 1 }, parseAttrs(toks.slice(1)));
          cur = undefined;
        }
        pendingMeta = undefined;
        continue;
      }

      // # ======  /  # TITLE  /  # ======
      if (RULE.test(t) && i + 2 < lines.length) {
        const mid = lines[i + 1].trim();
        if (mid.startsWith('#') && !RULE.test(mid) && !DIRECTIVE.test(mid) && HAS_WORD.test(mid) && RULE.test(lines[i + 2].trim())) {
          open('group', mid.replace(/^#+\s*/, '').trim(), 1, { kind: 'banner', start: i, end: i + 3 });
          cur = undefined;
          pendingMeta = undefined;
          i += 2;
          continue;
        }
      }

      const sub = RULE.test(t) ? null : SUBHEADER.exec(t);
      if (sub && HAS_WORD.test(sub[1])) {
        open(group ? 'section' : 'group', sub[1], 1, { kind: 'subheader', start: i, end: i + 1 });
        cur = undefined;
        pendingMeta = undefined;
        continue;
      }

      // plain comment: stays glued to the block when it directly follows its options
      if (cur && cur.end() === i) {
        cur.setEnd(i + 1);
      }
      continue;
    }

    const { key, value } = splitOption(t);
    const lower = key.toLowerCase();

    if (lower === 'host') {
      const meta = pendingMeta && pendingMeta.line === i - 1 ? pendingMeta : undefined;
      pendingMeta = undefined;
      const patterns = tokens(value).map(unquote);
      // a name that starts with an invisible character is a decoration row for the Remote-SSH
      // picker (blank spacer, or an indented sub-folder label), never a real host
      if (patterns.length === 1 && (BLANK_NAME.test(patterns[0]) || BLANK_START.test(patterns[0]))) {
        const spacer: Marker = { kind: 'separator', start: i, end: i + 1, off };
        doc.spacers.push(spacer);
        cur = { end: () => spacer.end, setEnd: n => (spacer.end = n) };
        continue;
      }
      const sep = patterns.length === 1 ? SEPARATOR.exec(patterns[0]) : null;

      if (sep && HAS_WORD.test(sep[2])) {
        const marker: Marker = { kind: 'separator', start: i, end: i + 1, off };
        const g = open('group', sep[2], 2, marker);
        cur = {
          end: () => marker.end,
          setEnd: n => {
            marker.end = n;
            g.headerEnd = Math.max(g.headerEnd, n);
          },
        };
        continue;
      }

      const alias = patterns.join(' ');
      const n = seen.get(alias) ?? 0;
      seen.set(alias, n + 1);
      const host: Host = {
        id: `${alias}#${n}`,
        alias,
        patterns,
        start: meta ? meta.line : i,
        metaLine: meta?.line,
        hostLine: i,
        end: i + 1,
        options: [],
        attrs: meta?.attrs ?? {},
        container: section ?? group,
        file,
        readonly,
        disabled: off,
        isPattern: patterns.every(p => /[*?!]/.test(p)),
      };
      (host.container?.hosts ?? doc.rootHosts).push(host);
      if (group) {
        group.total++;
      }
      doc.hosts.push(host);
      cur = { end: () => host.end, setEnd: n => (host.end = n), host };
      continue;
    }

    pendingMeta = undefined;

    if (lower === 'match') {
      cur = undefined;
      continue;
    }

    if (cur) {
      cur.host?.options.push({ key, value: unquote(value), line: i });
      cur.setEnd(i + 1);
    } else if (lower === 'include') {
      doc.includes.push(...tokens(value).map(unquote));
    }
  }

  return doc;
}

// ---------------------------------------------------------------- lookups

export function allContainers(doc: Doc): Container[] {
  return doc.groups.flatMap(g => [g, ...g.sections]);
}

export function findContainer(doc: Doc, id: string): Container | undefined {
  return id ? allContainers(doc).find(c => c.id === id) : undefined;
}

export function findHost(doc: Doc, id: string): Host | undefined {
  return doc.hosts.find(h => h.id === id);
}

/**
 * Whether the tree and the pickers show a group's hosts directly instead of its only sub-folder.
 * Only for a hand-written `# --- NAME ---` header that holds every host of its group (one level
 * less to click through). A sub-folder made with `#@section` (Add Sub-group) always shows, even
 * while it is empty, so it never seems to vanish right after it is created.
 */
export function skipsSectionLevel(g: Container): boolean {
  if (g.kind !== 'group' || g.hosts.length || g.sections.length !== 1) {
    return false;
  }
  const s = g.sections[0];
  return s.hosts.length > 0 && !s.markers.some(m => m.kind === 'explicit');
}

export function containerPath(c: Container | undefined): string {
  return !c ? '' : c.parent ? `${c.parent.title} / ${c.title}` : c.title;
}

export function option(host: Host, key: string): string {
  const k = key.toLowerCase();
  return host.options.find(o => o.key.toLowerCase() === k)?.value ?? '';
}

export function optionAll(host: Host, key: string): string[] {
  const k = key.toLowerCase();
  return host.options.filter(o => o.key.toLowerCase() === k).map(o => o.value);
}

export function hostTags(host: Host): string[] {
  return (host.attrs.tags ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

export interface Provider {
  id: string;
  label: string;
  /** 'lan' | 'vpn' | 'cloud' */
  kind: string;
  match?: RegExp;
}

/** Where a machine lives: your own network, a VPN, or a hosting provider. */
export const PROVIDERS: Provider[] = [
  { id: 'lan', label: 'LAN', kind: 'lan', match: /\blan\b|local[ _-]?network|\bhome\b|on[ -]?prem/i },
  { id: 'tailscale', label: 'Tailscale', kind: 'vpn', match: /tail[ -]?scale|tailnet/i },
  { id: 'hetzner', label: 'Hetzner', kind: 'cloud', match: /hetzner/i },
  { id: 'aws', label: 'AWS', kind: 'cloud', match: /\baws\b|amazon|\bec2\b|lightsail/i },
  { id: 'gcp', label: 'Google Cloud', kind: 'cloud', match: /\bgcp\b|google[ -]?cloud|\bgce\b/i },
  { id: 'azure', label: 'Azure', kind: 'cloud', match: /azure/i },
  { id: 'digitalocean', label: 'DigitalOcean', kind: 'cloud', match: /digital[ -]?ocean|\bdroplet/i },
  { id: 'ovh', label: 'OVH', kind: 'cloud', match: /\bovh/i },
  { id: 'contabo', label: 'Contabo', kind: 'cloud', match: /contabo/i },
  { id: 'vultr', label: 'Vultr', kind: 'cloud', match: /vultr/i },
  { id: 'linode', label: 'Linode', kind: 'cloud', match: /linode|akamai/i },
  { id: 'oracle', label: 'Oracle Cloud', kind: 'cloud', match: /oracle|\boci\b/i },
  { id: 'scaleway', label: 'Scaleway', kind: 'cloud', match: /scaleway/i },
  { id: 'hostinger', label: 'Hostinger', kind: 'cloud', match: /hostinger/i },
  { id: 'alibaba', label: 'Alibaba Cloud', kind: 'cloud', match: /alibaba|aliyun/i },
  { id: 'stc', label: 'STC Cloud', kind: 'cloud', match: /\bstc\b/i },
];

/**
 * A host's provider: what `provider=` in its #@host line says, otherwise worked out from the
 * address (private range = LAN, 100.64/10 = Tailscale), then from the name of the sub-folder or
 * folder it is in ("HETZNER HOSTS"), then from a LOCAL- name prefix.
 */
export function providerOf(host: Host): (Provider & { auto: boolean }) | undefined {
  const set = host.attrs.provider;
  if (set) {
    const known = PROVIDERS.find(p => p.id === set.toLowerCase() || p.label.toLowerCase() === set.toLowerCase());
    return known ? { ...known, auto: false } : { id: set, label: set, kind: 'cloud', auto: false };
  }
  if (host.isPattern) {
    return undefined;
  }
  const byId = (id: string) => ({ ...PROVIDERS.find(p => p.id === id)!, auto: true });
  const ip = /^(\d+)\.(\d+)\.\d+\.\d+/.exec(option(host, 'HostName') || host.alias);
  if (ip) {
    const a = +ip[1];
    const b = +ip[2];
    if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) {
      return byId('lan');
    }
    if (a === 100 && b >= 64 && b <= 127) {
      return byId('tailscale');
    }
  }
  for (const title of [host.container?.title, host.container?.parent?.title]) {
    const hit = title && PROVIDERS.find(p => p.match!.test(title));
    if (hit) {
      return { ...hit, auto: true };
    }
  }
  return /^local[-_]/i.test(host.alias) ? byId('lan') : undefined;
}

/** A group is off when its separator host is, or when every host in it is. */
export function isDisabled(c: Container): boolean {
  const hosts = [...c.hosts, ...c.sections.flatMap(s => s.hosts)];
  return c.markers.some(m => m.off) || (hosts.length > 0 && hosts.every(h => h.disabled));
}

/** The name to hand to `ssh`: first pattern that is a plain alias. */
export function connectName(host: Host): string | undefined {
  if (host.disabled) {
    return undefined;
  }
  return host.patterns.find(p => !/[*?!]/.test(p));
}

// ---------------------------------------------------------------- line helpers

function finish(doc: Doc, L: string[]): string {
  return L.join(doc.eol) + doc.eol;
}

function eofIndex(L: string[]): number {
  let at = L.length;
  while (at > 0 && isBlank(L[at - 1])) {
    at--;
  }
  return at;
}

function insertBlock(L: string[], at: number, block: string[]): void {
  const out = block.slice();
  if (at > 0 && !isBlank(L[at - 1])) {
    out.unshift('');
  }
  if (at < L.length && !isBlank(L[at])) {
    out.push('');
  }
  L.splice(at, 0, ...out);
}

/** Removes [s, e) and collapses a doubled blank line left behind. Returns lines removed. */
function removeRange(L: string[], s: number, e: number): number {
  L.splice(s, e - s);
  let removed = e - s;
  if (s < L.length && isBlank(L[s]) && (s === 0 || isBlank(L[s - 1]))) {
    L.splice(s, 1);
    removed++;
  } else if (s === L.length && s > 0 && isBlank(L[s - 1])) {
    L.pop(); // the block was last in the file: drop the blank line that separated it
    removed++;
  }
  return removed;
}

function insertPoint(doc: Doc, containerId: string): number {
  const c = findContainer(doc, containerId);
  if (!c) {
    if (doc.rootHosts.length) {
      return Math.max(...doc.rootHosts.map(h => h.end));
    }
    return doc.groups.length ? doc.groups[0].start : eofIndex(doc.lines);
  }
  return c.hosts.length ? Math.max(...c.hosts.map(h => h.end)) : c.headerEnd;
}

// ---------------------------------------------------------------- host form

const SINGLE = ['hostname', 'user', 'port', 'identitiesonly', 'proxyjump', 'forwardagent'];

export function emptyForm(container = ''): HostForm {
  return {
    alias: '', hostName: '', user: '', port: '', identityFiles: [], identitiesOnly: '', proxyJump: '',
    forwardAgent: '', extra: '', icon: '', color: '', tags: '', note: '', fav: false, provider: '', folder: '', container,
  };
}

export function hostToForm(doc: Doc, host: Host): HostForm {
  const known = new Set<number>();
  const first: Record<string, string> = {};
  const identityFiles: string[] = [];
  for (const o of host.options) {
    const k = o.key.toLowerCase();
    if (k === 'identityfile') {
      identityFiles.push(o.value);
      known.add(o.line);
    } else if (SINGLE.includes(k) && !(k in first)) {
      first[k] = o.value;
      known.add(o.line);
    }
  }
  const extra: string[] = [];
  for (let i = host.hostLine + 1; i < host.end; i++) {
    const t = bare(doc.lines[i]).trim();
    if (t && !known.has(i)) {
      extra.push(t);
    }
  }
  return {
    alias: host.alias,
    hostName: first.hostname ?? '',
    user: first.user ?? '',
    port: first.port ?? '',
    identityFiles,
    identitiesOnly: (first.identitiesonly ?? '').toLowerCase(),
    proxyJump: first.proxyjump ?? '',
    forwardAgent: (first.forwardagent ?? '').toLowerCase(),
    extra: extra.join('\n'),
    icon: host.attrs.icon ?? '',
    color: host.attrs.color ?? '',
    tags: host.attrs.tags ?? '',
    note: host.attrs.note ?? '',
    fav: !!host.attrs.fav && host.attrs.fav !== '0',
    provider: host.attrs.provider ?? '',
    folder: host.attrs.folder ?? '',
    container: host.container?.id ?? '',
  };
}

function setAttr(attrs: Attrs, key: string, value: string | undefined): void {
  if (value === undefined || value === '') {
    delete attrs[key];
  } else {
    attrs[key] = value;
  }
}

function buildBlock(form: HostForm, baseAttrs: Attrs, hostIndent: string, optIndent: string): string[] {
  const attrs = { ...baseAttrs };
  setAttr(attrs, 'icon', form.icon.trim());
  setAttr(attrs, 'color', form.color.trim());
  setAttr(attrs, 'tags', form.tags.split(',').map(s => s.trim().replace(/\s+/g, '-')).filter(Boolean).join(','));
  setAttr(attrs, 'note', form.note.replace(/\s*[\r\n]+\s*/g, ' ').trim());
  setAttr(attrs, 'fav', form.fav ? '1' : '');
  setAttr(attrs, 'provider', (form.provider ?? '').trim());
  setAttr(attrs, 'folder', (form.folder ?? '').trim());

  const out: string[] = [];
  if (Object.keys(attrs).length) {
    out.push(directiveLine('host', undefined, attrs, hostIndent));
  }
  out.push(`${hostIndent}Host ${form.alias.trim().replace(/\s+/g, ' ')}`);
  const opt = (key: string, value: string) => {
    const v = value.trim();
    if (v) {
      out.push(`${optIndent}${key} ${quoteValue(v)}`);
    }
  };
  opt('HostName', form.hostName);
  opt('User', form.user);
  opt('Port', form.port);
  form.identityFiles.forEach(f => opt('IdentityFile', f));
  opt('IdentitiesOnly', form.identitiesOnly);
  opt('ProxyJump', form.proxyJump);
  opt('ForwardAgent', form.forwardAgent);
  for (const raw of form.extra.split(/\r?\n/)) {
    if (raw.trim()) {
      out.push(optIndent + raw.trim());
    }
  }
  return out;
}

// ---------------------------------------------------------------- host edits

export function addHost(doc: Doc, form: HostForm): string {
  const L = doc.lines.slice();
  insertBlock(L, insertPoint(doc, form.container), buildBlock(form, {}, '', '    '));
  return finish(doc, L);
}

export function updateHost(doc: Doc, hostId: string, form: HostForm): string {
  const host = mustHost(doc, hostId);
  const hostIndent = indentOf(bare(doc.lines[host.hostLine]));
  const firstOpt = host.options[0];
  const optIndent = firstOpt ? indentOf(bare(doc.lines[firstOpt.line])) : hostIndent + '    ';
  const L = doc.lines.slice();
  let block = buildBlock(form, host.attrs, hostIndent, optIndent);
  if (host.disabled) {
    block = block.map(l => (l.trimStart().startsWith('#@host') ? l : OFF + l));
  }
  L.splice(host.start, host.end - host.start, ...block);
  const text = finish(doc, L);

  if (form.container === (host.container?.id ?? '')) {
    return text;
  }
  const doc2 = parse(text, doc.file);
  const moved = doc2.hosts.find(h => h.start === host.start);
  return moved ? moveHost(doc2, moved.id, form.container) : text;
}

export function deleteHost(doc: Doc, hostId: string): string {
  const host = mustHost(doc, hostId);
  const L = doc.lines.slice();
  removeRange(L, host.start, host.end);
  return finish(doc, L);
}

/** Moves a host to the end of a container, or right before another host. */
export function moveHost(doc: Doc, hostId: string, containerId: string, beforeHostId?: string): string {
  const host = mustHost(doc, hostId);
  let at = beforeHostId ? mustHost(doc, beforeHostId).start : insertPoint(doc, containerId);
  const L = doc.lines.slice();
  if (at >= host.start && at <= host.end) {
    return finish(doc, L); // already there
  }
  const block = L.slice(host.start, host.end);
  const removed = removeRange(L, host.start, host.end);
  if (at > host.end) {
    at -= removed;
  }
  insertBlock(L, at, block);
  return finish(doc, L);
}

export function setHostAttrs(doc: Doc, hostId: string, patch: Record<string, string | undefined>): string {
  const host = mustHost(doc, hostId);
  const attrs = { ...host.attrs };
  for (const [k, v] of Object.entries(patch)) {
    setAttr(attrs, k, v);
  }
  const L = doc.lines.slice();
  const has = Object.keys(attrs).length > 0;
  const line = directiveLine('host', undefined, attrs, indentOf(bare(doc.lines[host.hostLine])));
  if (host.metaLine !== undefined) {
    has ? L.splice(host.metaLine, 1, line) : L.splice(host.metaLine, 1);
  } else if (has) {
    L.splice(host.hostLine, 0, line);
  }
  return finish(doc, L);
}

function mustHost(doc: Doc, id: string): Host {
  const h = findHost(doc, id);
  if (!h) {
    throw new Error(`Host "${id.replace(/#\d+$/, '')}" is no longer in the config file.`);
  }
  if (h.readonly) {
    throw new Error(`Host "${h.alias}" comes from an included file and is read-only.`);
  }
  return h;
}

// ---------------------------------------------------------------- group edits

function mustContainer(doc: Doc, id: string): Container {
  const c = findContainer(doc, id);
  if (!c) {
    throw new Error('That group is no longer in the config file.');
  }
  return c;
}

export function addGroup(doc: Doc, name: string): string {
  const L = doc.lines.slice();
  insertBlock(L, eofIndex(L), [directiveLine('group', name.trim(), {})]);
  return finish(doc, L);
}

export function addSection(doc: Doc, groupId: string, name: string): string {
  const g = mustContainer(doc, groupId);
  const next = doc.groups[doc.groups.indexOf(g) + 1];
  const L = doc.lines.slice();
  let at = next ? next.start : L.length;
  // stay above the blank lines and any spacer row that belong to the next group
  while (at > 0 && (isBlank(L[at - 1]) || doc.spacers.some(s => at - 1 >= s.start && at - 1 < s.end))) {
    at--;
  }
  insertBlock(L, at, [directiveLine('section', name.trim(), {})]);
  return finish(doc, L);
}

export function renameContainer(doc: Doc, id: string, name: string): string {
  const c = mustContainer(doc, id);
  name = name.trim();
  const L = doc.lines.slice();
  const by = (k: MarkerKind) => c.markers.filter(m => m.kind === k);

  for (const m of by('explicit')) {
    L[m.start] = directiveLine(c.kind, name, c.attrs, indentOf(L[m.start]));
  }
  for (const m of by('separator')) {
    // keep the decoration, swap the name:  Host -----OLD-----  ->  Host -----NEW-----
    const line = bare(L[m.start]);
    const { value } = splitOption(line.trim());
    const sep = SEPARATOR.exec(unquote(value));
    if (sep) {
      L[m.start] = keepOff(L[m.start], `${indentOf(line)}Host ${sep[1]}${name.replace(/\s+/g, '-')}${sep[3]}`);
    }
  }
  if (!by('explicit').length) {
    for (const m of by('subheader')) {
      L[m.start] = `${indentOf(L[m.start])}# --- ${name} ---`;
    }
    if (!by('separator').length) {
      for (const m of by('banner')) {
        L[m.start + 1] = `${indentOf(L[m.start + 1])}# ${name}`;
      }
    }
  }
  return finish(doc, L);
}

export function setContainerAttrs(doc: Doc, id: string, patch: Record<string, string | undefined>): string {
  const c = mustContainer(doc, id);
  const attrs = { ...c.attrs };
  for (const [k, v] of Object.entries(patch)) {
    setAttr(attrs, k, v);
  }
  const L = doc.lines.slice();
  const explicit = c.markers.find(m => m.kind === 'explicit');
  if (explicit) {
    L[explicit.start] = directiveLine(c.kind, c.title, attrs, indentOf(L[explicit.start]));
  } else if (Object.keys(attrs).length) {
    // A hand-written group: decorate it with a #@ line directly above its own marker.
    L.splice(c.start, 0, directiveLine(c.kind, c.title, attrs));
  }
  return finish(doc, L);
}

export function deleteContainer(doc: Doc, id: string): string {
  const c = mustContainer(doc, id);
  if (c.total > 0 || c.hosts.length > 0) {
    throw new Error(`"${c.title}" still has hosts. Move or delete them first.`);
  }
  const ranges = [c, ...c.sections].flatMap(x => x.markers).sort((a, b) => b.start - a.start);
  const L = doc.lines.slice();
  for (const r of ranges) {
    removeRange(L, r.start, r.end);
  }
  return finish(doc, L);
}

// ---------------------------------------------------------------- reordering groups

/** Runs `move` on the file without its generated picker rows, then puts those rows back. */
function withoutDecor(doc: Doc, move: (clean: Doc) => string): string {
  if (!doc.spacers.length) {
    return move(doc);
  }
  return setSpacers(parse(move(parse(setSpacers(doc, false), doc.file)), doc.file), true);
}

/** Cuts [start, end) (minus trailing blank lines) and pastes it at `at`. `at` < 0 = end of file. */
function relocate(d: Doc, start: number, end: number, at: number): string {
  const L = d.lines.slice();
  if (at < 0) {
    at = L.length;
  }
  if (at >= start && at <= end) {
    return finish(d, L); // already there
  }
  let e = end;
  while (e > start && isBlank(L[e - 1])) {
    e--;
  }
  const block = L.slice(start, e);
  const removed = removeRange(L, start, e);
  if (at > start) {
    at -= removed;
  }
  at = Math.min(at, L.length);
  if (at === L.length) {
    at = eofIndex(L);
  }
  insertBlock(L, at, block);
  return finish(d, L);
}

/** Moves a whole project (its header lines and everything in it) before another one, or to the end. */
export function moveGroup(doc: Doc, id: string, beforeId?: string): string {
  return withoutDecor(doc, d => {
    const g = mustContainer(d, id);
    const i = d.groups.indexOf(g);
    if (i < 0) {
      throw new Error(`"${g.title}" is a sub-folder, not a project.`);
    }
    const before = beforeId ? mustContainer(d, beforeId) : undefined;
    return relocate(d, g.start, d.groups[i + 1]?.start ?? d.lines.length, before ? before.start : -1);
  });
}

/**
 * Hand-written files often put the first `# --- sub-folder ---` line above the project's own
 * `Host ---NAME---` row. That reads the same, but the sub-folder cannot be moved on its own while
 * the project's row sits inside it, so this puts the sub-folder line right below that row.
 */
function tidyFirstSection(d: Doc, g: Container): Doc {
  const first = g.sections[0];
  const late = first ? g.markers.filter(m => m.start > first.start) : [];
  if (!late.length) {
    return d;
  }
  const L = d.lines.slice();
  const start = Math.min(...first.markers.map(m => m.start));
  const end = Math.max(...first.markers.map(m => m.end));
  const block = L.slice(start, end);
  insertBlock(L, Math.max(...late.map(m => m.end)), block);
  removeRange(L, start, end);
  return parse(finish(d, L), d.file);
}

/** Moves a sub-folder with its hosts into `groupId`: before another sub-folder there, or last. */
export function moveSection(doc: Doc, id: string, groupId: string, beforeId?: string): string {
  return withoutDecor(doc, clean => {
    let d = clean;
    for (const gid of [mustContainer(d, id).parent?.id, groupId]) {
      const g = gid ? findContainer(d, gid) : undefined;
      if (g) {
        d = tidyFirstSection(d, g);
      }
    }
    const s = mustContainer(d, id);
    const from = s.parent;
    const to = mustContainer(d, groupId);
    if (!from || to.kind !== 'group') {
      throw new Error('A sub-folder can only be moved into a project.');
    }
    const endOf = (g: Container) => d.groups[d.groups.indexOf(g) + 1]?.start ?? d.lines.length;
    const end = from.sections[from.sections.indexOf(s) + 1]?.start ?? endOf(from);
    let at = beforeId ? mustContainer(d, beforeId).start : endOf(to);
    if (!beforeId) {
      while (at > 0 && isBlank(d.lines[at - 1])) {
        at--;
      }
      if (at === end || (at >= s.start && at <= end)) {
        at = s.start; // already the last one there
      }
    }
    return relocate(d, s.start, end, at);
  });
}

// ---------------------------------------------------------------- enable / disable

function setOff(L: string[], start: number, end: number, on: boolean): void {
  for (let i = start; i < end; i++) {
    if (on) {
      L[i] = bare(L[i]);
    } else if (!isBlank(L[i]) && !isOff(L[i]) && !L[i].trimStart().startsWith('#@host')) {
      L[i] = OFF + L[i];
    }
  }
}

/** Disabling comments the block out with `#@off`, so ssh and Remote-SSH no longer see the host. */
export function setHostEnabled(doc: Doc, hostId: string, on: boolean): string {
  const host = mustHost(doc, hostId);
  const L = doc.lines.slice();
  setOff(L, host.hostLine, host.end, on);
  return finish(doc, L);
}

/** Same for a whole group or sub-group: its hosts, its separator host and the spacer row above it. */
export function setContainerEnabled(doc: Doc, id: string, on: boolean): string {
  const c = mustContainer(doc, id);
  const L = doc.lines.slice();
  for (const h of [...c.hosts, ...c.sections.flatMap(s => s.hosts)]) {
    setOff(L, h.hostLine, h.end, on);
  }
  for (const m of c.markers.filter(x => x.kind === 'separator')) {
    setOff(L, m.start, m.end, on);
  }
  if (c.kind === 'group') {
    const above = doc.spacers.find(s => s.end <= c.start && L.slice(s.end, c.start).every(isBlank));
    if (above) {
      setOff(L, above.start, above.end, on);
    }
  }
  return finish(doc, L);
}

// ---------------------------------------------------------------- favorites for the Remote-SSH picker

export const FAV_PREFIX = '\u2605';

/**
 * The Remote-SSH picker has no notion of favorites, so when the `remote-favorites=on` setting is
 * set, starred hosts are copied into a generated block at the top of the file under a
 * `Host -----FAVORITES-----` separator, as `Host ★name` with the same options. The block is
 * rebuilt after every edit; with the setting off it is removed.
 */
export function syncMirror(doc: Doc): string {
  const L = doc.lines.slice();
  const favs = doc.hosts.filter(h => h.attrs.fav && h.attrs.fav !== '0' && connectName(h));
  let block: string[] | undefined;
  if (doc.settings['remote-favorites'] === 'on' && favs.length) {
    block = ['#@favorites-begin generated from the starred hosts below - do not edit this block', 'Host -----------FAVORITES-----------'];
    for (const h of favs) {
      block.push(`Host ${FAV_PREFIX}${connectName(h)}`);
      for (let i = h.hostLine + 1; i < h.end; i++) {
        const t = doc.lines[i].trim();
        if (t && !t.startsWith('#')) {
          block.push('    ' + t);
        }
      }
    }
    if (doc.spacers.length) {
      block.push('Host \u3164'); // blank row closing the section, like the ones between projects
    }
    block.push('#@favorites-end');
  }
  if (doc.mirror) {
    if (block) {
      L.splice(doc.mirror.start, doc.mirror.end - doc.mirror.start, ...block);
    } else {
      removeRange(L, doc.mirror.start, doc.mirror.end);
    }
  } else if (block) {
    const starts = [...doc.hosts.map(h => h.start), ...doc.groups.map(g => g.start), ...doc.spacers.map(s => s.start)];
    insertBlock(L, starts.length ? Math.min(...starts) : eofIndex(L), block);
  }
  return finish(doc, L);
}

// ---------------------------------------------------------------- Remote-SSH picker spacing

/**
 * The Remote-SSH picker lists Host names one per row. A `Host` whose name is made of invisible
 * characters shows up there as an empty row, so one above each `Host ---NAME---` separator
 * gives a gap between projects. `on = false` removes every such line again.
 */
export function setSpacers(doc: Doc, on: boolean): string {
  let L = doc.lines.slice();
  for (const s of doc.spacers.slice().sort((a, b) => b.start - a.start)) {
    removeRange(L, s.start, s.end);
  }
  if (on) {
    const clean = parse(finish(doc, L), doc.file);
    L = clean.lines.slice();
    const rows: { at: number; line: string }[] = [];
    const S = SPACER_CHAR;
    clean.groups
      .filter(g => g.markers.some(m => m.kind === 'separator'))
      .forEach((g, i) => {
        // each spacer gets a different (still invisible) name so none is dropped as a duplicate
        const line = 'Host ' + S.repeat(i + 1);
        rows.push({ at: g.start, line: isDisabled(g) ? OFF + line : line });
      });
    // Sub-folders: a "--- NAME ---" row above the first host of each, flush left like the hosts
    // themselves (real hosts cannot be indented, so an indented header reads upside down).
    // A zero-width character in front marks the row as decoration; non-breaking spaces stand in
    // for the spaces a Host name cannot contain; trailing zero-width characters keep names unique.
    const style = doc.settings['remote-subfolders'] ?? 'dashes';
    const Z = '\u200b';
    let n = 0;
    for (const g of clean.groups) {
      if (g.sections.length === 1 && !g.hosts.length) {
        continue; // one sub-folder holding everything is not worth a row
      }
      for (const s of g.sections) {
        if (style !== 'off' && s.hosts.some(h => !h.disabled)) {
          n++;
          const name = s.title.trim().replace(/\s+/g, '\u00a0');
          const text = style === 'arrow' ? `\u25be\u00a0${name}` : `---\u00a0${name}\u00a0---`;
          rows.push({ at: s.hosts[0].start, line: `Host ${Z}${text}${Z.repeat(n)}` });
        }
      }
    }
    for (const r of rows.sort((a, b) => b.at - a.at)) {
      insertBlock(L, r.at, [r.line]);
    }
  }
  return finish(doc, L);
}

// ---------------------------------------------------------------- settings

export function setSettings(doc: Doc, patch: Record<string, string | undefined>): string {
  const attrs = { ...doc.settings };
  for (const [k, v] of Object.entries(patch)) {
    setAttr(attrs, k, v);
  }
  const L = doc.lines.slice();
  const line = directiveLine('ssh-manager', undefined, attrs);
  if (doc.settingsLine !== undefined) {
    L[doc.settingsLine] = line;
  } else {
    L.splice(0, 0, line);
  }
  return finish(doc, L);
}
