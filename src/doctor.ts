/**
 * The connection doctor: finds out why a host does not connect, one step at a time, and says
 * what to do about it. It uses the system's own ssh, ssh-add and ssh-keygen, so the answer is
 * what ssh itself will do, including ProxyJump, Match blocks and Include files.
 *
 * Nothing is stored and nothing leaves the computer except the connection attempt to the host
 * itself, which is made only when the user asks for the test.
 *
 * Free of the vscode API. Everything that touches the outside world goes through `DoctorDeps`,
 * so the diagnosis can be tested with canned answers.
 */
import * as path from 'path';

export type StepStatus = 'ok' | 'warn' | 'fail' | 'skip';

export type FixId = 'setupKey' | 'editHost' | 'openConfig' | 'fixPermissions' | 'forgetHostKey' | 'identitiesOnly' | 'addToAgent' | 'terminal';

export interface Fix {
  id: FixId;
  label: string;
  /** a file path or a host-key name, depending on the fix */
  arg?: string;
}

export interface Step {
  id: 'config' | 'dns' | 'port' | 'keys' | 'agent' | 'hostkey' | 'login';
  title: string;
  status: StepStatus;
  /** one or two plain sentences: what was found and what it means */
  detail: string;
  fixes?: Fix[];
}

export interface ExecResult {
  /** exit code; undefined when the program could not be started or was killed by the timeout */
  code: number | undefined;
  stdout: string;
  stderr: string;
  /** 'ENOENT' when the program is not installed, 'TIMEOUT' when it ran too long */
  error?: string;
}

export interface DoctorDeps {
  platform: string;
  home: string;
  exec(cmd: string, args: string[], timeoutMs: number): Promise<ExecResult>;
  /** resolves to an address, or rejects with an error that has a `code` */
  lookup(host: string): Promise<string>;
  /** resolves when a TCP connection opens, rejects with an error that has a `code` ('ETIMEDOUT' on timeout) */
  connect(host: string, port: number, timeoutMs: number): Promise<void>;
  exists(file: string): boolean;
  /** permission bits of a file (0 when unknown) */
  mode(file: string): number;
  /** first bytes of a file as text ('' when unreadable) */
  head(file: string, bytes: number): string;
}

export interface DoctorInput {
  /** the name to give ssh */
  alias: string;
  /** `-F <file>` when ssh would not read this config on its own */
  configFile?: string;
  /** IdentityFile values written for this host in the config (not ssh's defaults) */
  identityFiles: string[];
}

// ---------------------------------------------------------------- reading ssh's answers

/** `ssh -G` output as a map of lower-case keyword to its values (a keyword can repeat). */
export function parseEffective(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\S+)\s+(.*)$/.exec(line.trim());
    if (m) {
      const key = m[1].toLowerCase();
      out.set(key, [...(out.get(key) ?? []), m[2]]);
    }
  }
  return out;
}

const first = (m: Map<string, string[]>, key: string) => m.get(key)?.[0] ?? '';
const isIp = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.includes(':');

/** The name a host is stored under in known_hosts: `host`, or `[host]:port` off the standard port. */
export function knownHostsName(hostName: string, port: number, hostKeyAlias = ''): string {
  if (hostKeyAlias) {
    return hostKeyAlias;
  }
  return port === 22 ? hostName : `[${hostName}]:${port}`;
}

/** Whether a private key file is protected by a passphrase, from the start of the file. */
export function keyIsEncrypted(head: string): boolean {
  if (/Proc-Type:\s*4,ENCRYPTED|BEGIN ENCRYPTED PRIVATE KEY/.test(head)) {
    return true;
  }
  const m = /-----BEGIN OPENSSH PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+)/.exec(head);
  if (!m) {
    return false;
  }
  // the unencrypted header names its cipher: "none" for a key without a passphrase
  const start = Buffer.from(m[1].replace(/\s+/g, '').slice(0, 96), 'base64').toString('latin1');
  return start.startsWith('openssh-key-v1') && !start.includes('none');
}

