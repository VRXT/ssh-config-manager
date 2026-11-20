// Plain-node tests for the home page model:  npm test
const assert = require('assert');
const c = require('../out/sshConfig');
const m = require('../out/startModel');

let n = 0;
const test = (name, fn) => {
  fn();
  n++;
  console.log('  ok  ' + name);
};

const SAMPLE = `Host *
    ServerAliveInterval 30

Host loose
    HostName 192.168.1.5

#@group "Acme Store" color=blue
#@section "AWS production"
#@host tags=prod,web fav=1 color=green note="Storefront"
Host store-web-1
    HostName 203.0.113.21
    User deploy
    Port 2222

#@host provider=aws
Host store-db
    HostName 10.0.1.15

#@section Staging
Host store-stage
    HostName 203.0.113.40

#@off Host store-old
#@off     HostName 203.0.113.99

# ======================
# Lab
# ======================
# --- HETZNER HOSTS ---
Host lab-1
    HostName 198.51.100.7
`;
const doc = c.parse(SAMPLE, 'config');
const inc = c.parse('Host colima\n    HostName 127.0.0.1\n', '/home/me/.colima/ssh_config', true);
const status = { 'store-web-1': 'up', 'store-db': 'down' };
const build = (recent = [], d = doc) => m.buildStartModel(d, [inc], recent, name => status[name]);

test('lists every host you can connect to, by folder and subfolder', () => {
  const s = build();
  assert.deepStrictEqual(s.loose.map(h => h.alias), ['loose']);
  assert.deepStrictEqual(s.folders.map(f => [f.title, f.total]), [['Acme Store', 3], ['Lab', 1]]);
  const acme = s.folders[0];
  assert.deepStrictEqual(acme.hosts, []);
  assert.deepStrictEqual(acme.subfolders.map(x => [x.title, x.hosts.map(h => h.alias)]), [['AWS production', ['store-web-1', 'store-db']], ['Staging', ['store-stage']]]);
  assert.strictEqual(acme.color, 'blue');
  // a hand-written single sub-header is not a level of its own
  assert.deepStrictEqual([s.folders[1].hosts.map(h => h.alias), s.folders[1].subfolders], [['lab-1'], []]);
  assert.deepStrictEqual(s.included.map(i => [i.title, i.hosts.map(h => h.alias)]), [['.colima/ssh_config', ['colima']]]);
  const all = [...s.loose, ...s.folders.flatMap(f => [...f.hosts, ...f.subfolders.flatMap(x => x.hosts)])];
  assert.ok(!all.some(h => h.alias === '*' || h.alias === 'store-old'), 'patterns and disabled hosts are left out');
  assert.strictEqual(s.total, 6);
});

test('each host carries what the tile shows and what search matches', () => {
  const s = build();
  const web = s.folders[0].subfolders[0].hosts[0];
  assert.deepStrictEqual(
    [web.name, web.detail, web.color, web.tags, web.note, web.fav, web.status, web.folder],
    ['store-web-1', 'deploy@203.0.113.21:2222', 'green', ['prod', 'web'], 'Storefront', true, 'up', 'Acme Store / AWS production']);
  const db = s.folders[0].subfolders[0].hosts[1];
  assert.deepStrictEqual([db.provider, db.status, db.fav], ['AWS', 'down', false]);
  assert.strictEqual(s.loose[0].provider, 'LAN');
  assert.strictEqual(s.loose[0].status, 'unknown');
  assert.strictEqual(s.folders[1].hosts[0].folder, 'Lab');
  for (const word of ['store-web-1', '203.0.113', 'prod', 'storefront', 'acme store', 'aws production']) {
    assert.ok(web.hay.includes(word), word);
  }
  assert.ok(db.hay.includes('aws'));
});

test('counts, favorites and recent', () => {
  let s = build(['store-db', 'gone', 'colima', 'loose']);
  assert.deepStrictEqual([s.up, s.down], [1, 1]);
  assert.deepStrictEqual([s.folders[0].up, s.folders[0].down], [1, 1]);
  assert.deepStrictEqual(s.favorites.map(h => h.alias), ['store-web-1']);
  assert.deepStrictEqual(s.recent.map(h => h.alias), ['store-db', 'colima', 'loose'], 'in order, hosts that no longer exist dropped');
  s = m.buildStartModel(c.parse(c.setSettings(doc, { favorites: 'off' }), 'config'), [], [], () => undefined);
  assert.deepStrictEqual(s.favorites, []);
  assert.deepStrictEqual(m.buildStartModel(c.parse(''), [], ['x'], () => undefined), { favorites: [], recent: [], loose: [], folders: [], included: [], total: 0, up: 0, down: 0 });
});

