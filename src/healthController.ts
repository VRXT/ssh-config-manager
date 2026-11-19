import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';
import { parseEffective } from './doctor';
import { realDeps } from './doctorPanel';
import { HEALTH_METHODS, HealthDeps, HealthMethod, HealthResult, HealthTarget, intervalSeconds, planCheck, pool, runCheck } from './health';
import { Host, connectName, option } from './sshConfig';
import { Store } from './store';

function httpStatus(url: string, timeoutMs: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const lib = url.toLowerCase().startsWith('https:') ? https : http;
    // "is something answering" only: a self-signed certificate still means the server is up
    const req = lib.get(url, { timeout: timeoutMs, rejectUnauthorized: false, headers: { 'User-Agent': 'ssh-config-manager-status' } }, res => {
      resolve(res.statusCode ?? 0);
      res.destroy();
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
  });
}

/** Keeps the up / down state of every host: checks on a timer while the panel is visible, and when asked. */
export class HealthController implements vscode.Disposable {
  private readonly results = new Map<string, HealthResult>();
  /** what `ssh -G` says about a host; emptied when the config changes */
  private readonly targets = new Map<string, Promise<HealthTarget>>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subs: vscode.Disposable[] = [];
  private readonly deps: HealthDeps;
  private timer: NodeJS.Timeout | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private paint: NodeJS.Timeout | undefined;
  private running = false;
  private again = false;
  /** a check came due while the panel was hidden */
  private due = true;
  private visible = false;
  private lastText: string;

  constructor(private readonly store: Store) {
    this.lastText = store.text;
    const real = realDeps();
    this.deps = { platform: process.platform, now: () => Date.now(), connect: real.connect, exec: real.exec, http: httpStatus };
    this.subs.push(
      store.onDidChange(() => {
        // the store also announces reloads that changed nothing
        if (store.text !== this.lastText) {
          this.lastText = store.text;
          this.targets.clear();
          this.soon();
        }
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('sshManager.health')) {
          this.soon(200);
        }
      }),
    );
  }

  get method(): HealthMethod {
    const v = vscode.workspace.getConfiguration('sshManager').get<string>('health.check') ?? 'ssh';
    return (HEALTH_METHODS as readonly string[]).includes(v) ? (v as HealthMethod) : 'ssh';
  }

  get interval(): number {
    return intervalSeconds(vscode.workspace.getConfiguration('sshManager').get('health.interval') ?? 300);
  }

  get(alias: string | undefined): HealthResult | undefined {
    return alias ? this.results.get(alias) : undefined;
  }

  /** The Hosts panel was shown or hidden: checks only run for a panel someone is looking at. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && this.due) {
      this.soon(300);
    }
  }

  private hosts(): Host[] {
    const all = [...this.store.doc.hosts, ...this.store.included.flatMap(d => d.hosts)];
    const seen = new Set<string>();
    return all.filter(h => {
      const name = connectName(h);
      if (!name || h.disabled || seen.has(name)) {
        return false;
      }
      seen.add(name);
      return true;
    });
  }

  private soon(ms = 1500): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.auto(), ms);
  }

  /** A check nobody asked for by hand: skipped while the panel is hidden. */
  private async auto(): Promise<void> {
    if (!this.visible) {
      this.due = true;
      return;
    }
    await this.check();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    const seconds = this.interval;
    if (seconds > 0 && this.method !== 'off') {
      this.timer = setTimeout(() => void this.auto(), seconds * 1000);
    }
  }

  private target(h: Host, alias: string): Promise<HealthTarget> {
    let t = this.targets.get(alias);
    if (!t) {
      t = this.resolve(h, alias);
      this.targets.set(alias, t);
    }
    return t;
  }

  /** `ssh -G` knows what ssh will really use (Host * blocks, Match, Include); the host's own lines are the fallback. */
  private async resolve(h: Host, alias: string): Promise<HealthTarget> {
    const check = h.attrs.check ?? '';
    const file = this.store.sshConfigFile;
    const r = await this.deps.exec('ssh', [...(file ? ['-F', file] : []), '-G', alias], 8000);
    if (r.code === 0 && r.stdout) {
      const m = parseEffective(r.stdout);
      const one = (k: string) => m.get(k)?.[0] ?? '';
      const set = (v: string) => !!v && v.toLowerCase() !== 'none';
      return { hostName: one('hostname') || alias, port: Number(one('port')) || 22, viaJump: set(one('proxyjump')) || set(one('proxycommand')), check };
    }
    const set = (v: string) => !!v && v.toLowerCase() !== 'none';
    return {
      hostName: option(h, 'HostName') || alias,
      port: Number(option(h, 'Port')) || 22,
      viaJump: set(option(h, 'ProxyJump')) || set(option(h, 'ProxyCommand')),
      check,
    };
  }

  /** Checks every host, or only the named ones. */
  async check(only?: string[]): Promise<void> {
    if (this.running) {
      this.again = this.again || !only;
      return;
    }
    this.running = true;
    this.due = false;
    try {
      const method = this.method;
      const hosts = this.hosts();
      const names = new Set(hosts.map(h => connectName(h)!));
      for (const known of [...this.results.keys()]) {
        if (!names.has(known)) {
          this.results.delete(known);
        }
      }
      const list = only ? hosts.filter(h => only.includes(connectName(h)!)) : hosts;
      await pool(list, 8, async h => {
        const alias = connectName(h)!;
        const plan = planCheck(await this.target(h, alias), method);
        if (plan.kind === 'none' && method === 'off' && !h.attrs.check) {
          this.results.delete(alias); // everything off: no dots at all
        } else {
          this.results.set(alias, await runCheck(plan, this.deps));
        }
        this.paintSoon();
      });
    } finally {
      this.running = false;
      this.changed.fire();
      this.schedule();
      if (this.again) {
        this.again = false;
        void this.check();
      }
    }
  }

  /** Results arrive one by one; the list is redrawn a few times a second at most. */
  private paintSoon(): void {
    this.paint ??= setTimeout(() => {
      this.paint = undefined;
      this.changed.fire();
    }, 400);
  }

  dispose(): void {
    clearTimeout(this.timer);
    clearTimeout(this.debounce);
    clearTimeout(this.paint);
    this.changed.dispose();
    this.subs.forEach(s => s.dispose());
  }
}