function expand(p: string, home: string): string {
  const t = p.replace(/^"|"$/g, '');
  return path.resolve(home, '.ssh', t === '~' || t.startsWith('~/') ? path.join(home, t.slice(1)) : t);
}

const tidy = (p: string, home: string) => (p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p);

/**
 * What a failed (or successful) test login means. `stderr` is the output of `ssh -v` run with
 * BatchMode, so ssh could not ask for anything: every question it would have asked shows up as
 * a failure here, which is exactly what a GUI such as Remote-SSH runs into.
 */
export function classifyLogin(
  r: ExecResult,
  ctx: { alias: string; user: string; knownName: string; identitiesOnly: boolean; /** a passphrase-protected key that is not in the agent */ lockedKey?: string },
): Step {
  const out = r.stderr + '\n' + r.stdout;
  const step = (status: StepStatus, detail: string, fixes?: Fix[]): Step => ({ id: 'login', title: 'Log in with a key', status, detail, fixes });
  const terminal: Fix = { id: 'terminal', label: 'Connect in Terminal' };
  const offered = [...out.matchAll(/Offering public key: (\S+)/g)].map(m => path.basename(m[1]));
  const offeredText = offered.length ? ` Keys tried: ${[...new Set(offered)].join(', ')}.` : ' No key was offered to the server.';

  if (/Authenticated to |Authentication succeeded/.test(out) || r.code === 0) {
    return step('ok', `Logged in as ${ctx.user || 'you'} with a key, without being asked for anything. This host is ready for the terminal and for Remote-SSH.`);
  }
  if (r.error === 'ENOENT') {
    return step('fail', 'The ssh program was not found on this computer. Install the OpenSSH client and try again.');
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/.test(out)) {
    return step(
      'fail',
      'The server’s identity is different from the one this computer remembers. That is normal after the server was reinstalled or its address was reused, but it is also what an attack looks like. Only forget the old key if you know why it changed.',
      [{ id: 'forgetHostKey', label: 'Forget the Old Host Key…', arg: ctx.knownName }],
    );
  }
  if (/Host key verification failed|No \S+ host key is known/.test(out)) {
    return step(
      'warn',
      'This computer has never connected to the server, so it has not confirmed the server’s identity yet. Connect once in a terminal and answer "yes" after checking the fingerprint; after that it will not ask again.',
      [terminal],
    );
  }
  if (/UNPROTECTED PRIVATE KEY FILE|bad permissions/i.test(out)) {
    const file = /Permissions \d+ for '([^']+)'/.exec(out)?.[1];
    return step('fail', 'ssh refuses to use a key file that other users of this computer can read.', file ? [{ id: 'fixPermissions', label: 'Make the Key Private', arg: file }] : undefined);
  }
  if (/Bad owner or permissions on/.test(out)) {
    return step('fail', 'ssh refuses to read the config file because other users can change it. Make it writable by you only (chmod 600).', [{ id: 'openConfig', label: 'Open Config File' }]);
  }
  if (/Too many authentication failures/.test(out)) {
    return step(
      'fail',
      'The server hung up because ssh tried too many keys before the right one. Tell ssh to use only the key written for this host.',
      ctx.identitiesOnly ? [{ id: 'editHost', label: 'Edit Host' }] : [{ id: 'identitiesOnly', label: 'Use Only This Host’s Key' }, { id: 'editHost', label: 'Edit Host' }],
    );
  }
  if (/agent refused operation|signing failed/.test(out)) {
    return step('fail', 'The key is in your SSH agent, but the agent refused to use it. If the key lives in 1Password, Bitwarden or on a hardware key, unlock it or approve the request and try again.', [terminal]);
  }
  // The server said yes to a key, and the login still failed: ssh could not use the key itself.
  // In this test that means it needs a passphrase, which ssh was not allowed to ask for.
  if (/Permission denied \(/.test(out) && (/Server accepts key/.test(out) || ctx.lockedKey)) {
    const accepted = /Server accepts key: (\S+)/.exec(out)?.[1];
    const name = path.basename(ctx.lockedKey ?? accepted ?? 'your key');
    return step(
      'warn',
      `The server ${/Server accepts key/.test(out) ? 'accepts' : 'may well accept'} ${name}, but the key is protected by a passphrase and ssh could not ask for it here. This is why Remote-SSH fails or keeps asking for a password. Add the key to your SSH agent once, then test again.`,
      ctx.lockedKey ? [{ id: 'addToAgent', label: 'Add Key to Agent', arg: ctx.lockedKey }, terminal] : [terminal],
    );
  }
  if (/Permission denied \(/.test(out)) {
    const methods = /Permission denied \(([^)]+)\)/.exec(out)?.[1] ?? '';
    const password = /password|keyboard-interactive/.test(methods);
    return step(
      'fail',
      `The server answered but did not accept any of your keys${ctx.user ? ` for the user "${ctx.user}"` : ''}.${offeredText} ` +
        (password
          ? 'It does accept a password, so you can install a key on it now with your password.'
          : 'It accepts keys only, so someone with access has to add your public key to the server, or the user name is wrong.'),
      password ? [{ id: 'setupKey', label: 'Set Up SSH Key…' }, { id: 'editHost', label: 'Edit Host' }] : [{ id: 'editHost', label: 'Edit Host' }],
    );
  }
  if (/Could not resolve hostname/.test(out)) {
    return step('fail', 'The server name could not be found. Check HostName, or whether a VPN or Tailscale needs to be on.', [{ id: 'editHost', label: 'Edit Host' }]);
  }
  if (/Connection refused/.test(out)) {
    return step('fail', 'The server (or the jump host) refused the connection: nothing is listening on that port. Check the port, and that the SSH server is running.', [{ id: 'editHost', label: 'Edit Host' }]);
  }
  if (r.error === 'TIMEOUT' || /timed out|Operation timed out|No route to host|Network is unreachable/i.test(out)) {
    return step('fail', 'No answer from the server. It may be off, a firewall may be blocking you, or a VPN you need may be off.', [{ id: 'editHost', label: 'Edit Host' }]);
  }
  if (/kex_exchange_identification|Connection closed by|Connection reset by/.test(out)) {
    return step('fail', 'The server closed the connection before the login started. It may be limiting connections from your address (too many attempts), or a jump host in between failed.', [terminal]);
  }
  if (/Bad configuration option|terminating, \d+ bad configuration options/.test(out)) {
    const where = /line (\d+)/.exec(out)?.[1];
    return step('fail', `ssh does not understand an option in your config file${where ? ` (line ${where})` : ''}.`, [{ id: 'openConfig', label: 'Open Config File' }]);
  }
  if (/no matching (host key type|key exchange method|cipher)/i.test(out)) {
    return step('fail', 'This computer and the server have no encryption method in common. The server is probably very old; it needs an explicit option such as HostKeyAlgorithms or KexAlgorithms for this host.', [{ id: 'editHost', label: 'Edit Host' }]);
  }
  const last = out.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('debug')).pop() ?? '';
  return step('fail', `The login did not work${last ? `: ${last}` : '.'} Try it in a terminal to see the full conversation.`, [terminal]);
}

