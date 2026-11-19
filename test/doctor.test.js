// Plain-node tests for the connection doctor: every outside answer is canned, so each kind of
// failure can be shown to produce the right diagnosis and the right fix.  npm test
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const d = require('../out/doctor');

let n = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const HOME = path.join(path.sep, 'home', 'me');
const KEY = path.join(HOME, '.ssh', 'id_ed25519_web');
const PLAIN_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\n' + Buffer.concat([Buffer.from('openssh-key-v1\0'), Buffer.from([0, 0, 0, 4]), Buffer.from('none'), Buffer.from([0, 0, 0, 4]), Buffer.from('none')]).toString('base64') + '\n';
const LOCKED_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\n' + Buffer.concat([Buffer.from('openssh-key-v1\0'), Buffer.from([0, 0, 0, 10]), Buffer.from('aes256-ctr'), Buffer.from([0, 0, 0, 6]), Buffer.from('bcrypt')]).toString('base64') + '\n';

const G = (extra = '') => `hostname 203.0.113.21\nuser deploy\nport 22\nidentityfile ~/.ssh/id_rsa\nproxyjump none\n${extra}`;
const VERBOSE_OK = 'debug1: Offering public key: /home/me/.ssh/id_ed25519_web ED25519\nAuthenticated to 203.0.113.21 ([203.0.113.21]:22) using "publickey".\n';

/** A world where everything works; each test breaks one thing. */
function world(over = {}) {
  const calls = [];
  const w = {
    platform: 'linux',
    home: HOME,
    files: { [KEY]: { mode: 0o600, head: PLAIN_KEY } },
    ssh: { '-G': { code: 0, stdout: G(), stderr: '' }, probe: { code: 0, stdout: '', stderr: VERBOSE_OK } },
    sshAdd: { code: 1, stdout: 'The agent has no identities.\n', stderr: '' },
    keygen: { code: 0, stdout: '# Host 203.0.113.21 found: line 3\n', stderr: '' },
    lookup: async () => '203.0.113.21',
    connect: async () => undefined,
    ...over,
  };
  const deps = {
    platform: w.platform,
    home: w.home,
    exec: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'ssh') return args.includes('-G') ? w.ssh['-G'] : w.ssh.probe;
      if (cmd === 'ssh-add') return w.sshAdd;
      return w.keygen;
    },
    lookup: w.lookup,
    connect: w.connect,
    exists: f => f in w.files,
    mode: f => w.files[f]?.mode ?? 0,
    head: f => w.files[f]?.head ?? '',
  };
  return { deps, calls };
}
const run = async (over, input = {}) => {
  const { deps, calls } = world(over);
  const seen = [];
  const steps = await d.runDoctor({ alias: 'store-web-1', identityFiles: ['~/.ssh/id_ed25519_web'], ...input }, deps, s => seen.push(s.id));
  return { steps, calls, seen, by: id => steps.find(s => s.id === id) };
};
const fail = (code) => Object.assign(new Error(code), { code });

test('reads ssh -G output, known_hosts names and passphrase-protected keys', () => {
  const e = d.parseEffective('hostname example.com\nPort 2222\nidentityfile ~/.ssh/a\nidentityfile ~/.ssh/b\n\nproxyjump none\n');
  assert.deepStrictEqual(e.get('identityfile'), ['~/.ssh/a', '~/.ssh/b']);
  assert.deepStrictEqual(e.get('port'), ['2222'], 'keywords are compared without case');
  assert.strictEqual(d.knownHostsName('example.com', 22), 'example.com');
  assert.strictEqual(d.knownHostsName('example.com', 2222), '[example.com]:2222');
  assert.strictEqual(d.knownHostsName('example.com', 2222, 'web'), 'web', 'HostKeyAlias wins');
  assert.strictEqual(d.keyIsEncrypted(PLAIN_KEY), false);
  assert.strictEqual(d.keyIsEncrypted(LOCKED_KEY), true);
  assert.strictEqual(d.keyIsEncrypted('-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,AB\n'), true, 'old PEM format');
  assert.strictEqual(d.keyIsEncrypted('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n'), false);
  assert.strictEqual(d.keyIsEncrypted(''), false);
});

