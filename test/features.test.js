// Plain-node tests for search/filters and the SSH key helpers:  npm test
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const c = require('../out/sshConfig');
const s = require('../out/search');
const k = require('../out/keys');

const SAMPLE = `Host *
    ServerAliveInterval 30

#@group "Acme Store" icon=organization
#@section "AWS production"
#@host tags=prod,web note="Storefront behind the load balancer"
Host store-web-1
    HostName 203.0.113.21
    User deploy
    IdentityFile ~/.ssh/acme_ed25519

#@host tags=prod,db provider=aws note="PostgreSQL primary"
Host store-db
    HostName 10.0.1.15
    User postgres
    ProxyJump store-bastion

#@section Staging
#@host provider=aws tags=staging
Host store-staging
    HostName 198.51.100.30
    Port 2222

#@group "Home Lab"
Host nas
    HostName 192.168.1.20
    User admin
`;

let n = 0;
const test = (name, fn) => {
  fn();
  n++;
  console.log('  ok  ' + name);
};
const P = t => c.parse(t, 'config');
const shown = (d, f) => d.hosts.filter(h => s.hostMatches(h, { ...s.emptyFilter(), ...f })).map(h => h.alias);

test('search text matches name, options, notes, group and provider', () => {
  const d = P(SAMPLE);
  assert.deepStrictEqual(shown(d, {}), ['*', 'store-web-1', 'store-db', 'store-staging', 'nas']);
  assert.deepStrictEqual(shown(d, { text: 'acme_ed25519' }), ['store-web-1'], 'IdentityFile');
  assert.deepStrictEqual(shown(d, { text: 'bastion' }), ['store-db'], 'ProxyJump');
  assert.deepStrictEqual(shown(d, { text: '2222' }), ['store-staging'], 'Port');
  assert.deepStrictEqual(shown(d, { text: 'load balancer' }), ['store-web-1'], 'note, every word');
  assert.deepStrictEqual(shown(d, { text: 'HOME lab' }), ['nas'], 'group, any case');
  assert.deepStrictEqual(shown(d, { text: 'aws postgres' }), ['store-db'], 'provider + user');
  assert.deepStrictEqual(shown(d, { text: 'nothing-like-this' }), []);
});

test('filter chips: OR inside a list, AND between lists', () => {
  const d = P(SAMPLE);
  assert.deepStrictEqual(shown(d, { tags: ['db'] }), ['store-db']);
  assert.deepStrictEqual(shown(d, { tags: ['db', 'staging'] }), ['store-db', 'store-staging']);
  assert.deepStrictEqual(shown(d, { tags: ['PROD'] }), ['store-web-1', 'store-db'], 'tags ignore case');
  assert.deepStrictEqual(shown(d, { providers: ['LAN'] }), ['nas'], 'provider=aws beats the private address');
  assert.deepStrictEqual(shown(d, { providers: ['AWS'] }), ['store-web-1', 'store-db', 'store-staging'], 'folder name or provider=');
  assert.deepStrictEqual(shown(d, { providers: ['AWS', 'LAN'] }).length, 4);
  assert.deepStrictEqual(shown(d, { groups: ['Acme Store'] }), ['store-web-1', 'store-db', 'store-staging'], 'sub-groups count for their group');
  assert.deepStrictEqual(shown(d, { groups: ['Acme Store'], tags: ['web'] }), ['store-web-1']);
  assert.deepStrictEqual(shown(d, { groups: ['Home Lab'], text: 'store' }), []);
});

test('facets list tags, providers and groups with counts, patterns left out', () => {
  const f = s.facets([P(SAMPLE)]);
  assert.deepStrictEqual(f.tags, [
    { value: 'db', count: 1 }, { value: 'prod', count: 2 }, { value: 'staging', count: 1 }, { value: 'web', count: 1 },
  ]);
  assert.deepStrictEqual(f.groups, [{ value: 'Acme Store', count: 3 }, { value: 'Home Lab', count: 1 }], 'file order');
  assert.deepStrictEqual(f.providers, [{ value: 'AWS', count: 3 }, { value: 'LAN', count: 1 }]);
  assert.strictEqual(s.describeFilter({ text: ' db ', tags: ['prod'], providers: ['AWS'], groups: [] }), '"db" · #prod · AWS');
  assert.ok(s.isFilterEmpty({ text: '  ', tags: [], providers: [], groups: [] }));
});

test('key file names are safe', () => {
  assert.strictEqual(k.keyFileName('store-db'), 'id_ed25519_store-db');
  assert.strictEqual(k.keyFileName('my host/../x'), 'id_ed25519_my_host_.._x');
  assert.strictEqual(k.keyFileName('...'), 'id_ed25519_host');
});

