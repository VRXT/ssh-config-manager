// Plain-node tests for the server status checks: the network is canned.  npm test
const assert = require('assert');
const h = require('../out/health');
const cfg = require('../out/sshConfig');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const target = (over = {}) => ({ hostName: '203.0.113.10', port: 22, viaJump: false, check: '', ...over });
const err = code => Object.assign(new Error(code), { code });
function deps(over = {}) {
  let clock = 1000;
  return {
    platform: 'linux',
    now: () => (clock += 20),
    connect: async () => {},
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    http: async () => 200,
    ...over,
  };
}

test('the default method decides, the host’s own choice wins', () => {
  assert.deepStrictEqual(h.planCheck(target({ port: 2222 }), 'ssh'), { kind: 'tcp', host: '203.0.113.10', port: 2222 });
  assert.deepStrictEqual(h.planCheck(target(), 'ping'), { kind: 'ping', host: '203.0.113.10' });
  assert.deepStrictEqual(h.planCheck(target({ hostName: 'web.example.com' }), 'http'), { kind: 'http', url: 'https://web.example.com/' });
  assert.deepStrictEqual(h.planCheck(target({ hostName: '2001:db8::1' }), 'http'), { kind: 'http', url: 'https://[2001:db8::1]/' });
  assert.strictEqual(h.planCheck(target(), 'off').kind, 'none');
  assert.deepStrictEqual(h.planCheck(target({ check: 'ping' }), 'ssh'), { kind: 'ping', host: '203.0.113.10' });
  assert.deepStrictEqual(h.planCheck(target({ check: 'ssh' }), 'off'), { kind: 'tcp', host: '203.0.113.10', port: 22 });
  assert.strictEqual(h.planCheck(target({ check: 'off' }), 'ssh').kind, 'none');
  assert.deepStrictEqual(h.planCheck(target({ check: 'https://example.com/health' }), 'ssh'), { kind: 'http', url: 'https://example.com/health' });
  assert.strictEqual(h.planCheck(target({ check: 'nonsense' }), 'ssh').kind, 'tcp', 'an unknown value falls back to the default');
});

test('a host behind a jump host is not called down', () => {
  assert.strictEqual(h.planCheck(target({ viaJump: true }), 'ssh').kind, 'none');
  assert.strictEqual(h.planCheck(target({ viaJump: true }), 'ping').kind, 'none');
  // its own web address can still be checked
  assert.strictEqual(h.planCheck(target({ viaJump: true, check: 'http://10.0.0.5:8080/' }), 'ssh').kind, 'http');
});

test('ping uses the flags of each system', () => {
  assert.deepStrictEqual(h.pingCommand('darwin', 'a', 5).args, ['-c', '1', '-t', '5', 'a']);
  assert.deepStrictEqual(h.pingCommand('linux', 'a', 5).args, ['-c', '1', '-W', '5', 'a']);
  assert.deepStrictEqual(h.pingCommand('win32', 'a', 5).args, ['-n', '1', '-w', '5000', 'a']);
});

test('ssh port: answered = up with a time, refused or silent = down', async () => {
  const up = await h.runCheck({ kind: 'tcp', host: 'a', port: 22 }, deps());
  assert.strictEqual(up.status, 'up');
  assert.strictEqual(up.ms, 20);
  const refused = await h.runCheck({ kind: 'tcp', host: 'a', port: 22 }, deps({ connect: async () => { throw err('ECONNREFUSED'); } }));
  assert.strictEqual(refused.status, 'down');
  assert.match(refused.detail, /refused/);
  assert.strictEqual(refused.ms, undefined);
  const silent = await h.runCheck({ kind: 'tcp', host: 'a', port: 22 }, deps({ connect: async () => { throw err('ETIMEDOUT'); } }));
  assert.match(silent.detail, /no answer in time/);
});

test('ping: exit code, the Windows "unreachable" trap, and no ping program', async () => {
  const plan = { kind: 'ping', host: 'a' };
  assert.strictEqual((await h.runCheck(plan, deps())).status, 'up');
  assert.strictEqual((await h.runCheck(plan, deps({ exec: async () => ({ code: 1, stdout: '', stderr: '' }) }))).status, 'down');
  const win = out => deps({ platform: 'win32', exec: async () => ({ code: 0, stdout: out, stderr: '' }) });
  assert.strictEqual((await h.runCheck(plan, win('Reply from 203.0.113.10: bytes=32 time=12ms TTL=54'))).status, 'up');
  assert.strictEqual((await h.runCheck(plan, win('Reply from 192.0.2.1: Destination host unreachable.'))).status, 'down');
  assert.strictEqual((await h.runCheck(plan, deps({ exec: async () => ({ stdout: '', stderr: '', error: 'ENOENT' }) }))).status, 'unknown');
});

test('http: any answer below 500 is up, 5xx and no answer are down', async () => {
  const plan = { kind: 'http', url: 'https://example.com/' };
  for (const code of [200, 301, 401, 404]) {
    assert.strictEqual((await h.runCheck(plan, deps({ http: async () => code }))).status, 'up', String(code));
  }
  assert.strictEqual((await h.runCheck(plan, deps({ http: async () => 503 }))).status, 'down');
  const gone = await h.runCheck(plan, deps({ http: async () => { throw err('ENOTFOUND'); } }));
  assert.strictEqual(gone.status, 'down');
  assert.match(gone.detail, /name could not be found/);
});

test('a host that is not checked is "unknown", with the reason', async () => {
  const r = await h.runCheck(h.planCheck(target({ viaJump: true }), 'ssh'), deps());
  assert.strictEqual(r.status, 'unknown');
  assert.match(r.detail, /jump host/);
});

