/**
 * Host search and filters, kept free of the vscode API so it can be tested in plain node.
 *
 *  - text: every word must appear somewhere in the host: its name, any option (HostName, User,
 *    Port, IdentityFile, ProxyJump, …), tags, note, group path or provider.
 *  - tags / providers / groups: pick one or more values; a host must match one of the picked
 *    values in each list that has any (OR inside a list, AND between lists).
 */
import { Doc, Host, containerPath, hostTags, providerOf } from './sshConfig';

export interface HostFilter {
  text: string;
  tags: string[];
  providers: string[];
  groups: string[];
}

export const emptyFilter = (): HostFilter => ({ text: '', tags: [], providers: [], groups: [] });

export function isFilterEmpty(f: HostFilter): boolean {
  return !f.text.trim() && !f.tags.length && !f.providers.length && !f.groups.length;
}

/** Top-level group a host sits in ('' when it is not in any group). */
export function hostGroup(h: Host): string {
  const c = h.container;
  return c ? (c.parent ?? c).title : '';
}

function haystack(h: Host): string {
  return [
    h.alias,
    ...h.patterns,
    ...h.options.map(o => `${o.key} ${o.value}`),
    h.attrs.tags,
    h.attrs.note,
    containerPath(h.container),
    providerOf(h)?.label,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function hostMatches(h: Host, f: HostFilter): boolean {
  if (f.tags.length) {
    const tags = hostTags(h).map(t => t.toLowerCase());
    if (!f.tags.some(t => tags.includes(t.toLowerCase()))) {
      return false;
    }
  }
  if (f.providers.length && !f.providers.includes(providerOf(h)?.label ?? '')) {
    return false;
  }
  if (f.groups.length && !f.groups.includes(hostGroup(h))) {
    return false;
  }
  const words = f.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) {
    return true;
  }
  const hay = haystack(h);
  return words.every(w => hay.includes(w));
}

export interface Facet {
  value: string;
  count: number;
}

export interface Facets {
  tags: Facet[];
  providers: Facet[];
  groups: Facet[];
}

/** The values the filter chips offer, with how many hosts have each. Patterns (`Host *`) are left out. */
export function facets(docs: Doc[]): Facets {
  const count = (values: string[]): Facet[] => {
    const m = new Map<string, number>();
    for (const v of values) {
      m.set(v, (m.get(v) ?? 0) + 1);
    }
    return [...m].map(([value, n]) => ({ value, count: n }));
  };
  const hosts = docs.flatMap(d => d.hosts).filter(h => !h.isPattern);
  const byName = (a: Facet, b: Facet) => a.value.localeCompare(b.value, undefined, { sensitivity: 'base', numeric: true });
  // groups keep their order in the file, the others are sorted by name
  const groups: string[] = [];
  for (const d of docs) {
    for (const g of d.groups) {
      if (!groups.includes(g.title)) {
        groups.push(g.title);
      }
    }
  }
  const groupCounts = count(hosts.map(hostGroup).filter(Boolean));
  return {
    tags: count(hosts.flatMap(h => [...new Set(hostTags(h))])).sort(byName),
    providers: count(hosts.map(h => providerOf(h)?.label ?? '').filter(Boolean)).sort(byName),
    groups: groups.map(g => groupCounts.find(c => c.value === g)).filter((g): g is Facet => !!g),
  };
}

/** Short text for the Hosts view header, e.g. `"db" · #prod · AWS`. */
export function describeFilter(f: HostFilter): string {
  return [f.text.trim() && `"${f.text.trim()}"`, ...f.tags.map(t => '#' + t), ...f.providers, ...f.groups]
    .filter(Boolean)
    .join(' · ');
}