test('all good: seven steps in order, a real login, nothing to fix', async () => {
  const { steps, calls, seen } = await run();
  assert.deepStrictEqual(seen, ['config', 'dns', 'port', 'keys', 'agent', 'hostkey', 'login'], 'reported as each one finishes');
  assert.deepStrictEqual(steps.map(s => s.status), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  assert.ok(steps[0].detail.includes('deploy@203.0.113.21'));
  assert.ok(steps.every(s => !s.fixes));
  assert.deepStrictEqual(d.verdict(steps), { status: 'ok', text: 'Everything checks out. This host connects with a key.' });
  const probe = calls.find(c => c[0] === 'ssh' && !c.includes('-G'));
  assert.ok(probe.includes('BatchMode=yes'), 'the test login can never ask for a password or passphrase');
  assert.ok(probe.includes('ControlPath=none') && probe.includes('RemoteCommand=none'), 'a fresh connection, and no clash with a RemoteCommand');
  assert.deepStrictEqual(probe.slice(-2), ['store-web-1', 'exit']);
  assert.ok(!probe.some(a => /StrictHostKeyChecking/i.test(a)), 'it never changes how host keys are trusted');
  assert.deepStrictEqual(calls.find(c => c[0] === 'ssh-keygen'), ['ssh-keygen', '-F', '203.0.113.21']);
});

test('a config outside ~/.ssh/config is passed to every ssh call', async () => {
  const { calls } = await run({}, { configFile: '/shared/ssh config' });
  for (const c of calls.filter(x => x[0] === 'ssh')) {
    assert.deepStrictEqual(c.slice(c.indexOf('-F'), c.indexOf('-F') + 2), ['-F', '/shared/ssh config']);
  }
});

test('ssh missing, or a config ssh cannot read: stop there and say so', async () => {
  let r = await run({ ssh: { '-G': { code: undefined, stdout: '', stderr: '', error: 'ENOENT' } } });
  assert.deepStrictEqual(r.steps.map(s => [s.id, s.status]), [['config', 'fail']]);
  assert.ok(/not found/.test(r.steps[0].detail));
  r = await run({ ssh: { '-G': { code: 255, stdout: '', stderr: '/home/me/.ssh/config: line 12: Bad configuration option: hostnme\n' } } });
  assert.strictEqual(r.steps.length, 1);
  assert.ok(r.steps[0].detail.includes('line 12: Bad configuration option: hostnme'));
  assert.deepStrictEqual(r.steps[0].fixes.map(f => f.id), ['openConfig']);
});

test('name not found: port and login are skipped, local checks still run', async () => {
  const r = await run({ ssh: { '-G': { code: 0, stdout: G().replace('203.0.113.21', 'web.example.test'), stderr: '' }, probe: {} }, lookup: async () => { throw fail('ENOTFOUND'); } });
  assert.deepStrictEqual(r.steps.map(s => [s.id, s.status]), [['config', 'ok'], ['dns', 'fail'], ['port', 'skip'], ['keys', 'ok'], ['agent', 'ok'], ['hostkey', 'skip'], ['login', 'skip']]);
  assert.ok(!r.calls.some(c => c[0] === 'ssh-keygen'), 'no point asking about the identity of a server that cannot be reached');
  assert.ok(!r.calls.some(c => c[0] === 'ssh' && !c.includes('-G')), 'no login attempt against a server that was not found');
  assert.strictEqual(d.verdict(r.steps).text, 'Problem found: find the server.');
});

test('port: refused, unreachable and silent each get their own explanation', async () => {
  const detail = async code => (await run({ connect: async () => { throw fail(code); } })).by('port');
  assert.ok(/nothing is listening on port 22/.test((await detail('ECONNREFUSED')).detail));
  assert.ok(/no network route/.test((await detail('EHOSTUNREACH')).detail));
  const silent = await detail('ETIMEDOUT');
  assert.ok(/No answer on port 22/.test(silent.detail) && silent.status === 'fail');
  const r = await run({ connect: async () => { throw fail('ETIMEDOUT'); } });
  assert.strictEqual(r.by('login').status, 'skip');
});

test('jump host: reachability is not judged from here, the login test goes through it', async () => {
  const r = await run({ ssh: { '-G': { code: 0, stdout: G().replace('proxyjump none', 'proxyjump store-bastion'), stderr: '' }, probe: { code: 0, stdout: '', stderr: VERBOSE_OK } }, lookup: async () => { throw fail('ENOTFOUND'); } });
  assert.deepStrictEqual([r.by('dns').status, r.by('port').status, r.by('login').status], ['skip', 'skip', 'ok']);
  assert.ok(r.by('config').detail.includes('through the jump host store-bastion'));
});

test('keys: missing, readable by others, none named', async () => {
  let r = await run({ files: {} });
  assert.strictEqual(r.by('keys').status, 'fail');
  assert.ok(r.by('keys').detail.includes('~/.ssh/id_ed25519_web'), 'shown with ~, not the full home path');
  assert.deepStrictEqual(r.by('keys').fixes.map(f => f.id), ['setupKey', 'editHost']);

  r = await run({ files: { [KEY]: { mode: 0o644, head: PLAIN_KEY } } });
  assert.strictEqual(r.by('keys').status, 'fail');
  assert.deepStrictEqual(r.by('keys').fixes, [{ id: 'fixPermissions', label: 'Make the Key Private', arg: KEY }]);
  r = await run({ platform: 'win32', files: { [KEY]: { mode: 0o644, head: PLAIN_KEY } } });
  assert.strictEqual(r.by('keys').status, 'ok', 'Windows permissions are not POSIX bits');

  const def = path.join(HOME, '.ssh', 'id_ed25519');
  r = await run({ files: { [def]: { mode: 0o600, head: PLAIN_KEY } } }, { identityFiles: [] });
  assert.ok(r.by('keys').status === 'ok' && r.by('keys').detail.includes('~/.ssh/id_ed25519'));
  r = await run({ files: {} }, { identityFiles: [] });
  assert.strictEqual(r.by('keys').status, 'warn');

  r = await run({ files: { [KEY]: { mode: 0o600, head: PLAIN_KEY } } }, { identityFiles: ['~/.ssh/gone', '~/.ssh/id_ed25519_web', '~/.ssh/%h_key'] });
  assert.strictEqual(r.by('keys').status, 'ok', 'one present key is enough; token paths are not checked');
});

test('agent: a passphrase key that is not loaded is the "keeps asking for a password" case', async () => {
  let r = await run({ files: { [KEY]: { mode: 0o600, head: LOCKED_KEY } } });
  assert.strictEqual(r.by('agent').status, 'warn');
  assert.ok(/passphrase/.test(r.by('agent').detail) && /Remote-SSH cannot/.test(r.by('agent').detail));
  assert.deepStrictEqual(r.by('agent').fixes, [{ id: 'addToAgent', label: 'Add Key to Agent', arg: KEY }]);

  r = await run({ files: { [KEY]: { mode: 0o600, head: LOCKED_KEY } }, sshAdd: { code: 0, stdout: '256 SHA256:abc me (ED25519)\n', stderr: '' } });
  assert.strictEqual(r.by('agent').status, 'ok', 'loaded in the agent: fine');
  assert.ok(r.by('agent').detail.includes('holds 1 key'));

  r = await run({ sshAdd: { code: 2, stdout: '', stderr: 'Could not open a connection to your authentication agent.\n' } });
  assert.ok(r.by('agent').status === 'ok' && /No agent is running/.test(r.by('agent').detail));

  const sock = path.join(HOME, '.1password', 'agent.sock');
  const withAgent = { code: 0, stdout: G('identityagent ~/.1password/agent.sock\n'), stderr: '' };
  r = await run({ ssh: { '-G': withAgent, probe: { code: 0, stdout: '', stderr: VERBOSE_OK } } });
  assert.strictEqual(r.by('agent').status, 'fail');
  assert.ok(r.by('agent').detail.includes('~/.1password/agent.sock') && /1Password/.test(r.by('agent').detail));
  r = await run({ ssh: { '-G': withAgent, probe: { code: 0, stdout: '', stderr: VERBOSE_OK } }, files: { [KEY]: { mode: 0o600, head: PLAIN_KEY }, [sock]: { mode: 0o600, head: '' } } });
  assert.strictEqual(r.by('agent').status, 'ok');
});

test('a passphrase key the server accepts is reported as locked, not as rejected', async () => {
  const denied = { code: 255, stdout: '', stderr: 'debug1: Offering public key: /home/me/.ssh/id_ed25519_web ED25519\ndebug1: Server accepts key: /home/me/.ssh/id_ed25519_web ED25519 SHA256:abc\nme@203.0.113.21: Permission denied (publickey).\n' };
  let r = await run({ files: { [KEY]: { mode: 0o600, head: LOCKED_KEY } }, ssh: { '-G': { code: 0, stdout: G(), stderr: '' }, probe: denied } });
  assert.strictEqual(r.by('login').status, 'warn');
  assert.ok(/accepts id_ed25519_web/.test(r.by('login').detail) && /passphrase/.test(r.by('login').detail));
  assert.deepStrictEqual(r.by('login').fixes.map(f => [f.id, f.arg]), [['addToAgent', KEY], ['terminal', undefined]]);
  assert.strictEqual(d.verdict(r.steps).status, 'warn', 'nothing is broken: one step is left to do');

  // same server answer with an unprotected key: something else is wrong with the key, say so plainly
  r = await run({ ssh: { '-G': { code: 0, stdout: G(), stderr: '' }, probe: denied } });
  assert.ok(r.by('login').status === 'warn' && /could not ask for it/.test(r.by('login').detail));
  assert.deepStrictEqual(r.by('login').fixes.map(f => f.id), ['terminal']);

  // and a locked key the server does not know at all still points at the agent first
  const unknown = { code: 255, stdout: '', stderr: 'me@203.0.113.21: Permission denied (publickey,password).\n' };
  r = await run({ files: { [KEY]: { mode: 0o600, head: LOCKED_KEY } }, ssh: { '-G': { code: 0, stdout: G(), stderr: '' }, probe: unknown } });
  assert.ok(/may well accept/.test(r.by('login').detail));
});

test('host key: unknown server, non-standard port, and checking switched off', async () => {
  let r = await run({ keygen: { code: 1, stdout: '', stderr: '' } });
  assert.strictEqual(r.by('hostkey').status, 'warn');
  assert.deepStrictEqual(r.by('hostkey').fixes.map(f => f.id), ['terminal']);

  r = await run({ ssh: { '-G': { code: 0, stdout: G().replace('port 22', 'port 2222'), stderr: '' }, probe: { code: 0, stdout: '', stderr: VERBOSE_OK } } });
  assert.deepStrictEqual(r.calls.find(c => c[0] === 'ssh-keygen'), ['ssh-keygen', '-F', '[203.0.113.21]:2222']);
  assert.ok(r.by('config').detail.includes('on port 2222'));

  // a host with its own known_hosts file: that file is asked too
  const own = path.join(HOME, 'work', 'known_hosts');
  const answers = [];
  const w = world({ ssh: { '-G': { code: 0, stdout: G('userknownhostsfile ~/work/known_hosts ~/.ssh/known_hosts2\n'), stderr: '' }, probe: { code: 0, stdout: '', stderr: VERBOSE_OK } }, files: { [KEY]: { mode: 0o600, head: PLAIN_KEY }, [own]: { mode: 0o600, head: '' } } });
  const baseExec = w.deps.exec;
  w.deps.exec = async (cmd, args) => {
    if (cmd !== 'ssh-keygen') return baseExec(cmd, args);
    answers.push(args);
    return args.includes('-f') ? { code: 0, stdout: '# Host 203.0.113.21 found: line 1\n', stderr: '' } : { code: 1, stdout: '', stderr: '' };
  };
  const own_steps = await d.runDoctor({ alias: 'store-web-1', identityFiles: ['~/.ssh/id_ed25519_web'] }, w.deps, () => {});
  assert.strictEqual(own_steps.find(s => s.id === 'hostkey').status, 'ok');
  assert.deepStrictEqual(answers, [['-F', '203.0.113.21'], ['-F', '203.0.113.21', '-f', own]], 'the default file first, then the host\u2019s own; files that do not exist are skipped');

  r = await run({ ssh: { '-G': { code: 0, stdout: G('stricthostkeychecking no\n'), stderr: '' }, probe: { code: 0, stdout: '', stderr: VERBOSE_OK } } });
  assert.strictEqual(r.by('hostkey').status, 'warn');
  assert.ok(/pretend to be it/.test(r.by('hostkey').detail));
  assert.ok(!r.calls.some(c => c[0] === 'ssh-keygen'));
  assert.strictEqual(d.verdict(r.steps).status, 'warn', 'it connects, but one thing is worth a look');
});

test('login: each ssh failure is turned into a cause and a fix', () => {
  const ctx = { alias: 'web', user: 'deploy', knownName: '[203.0.113.21]:2222', identitiesOnly: false };
  const c = (stderr, extra = {}) => d.classifyLogin({ code: 255, stdout: '', stderr, ...extra }, ctx);
  const ids = s => (s.fixes ?? []).map(f => f.id);

  let s = c('debug1: Offering public key: /home/me/.ssh/id_a ED25519\ndebug1: Offering public key: /home/me/.ssh/id_b RSA\ndeploy@203.0.113.21: Permission denied (publickey,password).\n');
  assert.strictEqual(s.status, 'fail');
  assert.ok(s.detail.includes('"deploy"') && s.detail.includes('Keys tried: id_a, id_b') && /accept a password/.test(s.detail));
  assert.deepStrictEqual(ids(s), ['setupKey', 'editHost']);

  s = c('deploy@203.0.113.21: Permission denied (publickey).\n');
  assert.ok(/No key was offered/.test(s.detail) && /keys only/.test(s.detail));
  assert.deepStrictEqual(ids(s), ['editHost'], 'no point offering a password-based key install');

  s = c('@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.\n');
  assert.strictEqual(s.status, 'fail');
  assert.ok(/attack/.test(s.detail), 'the risk is said out loud');
  assert.deepStrictEqual(s.fixes, [{ id: 'forgetHostKey', label: 'Forget the Old Host Key…', arg: '[203.0.113.21]:2222' }]);

  s = c('No ED25519 host key is known for 203.0.113.21 and you have requested strict checking.\nHost key verification failed.\n');
  assert.strictEqual(s.status, 'warn', 'a first connection is not an error');
  assert.deepStrictEqual(ids(s), ['terminal']);

  s = c("@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @\nPermissions 0644 for '/home/me/.ssh/id_a' are too open.\n");
  assert.deepStrictEqual(s.fixes, [{ id: 'fixPermissions', label: 'Make the Key Private', arg: '/home/me/.ssh/id_a' }]);

  s = c('Received disconnect from 203.0.113.21 port 22:2: Too many authentication failures\n');
  assert.deepStrictEqual(ids(s), ['identitiesOnly', 'editHost']);
  assert.deepStrictEqual(ids(d.classifyLogin({ code: 255, stdout: '', stderr: 'Too many authentication failures' }, { ...ctx, identitiesOnly: true })), ['editHost'], 'already set: do not offer it again');

  assert.ok(/agent refused/.test(c('sign_and_send_pubkey: signing failed for ED25519 "x" from agent: agent refused operation\n').detail));
  assert.ok(/could not be found/.test(c('ssh: Could not resolve hostname web.example.test: nodename nor servname provided\n').detail));
  assert.ok(/refused the connection/.test(c('ssh: connect to host 203.0.113.21 port 22: Connection refused\n').detail));
  assert.ok(/No answer/.test(c('ssh: connect to host 203.0.113.21 port 22: Operation timed out\n').detail));
  assert.ok(/No answer/.test(d.classifyLogin({ code: undefined, stdout: '', stderr: '', error: 'TIMEOUT' }, ctx).detail));
  assert.ok(/closed the connection/.test(c('kex_exchange_identification: Connection closed by remote host\n').detail));
  assert.ok(/line 7/.test(c('/home/me/.ssh/config: line 7: Bad configuration option: foo\n').detail));
  assert.ok(/no encryption method in common/.test(c('Unable to negotiate with 203.0.113.9 port 22: no matching host key type found. Their offer: ssh-rsa\n').detail));
  assert.ok(/not found/.test(d.classifyLogin({ code: undefined, stdout: '', stderr: '', error: 'ENOENT' }, ctx).detail));

  s = c('debug1: something\nsome new message from ssh\n');
  assert.ok(s.status === 'fail' && s.detail.includes('some new message from ssh'), 'unknown failures show ssh’s own last line');
  assert.deepStrictEqual(ids(s), ['terminal']);

  // servers that log you in but refuse commands (git hosts) still count as a working key
  s = d.classifyLogin({ code: 1, stdout: '', stderr: 'Authenticated to git.example.test ([203.0.113.5]:22) using "publickey".\nshell access is disabled\n' }, ctx);
  assert.strictEqual(s.status, 'ok');
});

test('the summary line and the copyable report', async () => {
  const r = await run({ files: {}, ssh: { '-G': { code: 0, stdout: G(), stderr: '' }, probe: { code: 255, stdout: '', stderr: 'deploy@203.0.113.21: Permission denied (publickey,password).\n' } } });
  assert.strictEqual(d.verdict(r.steps).text, 'Problem found: check the key file.', 'the first failing step is named');
  const text = d.reportText('store-web-1', r.steps);
  assert.ok(text.startsWith('Connection test: store-web-1\nProblem found: check the key file.\n'));
  assert.ok(text.includes('[FAIL] Check the key file') && text.includes('[ok]   Reach the SSH port'));
  assert.ok(!/BEGIN|PRIVATE KEY/.test(text), 'no key material in the report');
  assert.deepStrictEqual(d.verdict([{ id: 'config', title: 'Read the ssh config', status: 'ok', detail: '' }, { id: 'hostkey', title: 'Check the server’s identity', status: 'warn', detail: '' }]).text, 'Not connected yet: check the server’s identity.');
});

// real keys: the passphrase detection has to agree with what ssh-keygen actually writes
const hasKeygen = process.platform !== 'win32' && cp.spawnSync('which', ['ssh-keygen']).status === 0;
if (hasKeygen) {
  test('real ed25519 and rsa keys: with a passphrase = locked, without = not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshm-doctor-'));
    try {
      for (const [type, pass, expected] of [['ed25519', '', false], ['ed25519', 'secret words', true], ['rsa', '', false], ['rsa', 'secret words', true]]) {
        const file = path.join(dir, `${type}-${expected}`);
        cp.execFileSync('ssh-keygen', ['-q', '-t', type, ...(type === 'rsa' ? ['-b', '2048'] : []), '-N', pass, '-f', file, '-C', 'test'], { stdio: 'ignore' });
        assert.strictEqual(d.keyIsEncrypted(fs.readFileSync(file, 'utf8').slice(0, 600)), expected, `${type} ${pass ? 'with' : 'without'} passphrase`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

(async () => {
  for (const [name, fn] of tests) {
    await fn();
    n++;
    console.log('  ok  ' + name);
  }
  console.log(`\n${n} tests passed`);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
