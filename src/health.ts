/**
 * Server status: is a host up or down right now? Three ways to ask, chosen for all hosts in the
 * settings and per host with `check=` in its `#@host` line:
 *
 *   ssh   something answers on the host's SSH port (a plain TCP connection, no login)
 *   ping  the host answers one ping
 *   http  a web address answers (`check=https://example.com/health`, or https://<HostName>/)
 *
 * Free of the vscode API: the real network sits behind `HealthDeps`, so the tests run without one.
 */
import type { ExecResult } from './doctor';

export const HEALTH_METHODS = ['off', 'ssh', 'ping', 'http'] as const;
export type HealthMethod = (typeof HEALTH_METHODS)[number];

export type HealthStatus = 'up' | 'down' | 'unknown';

export interface HealthResult {
  status: HealthStatus;
  /** how the answer was found, in words: "SSH port 22 answered" */
  detail: string;
  /** time the answer took */
  ms?: number;
  /** when the check finished (ms since epoch) */
  at: number;
}

/** What is known about a host before checking it. */
export interface HealthTarget {
  /** address ssh connects to (HostName, or the alias) */
  hostName: string;
  port: number;
  /** the host is reached through ProxyJump or ProxyCommand, so this computer cannot reach it directly */
  viaJump: boolean;
  /** the host's own `check=` value, '' when it has none */
  check: string;
}

export type Plan =
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'ping'; host: string }
  | { kind: 'http'; url: string }
  | { kind: 'none'; reason: string };

export interface HealthDeps {
  platform: NodeJS.Platform;
  now: () => number;
  connect: (host: string, port: number, timeoutMs: number) => Promise<void>;
  exec: (cmd: string, args: string[], timeoutMs: number) => Promise<ExecResult>;
  /** resolves with the HTTP status code of the answer */
  http: (url: string, timeoutMs: number) => Promise<number>;
}

const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s);

/** A host's own `check=` value: a method, a web address, or '' for "use the default". */
export function normalizeCheck(value: string | undefined): string {
  const v = (value ?? '').trim();
  if (isUrl(v)) {
    return v;
  }
  const lower = v.toLowerCase();
  return (HEALTH_METHODS as readonly string[]).includes(lower) ? lower : '';
}

/** Why a web address cannot be used, or undefined when it is fine. */
export function urlProblem(value: string): string | undefined {
  const v = value.trim();
  if (!v) {
    return 'Type a web address, for example https://example.com/health';
  }
  if (/\s|"/.test(v)) {
    return 'A web address has no spaces or quotes.';
  }
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? undefined : 'The address must start with http:// or https://';
  } catch {
    return 'The address must start with http:// or https://';
  }
}

const bracket = (host: string) => (host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);

/** Decides how one host is checked: its own choice first, the default for all hosts otherwise. */
export function planCheck(t: HealthTarget, fallback: HealthMethod): Plan {
  const own = normalizeCheck(t.check);
  const method = own || fallback;
  if (method === 'off') {
    return { kind: 'none', reason: own ? 'Status check is off for this host.' : 'Status checks are off.' };
  }
  if (isUrl(method)) {
    return { kind: 'http', url: method };
  }
  if (!t.hostName) {
    return { kind: 'none', reason: 'The host has no address.' };
  }
  if (t.viaJump) {
    // only the jump host can reach it: a direct check would call it down when it is not
    return { kind: 'none', reason: 'Reached through a jump host, so it cannot be checked from this computer. Give it a web address to check, or use Test Connection.' };
  }
  if (method === 'http') {
    return { kind: 'http', url: `https://${bracket(t.hostName)}/` };
  }
  return method === 'ping' ? { kind: 'ping', host: t.hostName } : { kind: 'tcp', host: t.hostName, port: t.port || 22 };
}

