import * as cp from 'child_process';
import * as dns from 'dns';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as vscode from 'vscode';
import { DoctorDeps, ExecResult, Fix, FixId, Step, reportText, runDoctor, verdict } from './doctor';
import { connectName, hostToForm, optionAll, updateHost } from './sshConfig';
import { Store } from './store';
import { artUris, page, webviewOptions } from './ui';

/** The real world behind the doctor's checks: the system's ssh tools, DNS and a TCP connection. */
export function realDeps(): DoctorDeps {
  return {
    platform: process.platform,
    home: os.homedir(),
    exec: (cmd, args, timeoutMs) =>
      new Promise<ExecResult>(resolve => {
        // LC_ALL=C: the diagnosis reads ssh's English messages
        cp.execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }, (err: any, stdout, stderr) => {
          resolve({
            code: err ? (typeof err.code === 'number' ? err.code : undefined) : 0,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            error: err?.code === 'ENOENT' ? 'ENOENT' : err?.killed ? 'TIMEOUT' : undefined,
          });
        });
      }),
    lookup: async host => (await dns.promises.lookup(host)).address,
    connect: (host, port, timeoutMs) =>
      new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host, port });
        const done = (err?: Error) => {
          socket.destroy();
          err ? reject(err) : resolve();
        };
        socket.setTimeout(timeoutMs, () => done(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
        socket.once('connect', () => done());
        socket.once('error', done);
      }),
    exists: file => fs.existsSync(file),
    mode: file => {
      try {
        return fs.statSync(file).mode;
      } catch {
        return 0;
      }
    },
    head: (file, bytes) => {
      try {
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(bytes);
          return buf.subarray(0, fs.readSync(fd, buf, 0, bytes, 0)).toString('latin1');
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return '';
      }
    },
  };
}