test('addIdentityFile adds once and keeps the rest of the file', () => {
  const d = P(SAMPLE);
  const id = d.hosts.find(h => h.alias === 'nas').id;
  const once = k.addIdentityFile(d, id, '~/.ssh/id_ed25519_nas');
  const nas = P(once).hosts.find(h => h.alias === 'nas');
  assert.deepStrictEqual(c.optionAll(nas, 'IdentityFile'), ['~/.ssh/id_ed25519_nas']);
  assert.strictEqual(k.addIdentityFile(P(once), nas.id, '~/.ssh/id_ed25519_nas'), once, 'second time: no change');
  assert.ok(once.startsWith(SAMPLE.slice(0, SAMPLE.indexOf('#@group "Home Lab"'))), 'other hosts untouched');
  const web = P(SAMPLE).hosts.find(h => h.alias === 'store-web-1');
  const two = P(k.addIdentityFile(P(SAMPLE), web.id, '~/.ssh/new key')).hosts.find(h => h.alias === 'store-web-1');
  assert.deepStrictEqual(c.optionAll(two, 'IdentityFile'), ['~/.ssh/acme_ed25519', '~/.ssh/new key']);
});

test('install command: quoting per platform', () => {
  const mac = k.installKeyCommand({ platform: 'darwin', alias: 'store-db', pub: '/Users/me/.ssh/id x.pub' });
  assert.strictEqual(mac, "ssh store-db 'umask 077; mkdir -p ~/.ssh; echo >> ~/.ssh/authorized_keys; tr -d \\\\015 >> ~/.ssh/authorized_keys' < '/Users/me/.ssh/id x.pub'");
  const cfg = k.installKeyCommand({ platform: 'linux', alias: "it's", pub: '/k.pub', configFile: '/cfg/my config' });
  assert.ok(cfg.startsWith("ssh -F '/cfg/my config' 'it'\\''s' "));
  const win = k.installKeyCommand({ platform: 'win32', alias: 'nas', pub: 'C:\\Users\\me\\.ssh\\id.pub' });
  assert.strictEqual(win, 'type "C:\\Users\\me\\.ssh\\id.pub" | ssh "nas" "umask 077; mkdir -p ~/.ssh; echo >> ~/.ssh/authorized_keys; tr -d \\\\015 >> ~/.ssh/authorized_keys"');
  assert.ok(!/\$/.test(win), 'nothing PowerShell would expand');
});

// The rest needs ssh-keygen and a POSIX shell; skipped where they are missing.
const has = cmd => cp.spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd]).status === 0;
if (process.platform !== 'win32' && has('ssh-keygen')) {
  test('ssh-keygen makes a key the list picks up; the server side appends it (CRLF stripped)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshm-keys-'));
    try {
      const file = path.join(dir, k.keyFileName('store-db'));
      cp.execFileSync('ssh-keygen', k.keygenArgs(file, '', 'store-db (SSH Config Manager)'), { stdio: 'ignore' });
      const keys = k.listPublicKeys(dir);
      assert.strictEqual(keys.length, 1);
      assert.strictEqual(keys[0].priv, file);
      assert.strictEqual(keys[0].type, 'ssh-ed25519');
      assert.strictEqual(keys[0].comment, 'store-db (SSH Config Manager)');
      fs.writeFileSync(path.join(dir, 'orphan.pub'), 'ssh-ed25519 AAAA x'); // no private key next to it
      fs.writeFileSync(path.join(dir, 'notes.pub'), 'hello');
      assert.strictEqual(k.listPublicKeys(dir).length, 1, 'orphans and non-keys are skipped');

      // run the exact remote part locally, with a fake home and a CRLF key like Windows `type` sends
      const home = path.join(dir, 'home');
      fs.mkdirSync(home);
      const cmd = k.installKeyCommand({ platform: 'darwin', alias: 'x', pub: keys[0].pub });
      const remote = cmd.slice('ssh x '.length, cmd.lastIndexOf(' < '));
      const pub = fs.readFileSync(keys[0].pub, 'utf8').trim();
      fs.mkdirSync(path.join(home, '.ssh'));
      fs.writeFileSync(path.join(home, '.ssh', 'authorized_keys'), 'ssh-rsa EXISTING old'); // no newline at the end
      cp.execSync(`sh -c ${remote}`, { input: pub + '\r\n', env: { ...process.env, HOME: home } });
      const auth = fs.readFileSync(path.join(home, '.ssh', 'authorized_keys'), 'utf8');
      assert.deepStrictEqual(auth.split('\n').filter(Boolean), ['ssh-rsa EXISTING old', pub]);
      assert.ok(!auth.includes('\r'));

      // a server with no ~/.ssh yet: folder and file are created private
      const fresh = path.join(dir, 'fresh');
      fs.mkdirSync(fresh);
      cp.execSync(`sh -c ${remote}`, { input: pub + '\n', env: { ...process.env, HOME: fresh } });
      assert.strictEqual(fs.readFileSync(path.join(fresh, '.ssh', 'authorized_keys'), 'utf8').trim(), pub);
      assert.strictEqual(fs.statSync(path.join(fresh, '.ssh')).mode & 0o077, 0, '~/.ssh is 700');
      assert.strictEqual(fs.statSync(path.join(fresh, '.ssh', 'authorized_keys')).mode & 0o077, 0, 'authorized_keys is 600');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

console.log(`\n${n} tests passed`);