test('at most N checks run at the same time, and all of them run', async () => {
  let live = 0, peak = 0, done = 0;
  await h.pool([...Array(20).keys()], 4, async () => {
    peak = Math.max(peak, ++live);
    await new Promise(r => setTimeout(r, 2));
    live--; done++;
  });
  assert.strictEqual(done, 20);
  assert.strictEqual(peak, 4);
  await h.pool([], 4, async () => assert.fail('nothing to run'));
});

test('the tooltip line, the interval setting and the web address check', () => {
  assert.strictEqual(h.describeHealth({ status: 'up', detail: 'SSH port 22 answered', ms: 23, at: 0 }, 3000), 'Up · SSH port 22 answered in 23 ms · checked just now');
  assert.strictEqual(h.describeHealth({ status: 'down', detail: 'No answer to ping', at: 0 }, 180000), 'Down · No answer to ping · checked 3 min ago');
  assert.strictEqual(h.intervalSeconds(0), 0);
  assert.strictEqual(h.intervalSeconds(3), 15);
  assert.strictEqual(h.intervalSeconds('abc'), 0);
  assert.strictEqual(h.intervalSeconds(300), 300);
  assert.strictEqual(h.urlProblem('https://example.com/health'), undefined);
  assert.ok(h.urlProblem('example.com'));
  assert.ok(h.urlProblem('ftp://example.com'));
  assert.ok(h.urlProblem('https://a b'));
});

test('check= is kept in the #@host line and survives an edit of the host', () => {
  const text = 'Host web\n    HostName 203.0.113.10\n';
  const doc = cfg.parse(text);
  const withCheck = cfg.setHostAttrs(doc, doc.hosts[0].id, { check: 'https://example.com/health' });
  const again = cfg.parse(withCheck);
  assert.strictEqual(again.hosts[0].attrs.check, 'https://example.com/health');
  const edited = cfg.parse(cfg.updateHost(again, again.hosts[0].id, { ...cfg.hostToForm(again, again.hosts[0]), user: 'deploy' }));
  assert.strictEqual(edited.hosts[0].attrs.check, 'https://example.com/health');
  const cleared = cfg.parse(cfg.setHostAttrs(edited, edited.hosts[0].id, { check: undefined }));
  assert.strictEqual(cleared.hosts[0].attrs.check, undefined);
});

test('the status icon: the host’s own icon and color with a dot, animated only when asked', () => {
  const si = require('../out/statusIcon');
  const up = si.statusIconSvg('database', 'green', 'up', true, 'dark');
  assert.match(up, /^<svg [^>]*viewBox="0 0 16 16"/);
  assert.match(up, /#89d185/, 'the host color');
  assert.match(up, /#3fb950/, 'the green dot');
  assert.match(up, /animation:/);
  assert.match(up, /prefers-reduced-motion/);
  assert.doesNotMatch(si.statusIconSvg('database', 'green', 'up', false, 'dark'), /animation|<style/);
  assert.doesNotMatch(si.statusIconSvg('server', undefined, 'unknown', true, 'light'), /animation/);
  assert.match(si.statusIconSvg('server', undefined, 'down', true, 'light'), /#cf222e/);
  // an icon without a known shape falls back to the server, and a 24-unit icon is scaled down
  assert.strictEqual(si.statusIconName('no-such-icon', 'pink', 'up', true, 'dark'), 'server-plain-up-a-dark.svg');
  assert.match(si.statusIconSvg('terminal', undefined, 'up', false, 'dark'), /scale\(0\.666/);
  // without a status: the icon alone in its color, for the quick-connect list
  const plain = si.statusIconSvg('database', 'green', undefined, true, 'dark');
  assert.match(plain, /#89d185/);
  assert.doesNotMatch(plain, /mask|circle|<style/);
  assert.strictEqual(si.statusIconName('database', 'green', undefined, true, 'dark'), 'database-green-none-dark.svg');
  assert.ok(si.canDraw('cloud') && !si.canDraw('references'));
  const tree = require('fs').readFileSync(require('path').join(__dirname, '../src/tree.ts'), 'utf8');
  const icons = /export const ICONS = \[([^\]]+)\]/.exec(tree)[1].match(/'[^']+'/g).map(x => x.slice(1, -1));
  const shapes = require('../out/iconShapes').ICON_SHAPES;
  for (const icon of [...icons, 'link']) {
    assert.ok(shapes[icon], 'shape for ' + icon);
  }
});

test('a folder is green when all its hosts are up, red when all are down, yellow when mixed', () => {
  const si = require('../out/statusIcon');
  assert.strictEqual(si.folderStatus(['up', 'up']), 'up');
  assert.strictEqual(si.folderStatus(['down', 'down']), 'down');
  assert.strictEqual(si.folderStatus(['up', 'down', 'up']), 'mixed');
  assert.strictEqual(si.folderStatus(['up', 'unknown', undefined]), 'up', 'hosts that are not checked do not count');
  assert.strictEqual(si.folderStatus(['unknown', undefined]), undefined);
  assert.strictEqual(si.folderStatus([]), undefined);
  const mixed = si.statusIconSvg('folder', 'blue', 'mixed', true, 'dark');
  assert.match(mixed, /#e3b341/);
  assert.match(mixed, /animation:/);
  assert.strictEqual(si.statusIconName('folder', undefined, 'mixed', false, 'light'), 'folder-plain-mixed-light.svg');
});

(async () => {
  let n = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('  ok  ' + name);
      n++;
    } catch (e) {
      console.error('FAIL  ' + name + '\n' + (e && e.stack || e));
      process.exitCode = 1;
    }
  }
  console.log(`\n${n} tests passed`);
})();