test('recent list: newest first, no duplicates, capped, old format still read', () => {
  const names = l => l.map(e => e.name);
  const r = [{ name: 'a', at: 1 }, { name: 'b', at: 2 }, { name: 'c', at: 3 }];
  assert.deepStrictEqual(m.pushRecent(r, 'b', 9), [{ name: 'b', at: 9 }, { name: 'a', at: 1 }, { name: 'c', at: 3 }]);
  assert.deepStrictEqual(m.pushRecent([], 'a', 5), [{ name: 'a', at: 5 }]);
  const many = Array.from({ length: 20 }, (_, i) => ({ name: 'h' + i, at: i }));
  const out = m.pushRecent(many, 'new', 99);
  assert.strictEqual(out.length, m.RECENT_MAX);
  assert.strictEqual(out[0].name, 'new');
  // what an older version stored (plain names), and anything else that may be in there
  assert.deepStrictEqual(m.readRecent(['x', 'y', 'x']), [{ name: 'x', at: 0 }, { name: 'y', at: 0 }]);
  assert.deepStrictEqual(names(m.readRecent([{ name: 'x', at: 7 }, null, 3, { nope: 1 }, 'z'])), ['x', 'z']);
  assert.deepStrictEqual(m.readRecent(undefined), []);
  assert.deepStrictEqual(m.readRecent('x'), []);
});

test('page settings: unknown values fall back, a click follows the Hosts panel unless set', () => {
  assert.strictEqual(m.primaryAction('panel', 'terminal'), 'terminal');
  assert.strictEqual(m.primaryAction('panel', 'window'), 'window');
  for (const panel of [undefined, 'none', 'edit', 'newWindow']) {
    assert.strictEqual(m.primaryAction('panel', panel), 'newWindow', String(panel));
  }
  assert.strictEqual(m.primaryAction('terminal', 'window'), 'terminal');
  assert.strictEqual(m.primaryAction('newWindow', 'terminal'), 'newWindow');
  assert.deepStrictEqual([m.startClick('window'), m.startClick('x'), m.startClick(undefined)], ['window', 'panel', 'panel']);
  assert.deepStrictEqual([m.startDensity('compact'), m.startDensity('x'), m.startDensity(undefined)], ['compact', 'comfortable', 'comfortable']);
  assert.deepStrictEqual([0, 4, 12, 99, -3, 'x', undefined, null, ''].map(m.recentCount), [0, 4, 12, 12, 0, 8, 8, 8, 8]);
});

test('hosts of an included file cannot be starred or edited from the page', () => {
  const s = build();
  assert.strictEqual(s.included[0].hosts[0].editable, false);
  assert.strictEqual(s.loose[0].editable, true);
});

test('the manifest offers exactly the values the page understands', () => {
  const props = require('../package.json').contributes.configuration.properties;
  assert.deepStrictEqual(props['sshManager.startPage.open'].enum.slice().sort(), [...m.START_MODES].sort());
  assert.deepStrictEqual(props['sshManager.startPage.click'].enum.slice().sort(), [...m.START_CLICKS].sort());
  assert.deepStrictEqual(props['sshManager.startPage.density'].enum.slice().sort(), [...m.DENSITIES].sort());
  assert.ok(Math.max(...props['sshManager.startPage.recent'].enum) <= m.RECENT_MAX);
  assert.strictEqual(m.startMode(props['sshManager.startPage.open'].default), 'emptyWindow');
  assert.strictEqual(m.recentCount(props['sshManager.startPage.recent'].default), 8);
});

test('when the page opens by itself', () => {
  const w = (folders, remote = false, firstRun = false) => ({ folders, remote, firstRun });
  assert.strictEqual(m.opensOnStartup('emptyWindow', w(0)), true);
  assert.strictEqual(m.opensOnStartup('emptyWindow', w(1)), false);
  assert.strictEqual(m.opensOnStartup('always', w(2)), true);
  assert.strictEqual(m.opensOnStartup('never', w(0)), false);
  for (const mode of m.START_MODES) {
    assert.strictEqual(m.opensOnStartup(mode, w(0, true)), false, 'not inside a window connected to a server');
    assert.strictEqual(m.opensOnStartup(mode, w(0, false, true)), false, 'the setup wizard has the first run');
  }
  assert.strictEqual(m.startMode('always'), 'always');
  assert.strictEqual(m.startMode('bogus'), 'emptyWindow');
  assert.strictEqual(m.startMode(undefined), 'emptyWindow');
});

console.log(`\n${n} tests passed`);