/** One ping with a timeout: the flags differ per system. */
export function pingCommand(platform: NodeJS.Platform, host: string, timeoutSec: number): { cmd: string; args: string[] } {
  if (platform === 'win32') {
    return { cmd: 'ping', args: ['-n', '1', '-w', String(timeoutSec * 1000), host] };
  }
  if (platform === 'darwin') {
    return { cmd: 'ping', args: ['-c', '1', '-t', String(timeoutSec), host] };
  }
  return { cmd: 'ping', args: ['-c', '1', '-W', String(timeoutSec), host] };
}

const NET_ERRORS: Record<string, string> = {
  ENOTFOUND: 'the name could not be found',
  EAI_AGAIN: 'the name could not be looked up',
  ECONNREFUSED: 'the connection was refused',
  ETIMEDOUT: 'no answer in time',
  EHOSTUNREACH: 'no route to the server',
  ENETUNREACH: 'the network is unreachable',
  ECONNRESET: 'the connection was closed',
};

function why(e: any): string {
  return NET_ERRORS[String(e?.code)] ?? (String(e?.message ?? e).split('\n')[0] || 'no answer');
}

export const TIMEOUT_MS = 5000;

/** Carries out one check. Never throws: a failed check is the answer "down". */
export async function runCheck(plan: Plan, deps: HealthDeps, timeoutMs = TIMEOUT_MS): Promise<HealthResult> {
  const start = deps.now();
  const done = (status: HealthStatus, detail: string, timed = true): HealthResult => {
    const at = deps.now();
    return { status, detail, at, ms: timed && status === 'up' ? Math.max(0, at - start) : undefined };
  };
  switch (plan.kind) {
    case 'none':
      return done('unknown', plan.reason);
    case 'tcp':
      try {
        await deps.connect(plan.host, plan.port, timeoutMs);
        return done('up', `SSH port ${plan.port} answered`);
      } catch (e) {
        return done('down', `SSH port ${plan.port}: ${why(e)}`);
      }
    case 'ping': {
      const { cmd, args } = pingCommand(deps.platform, plan.host, Math.ceil(timeoutMs / 1000));
      const r = await deps.exec(cmd, args, timeoutMs + 2000);
      if (r.error === 'ENOENT') {
        return done('unknown', 'The ping program was not found on this computer.');
      }
      // Windows also exits 0 for "Destination host unreachable": a real answer carries TTL=
      const ok = r.code === 0 && (deps.platform !== 'win32' || /TTL=/i.test(r.stdout));
      return ok ? done('up', 'Ping answered') : done('down', 'No answer to ping');
    }
    case 'http':
      try {
        const code = await deps.http(plan.url, timeoutMs);
        return code < 500 ? done('up', `${plan.url} answered (${code})`) : done('down', `${plan.url} answered with an error (${code})`);
      } catch (e) {
        return done('down', `${plan.url}: ${why(e)}`);
      }
  }
}

/** Runs `fn` over `items`, at most `limit` at a time. */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      await fn(items[next++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** The small dot shown next to a host. */
export const HEALTH_DOTS: Record<HealthStatus, string> = {
  up: '\u{1F7E2}',
  down: '\u{1F534}',
  unknown: '⚪',
};

export const HEALTH_WORDS: Record<HealthStatus, string> = { up: 'Up', down: 'Down', unknown: 'Not checked' };

/** "Up · SSH port 22 answered in 23 ms · checked 2 min ago" */
export function describeHealth(r: HealthResult, now: number): string {
  const secs = Math.max(0, Math.round((now - r.at) / 1000));
  const when = secs < 10 ? 'just now' : secs < 90 ? `${secs} s ago` : secs < 5400 ? `${Math.round(secs / 60)} min ago` : `${Math.round(secs / 3600)} h ago`;
  const detail = r.ms !== undefined ? `${r.detail} in ${r.ms} ms` : r.detail;
  return r.status === 'unknown' ? detail : `${HEALTH_WORDS[r.status]} · ${detail} · checked ${when}`;
}

/** The interval setting, tidied: 0 = only when asked, otherwise at least 15 seconds. */
export function intervalSeconds(value: unknown): number {
  const n = Math.floor(Number(value));
  return !Number.isFinite(n) || n <= 0 ? 0 : Math.max(15, Math.min(n, 86400));
}