// ---------------------------------------------------------------- the checks

/**
 * Runs the checks in order and reports each one through `report` as soon as it is known.
 * Local checks (keys, agent) run even when the server cannot be reached, so one test shows
 * everything that is wrong, not only the first thing.
 */
export async function runDoctor(input: DoctorInput, deps: DoctorDeps, report: (step: Step) => void): Promise<Step[]> {
  const steps: Step[] = [];
  const add = (s: Step) => {
    steps.push(s);
    report(s);
    return s;
  };
  const cfg = input.configFile ? ['-F', input.configFile] : [];
  const editHost: Fix = { id: 'editHost', label: 'Edit Host' };

  // 1. what ssh makes of this host
  const g = await deps.exec('ssh', ['-G', ...cfg, input.alias], 8000);
  if (g.error === 'ENOENT') {
    add({ id: 'config', title: 'Read the ssh config', status: 'fail', detail: 'The ssh program was not found on this computer. Install the OpenSSH client (on Windows: Settings → Optional features → OpenSSH Client) and try again.' });
    return steps;
  }
  if (g.code !== 0) {
    const line = (g.stderr.trim().split(/\r?\n/)[0] ?? '').trim();
    add({ id: 'config', title: 'Read the ssh config', status: 'fail', detail: `ssh cannot read your config${line ? `: ${line}` : '.'}`, fixes: [{ id: 'openConfig', label: 'Open Config File' }] });
    return steps;
  }
  const eff = parseEffective(g.stdout);
  const hostName = first(eff, 'hostname') || input.alias;
  const user = first(eff, 'user');
  const port = Number(first(eff, 'port')) || 22;
  const jump = first(eff, 'proxyjump');
  const proxyCommand = first(eff, 'proxycommand');
  const viaProxy = (!!jump && jump !== 'none') || (!!proxyCommand && proxyCommand !== 'none');
  const knownName = knownHostsName(hostName, port, first(eff, 'hostkeyalias'));
  add({
    id: 'config',
    title: 'Read the ssh config',
    status: 'ok',
    detail: `ssh will connect to ${user ? user + '@' : ''}${hostName}${port === 22 ? '' : ' on port ' + port}${viaProxy ? (jump && jump !== 'none' ? `, through the jump host ${jump}` : ', through a proxy command') : ''}.`,
  });

  // 2 + 3. can this computer reach it (only meaningful for a direct connection)
  let reachable = true;
  if (viaProxy) {
    add({ id: 'dns', title: 'Find the server', status: 'skip', detail: 'Not checked from here: the server is reached through the jump host, so the name only has to be known there.' });
    add({ id: 'port', title: 'Reach the SSH port', status: 'skip', detail: 'Not checked from here for the same reason. The login test below goes through the jump host.' });
  } else {
    let address = hostName;
    if (isIp(hostName)) {
      add({ id: 'dns', title: 'Find the server', status: 'ok', detail: `${hostName} is an address, so there is no name to look up.` });
    } else {
      try {
        address = await deps.lookup(hostName);
        add({ id: 'dns', title: 'Find the server', status: 'ok', detail: `${hostName} is ${address}.` });
      } catch {
        reachable = false;
        add({ id: 'dns', title: 'Find the server', status: 'fail', detail: `The name ${hostName} could not be found. Check HostName for a typo, or whether a VPN or Tailscale has to be on for this name to exist.`, fixes: [editHost] });
      }
    }
    if (!reachable) {
      add({ id: 'port', title: 'Reach the SSH port', status: 'skip', detail: 'Skipped: the server was not found.' });
    } else {
      try {
        await deps.connect(address, port, 5000);
        add({ id: 'port', title: 'Reach the SSH port', status: 'ok', detail: `Port ${port} answers.` });
      } catch (e: any) {
        reachable = false;
        const code = String(e?.code ?? '');
        const why =
          code === 'ECONNREFUSED'
            ? `The server is there, but nothing is listening on port ${port}. Check the port number, and that the SSH server is running.`
            : code === 'EHOSTUNREACH' || code === 'ENETUNREACH'
              ? 'There is no network route to the server. Check your connection, or whether a VPN or Tailscale has to be on.'
              : `No answer on port ${port} within 5 seconds. The server may be off, a firewall may be blocking you, or a VPN you need may be off.`;
        add({ id: 'port', title: 'Reach the SSH port', status: 'fail', detail: why, fixes: [editHost] });
      }
    }
  }

  // 4. the key files this host names
  const posix = deps.platform !== 'win32';
  const named = input.identityFiles.filter(f => f && !f.includes('%') && f.toLowerCase() !== 'none').map(f => expand(f, deps.home));
  const present = named.filter(f => deps.exists(f));
  const open = posix ? present.filter(f => (deps.mode(f) & 0o077) !== 0) : [];
  const encrypted = present.filter(f => keyIsEncrypted(deps.head(f, 600)));
  const defaults = ['id_ed25519', 'id_ecdsa', 'id_rsa'].map(n => path.join(deps.home, '.ssh', n)).filter(f => deps.exists(f));
  if (named.length && !present.length) {
    add({
      id: 'keys',
      title: 'Check the key file',
      status: 'fail',
      detail: `The key this host names is not on this computer: ${named.map(f => tidy(f, deps.home)).join(', ')}. Copy it here, or set up a new one.`,
      fixes: [{ id: 'setupKey', label: 'Set Up SSH Key…' }, editHost],
    });
  } else if (open.length) {
    add({
      id: 'keys',
      title: 'Check the key file',
      status: 'fail',
      detail: `${tidy(open[0], deps.home)} can be read by other users of this computer, and ssh refuses to use a key like that.`,
      fixes: [{ id: 'fixPermissions', label: 'Make the Key Private', arg: open[0] }],
    });
  } else if (named.length) {
    add({ id: 'keys', title: 'Check the key file', status: 'ok', detail: `${tidy(present[0], deps.home)} is here and private${present.length > 1 ? ` (and ${present.length - 1} more)` : ''}.` });
  } else if (defaults.length) {
    add({ id: 'keys', title: 'Check the key file', status: 'ok', detail: `This host names no key, so ssh tries your default key ${tidy(defaults[0], deps.home)} and the keys in your agent.` });
  } else {
    add({ id: 'keys', title: 'Check the key file', status: 'warn', detail: 'This host names no key and you have no default key in ~/.ssh. Unless your agent holds one, ssh has nothing to log in with.', fixes: [{ id: 'setupKey', label: 'Set Up SSH Key…' }] });
  }

  // 5. the agent, which answers for keys that have a passphrase
  const identityAgent = first(eff, 'identityagent');
  const customAgent = !!identityAgent && !['none', 'ssh_auth_sock'].includes(identityAgent.toLowerCase());
  const a = await deps.exec('ssh-add', ['-l'], 6000);
  const agentKeys = a.code === 0 ? a.stdout.split(/\r?\n/).filter(l => l.trim()).length : 0;
  const locked = encrypted[0];
  if (customAgent) {
    const socket = expand(identityAgent, deps.home);
    const there = !posix || deps.exists(socket);
    add({
      id: 'agent',
      title: 'Check the SSH agent',
      status: there ? 'ok' : 'fail',
      detail: there
        ? `This host uses its own agent (${tidy(socket, deps.home)}), for example 1Password or Bitwarden. It is running.`
        : `This host uses the agent at ${tidy(socket, deps.home)}, but nothing is there. Start the app that provides it (1Password, Bitwarden, Secretive, …) and turn its SSH agent on.`,
      fixes: there ? undefined : [editHost],
    });
  } else if (locked && agentKeys === 0) {
    add({
      id: 'agent',
      title: 'Check the SSH agent',
      status: 'warn',
      detail: `${tidy(locked, deps.home)} is protected by a passphrase and is not loaded in your SSH agent. A terminal can ask you for the passphrase, but Remote-SSH cannot, so it fails or keeps asking for a password. Add the key to the agent once.`,
      fixes: [{ id: 'addToAgent', label: 'Add Key to Agent', arg: locked }],
    });
  } else if (a.error === 'ENOENT') {
    add({ id: 'agent', title: 'Check the SSH agent', status: 'skip', detail: 'ssh-add was not found, so the agent could not be checked.' });
  } else {
    add({
      id: 'agent',
      title: 'Check the SSH agent',
      status: 'ok',
      detail: agentKeys ? `Your agent is running and holds ${agentKeys} key${agentKeys === 1 ? '' : 's'}.` : a.code === 1 ? 'Your agent is running and empty, which is fine for a key without a passphrase.' : 'No agent is running, which is fine for a key without a passphrase.',
    });
  }

  // 6. does this computer already trust the server
  const strict = first(eff, 'stricthostkeychecking').toLowerCase();
  if (!reachable) {
    add({ id: 'hostkey', title: 'Check the server\u2019s identity', status: 'skip', detail: 'Skipped: the server could not be reached.' });
  } else if (strict === 'no' || strict === 'off') {
    add({ id: 'hostkey', title: 'Check the server’s identity', status: 'warn', detail: 'StrictHostKeyChecking is off for this host, so ssh connects without checking who answers. Anyone between you and the server could pretend to be it.', fixes: [editHost] });
  } else {
    // the files this host keeps server keys in (UserKnownHostsFile can name its own)
    const files = (first(eff, 'userknownhostsfile').match(/"[^"]*"|\S+/g) ?? []).filter(f => !f.includes('%')).map(f => expand(f, deps.home));
    let k = await deps.exec('ssh-keygen', ['-F', knownName], 6000);
    for (const file of files) {
      if (k.error === 'ENOENT' || (k.code === 0 && /found/i.test(k.stdout))) {
        break;
      }
      if (deps.exists(file)) {
        k = await deps.exec('ssh-keygen', ['-F', knownName, '-f', file], 6000);
      }
    }
    if (k.error === 'ENOENT') {
      add({ id: 'hostkey', title: 'Check the server’s identity', status: 'skip', detail: 'ssh-keygen was not found, so known_hosts could not be checked.' });
    } else if (k.code === 0 && /found/i.test(k.stdout)) {
      add({ id: 'hostkey', title: 'Check the server’s identity', status: 'ok', detail: 'This computer has connected to the server before and remembers its key.' });
    } else {
      add({
        id: 'hostkey',
        title: 'Check the server’s identity',
        status: 'warn',
        detail: 'This computer has not connected to the server before. The first connection asks you to confirm the server’s fingerprint; Remote-SSH shows that question too, but a first connection in the terminal is the clearest place to answer it.',
        fixes: [{ id: 'terminal', label: 'Connect in Terminal' }],
      });
    }
  }

  // 7. the real thing: a login that is not allowed to ask for anything
  if (!reachable) {
    add({ id: 'login', title: 'Log in with a key', status: 'skip', detail: 'Skipped: the server could not be reached.' });
    return steps;
  }
  const probe = await deps.exec(
    'ssh',
    [...cfg, '-v', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'RemoteCommand=none', input.alias, 'exit'],
    25000,
  );
  add(classifyLogin(probe, { alias: input.alias, user, knownName, identitiesOnly: first(eff, 'identitiesonly') === 'yes', lockedKey: locked && agentKeys === 0 && !customAgent ? locked : undefined }));
  return steps;
}

const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

/** One sentence for the top of the result. */
export function verdict(steps: Step[]): { status: StepStatus; text: string } {
  const failed = steps.find(s => s.status === 'fail');
  if (failed) {
    return { status: 'fail', text: `Problem found: ${lowerFirst(failed.title)}.` };
  }
  const login = steps.find(s => s.id === 'login');
  const warned = steps.filter(s => s.status === 'warn');
  if (login?.status === 'ok') {
    return warned.length
      ? { status: 'warn', text: `It connects. ${warned.length === 1 ? 'One thing is' : warned.length + ' things are'} worth a look.` }
      : { status: 'ok', text: 'Everything checks out. This host connects with a key.' };
  }
  if (warned.length) {
    return { status: 'warn', text: `Not connected yet: ${lowerFirst(warned[0].title)}.` };
  }
  return { status: 'skip', text: 'The test could not be completed.' };
}

/** Plain-text report for the clipboard (for a bug report or a colleague). No key material is included. */
export function reportText(alias: string, steps: Step[]): string {
  const mark = { ok: '[ok]  ', warn: '[warn]', fail: '[FAIL]', skip: '[skip]' };
  return [`Connection test: ${alias}`, verdict(steps).text, '', ...steps.map(s => `${mark[s.status]} ${s.title}\n       ${s.detail}`)].join('\n');
}