const quote = (s: string) => (process.platform === 'win32' ? `"${s.replace(/"/g, '')}"` : /^[\w.@:%+,/=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** One "Connection test" tab per host: runs the doctor, shows the checklist, carries out the fixes. */
export class DoctorPanels implements vscode.Disposable {
  private readonly open = new Map<string, { panel: vscode.WebviewPanel; steps: Step[]; running: boolean }>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: Store,
    /** runs a command in a terminal on this computer (also from a remote window) */
    private readonly runLocal: (name: string, cmd: string) => Promise<void>,
  ) {}

  /** Opens (or brings forward) the test for a host and runs it. */
  test(alias: string): void {
    let entry = this.open.get(alias);
    if (!entry) {
      const uri = this.context.extensionUri;
      const panel = vscode.window.createWebviewPanel('sshManager.doctor', `Test: ${alias}`, vscode.ViewColumn.Active, { ...webviewOptions(uri), retainContextWhenHidden: true });
      panel.iconPath = vscode.Uri.joinPath(uri, 'media', 'icon.png');
      panel.webview.html = page(panel.webview, uri, { title: `Connection test: ${alias}`, scripts: ['components.js', 'doctor.js'] });
      entry = { panel, steps: [], running: false };
      this.open.set(alias, entry);
      panel.onDidDispose(() => this.open.delete(alias));
      panel.webview.onDidReceiveMessage(msg => void this.handle(alias, msg));
      return; // the page asks for the first run when it is ready
    }
    entry.panel.reveal();
    void this.run(alias);
  }

  private host(alias: string) {
    this.store.reload();
    return this.store.doc.hosts.find(h => !h.isPattern && !h.disabled && connectName(h) === alias);
  }

  private async run(alias: string): Promise<void> {
    const entry = this.open.get(alias);
    if (!entry || entry.running) {
      return;
    }
    const host = this.host(alias);
    const post = (m: object) => void entry.panel.webview.postMessage(m);
    entry.running = true;
    entry.steps = [];
    post({ type: 'start', alias, art: artUris(entry.panel.webview, this.context.extensionUri).welcome });
    try {
      entry.steps = await runDoctor(
        { alias, configFile: this.store.sshConfigFile, identityFiles: host ? optionAll(host, 'IdentityFile') : [] },
        realDeps(),
        step => post({ type: 'step', step }),
      );
    } catch (e: any) {
      entry.steps.push({ id: 'login', title: 'Log in with a key', status: 'fail', detail: `The test itself failed: ${e?.message ?? e}` });
      post({ type: 'step', step: entry.steps[entry.steps.length - 1] });
    } finally {
      entry.running = false;
    }
    post({ type: 'done', verdict: verdict(entry.steps) });
  }

  private async handle(alias: string, msg: any): Promise<void> {
    const entry = this.open.get(alias);
    if (!entry) {
      return;
    }
    switch (msg?.type) {
      case 'ready':
      case 'run':
        await this.run(alias);
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(reportText(alias, entry.steps));
        vscode.window.showInformationMessage('Connection report copied. It contains host names and file paths, but no keys or passwords.');
        return;
      case 'fix': {
        const id = String(msg.id) as FixId;
        // act only on what the test itself reported: the page cannot name files or hosts of its own
        const offered = entry.steps.flatMap(s => s.fixes ?? []).find(f => f.id === id && (f.arg ?? '') === String(msg.arg ?? ''));
        const fix: Fix | undefined = offered ?? (id === 'editHost' && !msg.arg ? { id, label: 'Edit Host' } : undefined);
        if (fix && (await this.apply(alias, fix))) {
          await this.run(alias);
        }
        return;
      }
    }
  }

  /** Carries out one fix. Returns true when the test should run again right away. */
  private async apply(alias: string, fix: Fix): Promise<boolean> {
    const host = this.host(alias);
    const node = host ? { type: 'host', host } : undefined;
    switch (fix.id) {
      case 'setupKey':
        await vscode.commands.executeCommand('sshManager.setupKey', node);
        return false;
      case 'editHost':
        await vscode.commands.executeCommand('sshManager.editHost', node);
        return false;
      case 'openConfig':
        await vscode.commands.executeCommand('sshManager.openConfig');
        return false;
      case 'terminal':
        await vscode.commands.executeCommand('sshManager.connectTerminal', node);
        return false;
      case 'fixPermissions':
        if (!fix.arg) {
          return false;
        }
        try {
          fs.chmodSync(fix.arg, 0o600);
          return true;
        } catch (e: any) {
          vscode.window.showErrorMessage(`SSH Config Manager: could not change the permissions: ${e?.message ?? e}`);
          return false;
        }
      case 'identitiesOnly':
        if (!host || host.readonly) {
          return false;
        }
        return this.store.mutate(doc => {
          const fresh = doc.hosts.find(h => h.id === host.id) ?? host;
          return updateHost(doc, fresh.id, { ...hostToForm(doc, fresh), identitiesOnly: 'yes' });
        });
      case 'addToAgent': {
        if (!fix.arg) {
          return false;
        }
        const keychain = process.platform === 'darwin' ? '--apple-use-keychain ' : '';
        await this.runLocal(`${alias}: add key`, `ssh-add ${keychain}${quote(fix.arg)}`);
        vscode.window.showInformationMessage('Type the key’s passphrase in the terminal. Then press "Test Again".');
        return false;
      }
      case 'forgetHostKey': {
        if (!fix.arg) {
          return false;
        }
        const ok = await vscode.window.showWarningMessage(
          `Forget the stored key of ${fix.arg}?`,
          {
            modal: true,
            detail:
              'Do this only if you know why the server’s key changed, for example it was reinstalled or the address now belongs to another machine.\n\n' +
              'If you did not expect a change, someone may be intercepting the connection: stop and check with whoever runs the server.\n\n' +
              'After forgetting it, the next connection asks you to confirm the new fingerprint.',
          },
          'Forget the Old Key',
        );
        if (!ok) {
          return false;
        }
        const r = await realDeps().exec('ssh-keygen', ['-R', fix.arg], 8000);
        if (r.code !== 0) {
          vscode.window.showErrorMessage(`SSH Config Manager: could not remove the key: ${(r.stderr || r.error || '').trim()}`);
          return false;
        }
        return true;
      }
    }
    return false;
  }

  dispose(): void {
    for (const { panel } of this.open.values()) {
      panel.dispose();
    }
    this.open.clear();
  }
}
