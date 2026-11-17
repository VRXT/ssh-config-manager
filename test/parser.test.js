// Plain-node tests for the parser/editor (no VS Code needed):  npm test
// Optional: pass a real config to check it round-trips:  node test/parser.test.js ~/.ssh/config
const assert = require('assert');
const fs = require('fs');
const c = require('../out/sshConfig');

const SAMPLE = `Include ~/.ssh/config.d/work

# Read more about SSH config files
  Host 192.168.1.50
    HostName 192.168.1.50
    User pi

Host -----------LOCAL-----------

Host PVE
    HostName 192.168.1.10
    User root
    IdentityFile "~/keys/a b/id_rsa"
    IdentityFile "~/Sync/id_rsa"
    IdentitiesOnly yes

# ======================================================================
# PROJECT 1 - APEX
# ======================================================================

# --- HETZNER HOSTS ---

Host -----------APEX-----------
    HostName 0.0.0.0

Host HOST-Apex
    HostName 203.0.113.10
    User root
    RemoteCommand cd /var/www/html; exec bash
    #10.0.0.2

# --- LOCAL NETWORK HOSTS ---

Host LOCAL-Apex
    HostName 192.168.1.120
    User root

# ======================================================================
# PROJECT 2 - NOVA
# ======================================================================

Host -----------NOVA-----------
    HostName 0.0.0.0

    Host HOST-Nova
    HostName 203.0.113.20
`;

let n = 0;
const test = (name, fn) => {
  fn();
  n++;
  console.log('  ok  ' + name);
};
const P = t => c.parse(t, 'config');
const text = d => d.lines.join(d.eol) + d.eol;
const host = (d, alias) => d.hosts.find(h => h.alias === alias);
const group = (d, title) => c.allContainers(d).find(x => x.title === title);

test('reads the hand-written layout as groups and sub-groups', () => {
  const d = P(SAMPLE);
  assert.deepStrictEqual(d.groups.map(g => g.title), ['LOCAL', 'APEX', 'NOVA']);
  assert.deepStrictEqual(d.rootHosts.map(h => h.alias), ['192.168.1.50']);
  assert.deepStrictEqual(d.groups[1].sections.map(s => s.title), ['HETZNER HOSTS', 'LOCAL NETWORK HOSTS']);
  assert.strictEqual(host(d, 'HOST-Apex').container.title, 'HETZNER HOSTS');
  assert.strictEqual(host(d, 'LOCAL-Apex').container.title, 'LOCAL NETWORK HOSTS');
  assert.strictEqual(host(d, 'HOST-Nova').container.title, 'NOVA');
  assert.deepStrictEqual(d.includes, ['~/.ssh/config.d/work']);
  assert.ok(!d.hosts.some(h => h.alias.includes('---')), 'separator hosts are not listed as hosts');
});

test('parses options, quoted values and trailing comments', () => {
  const d = P(SAMPLE);
  assert.deepStrictEqual(c.optionAll(host(d, 'PVE'), 'identityfile'), ['~/keys/a b/id_rsa', '~/Sync/id_rsa']);
  const f = c.hostToForm(d, host(d, 'HOST-Apex'));
  assert.strictEqual(f.extra, 'RemoteCommand cd /var/www/html; exec bash\n#10.0.0.2');
});

test('untouched file round-trips byte for byte', () => {
  assert.strictEqual(text(P(SAMPLE)), SAMPLE);
});

test('saving a host unchanged only normalises that block', () => {
  const d = P(SAMPLE);
  const out = c.updateHost(d, 'HOST-Apex#0', c.hostToForm(d, host(d, 'HOST-Apex')));
  assert.strictEqual(out, SAMPLE);
});

test('metadata is written as a #@host comment and read back', () => {
  let d = P(SAMPLE);
  const f = c.hostToForm(d, host(d, 'PVE'));
  Object.assign(f, { icon: 'database', color: 'green', tags: 'prod, db', note: 'Main "PVE" box', fav: true, port: '2222' });
  const out = c.updateHost(d, 'PVE#0', f);
  assert.ok(out.includes('#@host icon=database color=green tags=prod,db note="Main \\"PVE\\" box" fav=1\nHost PVE\n'));
  assert.ok(out.includes('    IdentityFile "~/keys/a b/id_rsa"\n'));
  d = P(out);
  const h = host(d, 'PVE');
  assert.strictEqual(h.attrs.note, 'Main "PVE" box');
  assert.strictEqual(c.option(h, 'port'), '2222');
  assert.strictEqual(h.container.title, 'LOCAL');
  // and removing it again restores the original text
  const back = c.setHostAttrs(d, 'PVE#0', { icon: undefined, color: undefined, tags: undefined, note: undefined, fav: undefined });
  const f2 = c.hostToForm(P(back), host(P(back), 'PVE'));
  f2.port = '';
  assert.strictEqual(P(c.updateHost(P(back), 'PVE#0', f2)).hosts.length, d.hosts.length);
});

test('toggle favourite adds and removes one line', () => {
  const d = P(SAMPLE);
  const on = c.setHostAttrs(d, 'HOST-Nova#0', { fav: '1' });
  assert.ok(on.includes('    #@host fav=1\n    Host HOST-Nova\n'));
  assert.strictEqual(c.setHostAttrs(P(on), 'HOST-Nova#0', { fav: undefined }), SAMPLE);
});

test('add host lands at the end of the chosen group', () => {
  const d = P(SAMPLE);
  const f = c.emptyForm(group(d, 'LOCAL').id);
  Object.assign(f, { alias: 'NEW', hostName: '10.0.0.9', user: 'me' });
  const d2 = P(c.addHost(d, f));
  assert.deepStrictEqual(group(d2, 'LOCAL').hosts.map(h => h.alias), ['PVE', 'NEW']);
  assert.strictEqual(d2.hosts.length, d.hosts.length + 1);
  // ungrouped
  const g = c.emptyForm('');
  Object.assign(g, { alias: 'ROOT', hostName: '1.1.1.1' });
  assert.deepStrictEqual(P(c.addHost(d, g)).rootHosts.map(h => h.alias), ['192.168.1.50', 'ROOT']);
});

test('add host to an empty file', () => {
  const f = c.emptyForm('');
  Object.assign(f, { alias: 'a', hostName: 'b' });
  assert.strictEqual(c.addHost(P(''), f), 'Host a\n    HostName b\n');
});

test('move host between groups, both directions, nothing lost', () => {
  const d = P(SAMPLE);
  const down = P(c.moveHost(d, 'PVE#0', group(d, 'NOVA').id));
  assert.deepStrictEqual(group(down, 'NOVA').hosts.map(h => h.alias), ['HOST-Nova', 'PVE']);
  assert.strictEqual(down.hosts.length, d.hosts.length);
  const up = P(c.moveHost(down, 'PVE#0', group(down, 'LOCAL').id));
  assert.deepStrictEqual(group(up, 'LOCAL').hosts.map(h => h.alias), ['PVE']);
  assert.deepStrictEqual(up.groups.map(g => g.title), ['LOCAL', 'APEX', 'NOVA']);
  assert.strictEqual(text(up), SAMPLE);
  // before another host
  const before = P(c.moveHost(d, 'HOST-Nova#0', '', 'PVE#0'));
  assert.deepStrictEqual(group(before, 'LOCAL').hosts.map(h => h.alias), ['HOST-Nova', 'PVE']);
  // to where it already is
  assert.strictEqual(c.moveHost(d, 'PVE#0', group(d, 'LOCAL').id), SAMPLE);
});

test('editing with a new group moves the host', () => {
  const d = P(SAMPLE);
  const f = c.hostToForm(d, host(d, 'LOCAL-Apex'));
  f.container = group(d, 'NOVA').id;
  const d2 = P(c.updateHost(d, 'LOCAL-Apex#0', f));
  assert.strictEqual(host(d2, 'LOCAL-Apex').container.title, 'NOVA');
});

test('delete host removes only its block', () => {
  const d = P(SAMPLE);
  const d2 = P(c.deleteHost(d, 'HOST-Apex#0'));
  assert.strictEqual(d2.hosts.length, d.hosts.length - 1);
  assert.ok(!text(d2).includes('#10.0.0.2'));
  assert.ok(text(d2).includes('# --- HETZNER HOSTS ---'));
  assert.deepStrictEqual(d2.groups.map(g => g.title), ['LOCAL', 'APEX', 'NOVA']);
});

test('groups: add, sub-group, rename, decorate, delete', () => {
  let d = P(c.addGroup(P(SAMPLE), 'My New Project'));
  assert.ok(text(d).endsWith('\n\n#@group "My New Project"\n'));
  assert.deepStrictEqual(d.groups.map(g => g.title), ['LOCAL', 'APEX', 'NOVA', 'My New Project']);

  d = P(c.addSection(d, group(d, 'My New Project').id, 'Hetzner'));
  assert.deepStrictEqual(group(d, 'My New Project').sections.map(s => s.title), ['Hetzner']);

  const f = c.emptyForm(group(d, 'Hetzner').id);
  Object.assign(f, { alias: 'h1', hostName: 'x' });
  d = P(c.addHost(d, f));
  assert.strictEqual(host(d, 'h1').container.title, 'Hetzner');
  assert.throws(() => c.deleteContainer(d, group(d, 'My New Project').id), /still has hosts/);

  // rename a hand-written group: the separator host keeps its dashes
  d = P(c.renameContainer(d, group(d, 'APEX').id, 'Apex Two'));
  assert.ok(text(d).includes('Host -----------Apex-Two-----------\n'));
  assert.ok(text(d).includes('# PROJECT 1 - APEX\n'), 'banner comment is left alone');
  assert.strictEqual(group(d, 'Apex-Two').total, 2);

  // colour on a hand-written group adds one #@group line above its banner, without splitting the group
  d = P(c.setContainerAttrs(d, group(d, 'Apex-Two').id, { color: 'blue' }));
  assert.ok(text(d).includes('#@group Apex-Two color=blue\n# ====='));
  assert.deepStrictEqual(d.groups.map(g => g.title), ['LOCAL', 'Apex-Two', 'NOVA', 'My New Project']);
  assert.strictEqual(group(d, 'Apex-Two').total, 2);
  assert.strictEqual(group(d, 'Apex-Two').attrs.color, 'blue');
  d = P(c.setContainerAttrs(d, group(d, 'Apex-Two').id, { icon: 'cloud' }));
  assert.ok(text(d).includes('#@group Apex-Two color=blue icon=cloud\n'));
  d = P(c.setContainerAttrs(d, group(d, 'LOCAL').id, { color: 'red' }));
  assert.strictEqual(group(d, 'LOCAL').total, 1);

  // sub-group colour + rename
  d = P(c.setContainerAttrs(d, group(d, 'HETZNER HOSTS').id, { color: 'green' }));
  assert.strictEqual(group(d, 'HETZNER HOSTS').hosts.length, 1);
  d = P(c.renameContainer(d, group(d, 'LOCAL NETWORK HOSTS').id, 'LAN'));
  assert.ok(text(d).includes('# --- LAN ---\n'));

  // delete an emptied group removes its markers
  d = P(c.deleteHost(d, 'h1#0'));
  const before = d.hosts.length;
  d = P(c.deleteContainer(d, group(d, 'My New Project').id));
  assert.ok(!text(d).includes('My New Project') && !text(d).includes('#@section Hetzner'));
  assert.strictEqual(d.hosts.length, before);
});

test('an emptied #@group does not swallow the next hand-written group', () => {
  const t = '#@group A\n\nHost a\n    HostName 1\n\n# ==========\n# B\n# ==========\n\nHost b\n    HostName 2\n';
  const d = P(c.deleteHost(P(t), 'a#0'));
  assert.deepStrictEqual(d.groups.map(g => [g.title, g.total]), [['A', 0], ['B', 1]]);
});

test('settings live in the file', () => {
  let d = P(c.setSettings(P(SAMPLE), { sort: 'name' }));
  assert.ok(text(d).startsWith('#@ssh-manager sort=name\nInclude'));
  d = P(c.setSettings(d, { click: 'terminal' }));
  assert.deepStrictEqual(d.settings, { sort: 'name', click: 'terminal' });
  assert.strictEqual(text(d).split('\n').filter(l => l.startsWith('#@ssh-manager')).length, 1);
});

test('Host * and Match blocks', () => {
  const d = P('Host *\n    ServerAliveInterval 60\n\nMatch host foo\n    User x\n\nHost real other\n    User y\n');
  assert.strictEqual(d.hosts[0].isPattern, true);
  assert.strictEqual(d.hosts[0].options.length, 1);
  assert.strictEqual(c.connectName(d.hosts[1]), 'real');
  assert.strictEqual(c.connectName(d.hosts[0]), undefined);
});

test('CRLF files keep CRLF', () => {
  const crlf = SAMPLE.replace(/\n/g, '\r\n');
  assert.strictEqual(text(P(crlf)), crlf);
  assert.ok(c.setHostAttrs(P(crlf), 'PVE#0', { fav: '1' }).includes('#@host fav=1\r\nHost PVE\r\n'));
});

test('Remote-SSH spacer rows: add, invisible to the tree, remove restores the file', () => {
  const d = P(SAMPLE);
  const on = c.setSpacers(d, true);
  const d2 = P(on);
  assert.strictEqual(d2.spacers.length, 5, '3 project spacers + 2 sub-folder rows');
  assert.ok(on.includes('Host \u200b---\u00a0HETZNER\u00a0HOSTS\u00a0---\u200b\n\nHost HOST-Apex\n'));
  assert.ok(on.includes('Host \u200b---\u00a0LOCAL\u00a0NETWORK\u00a0HOSTS\u00a0---\u200b\u200b\n\nHost LOCAL-Apex\n'));
  assert.ok(!on.includes('NOVA\u00a0---'), 'single-folder projects get no sub row');
  const arrow = c.setSpacers(P(c.setSettings(d2, { 'remote-subfolders': 'arrow' })), true);
  assert.ok(arrow.includes('Host \u200b\u25be\u00a0HETZNER\u00a0HOSTS\u200b\n') && P(arrow).spacers.length === 5);
  assert.strictEqual(P(c.setSpacers(P(c.setSettings(d2, { 'remote-subfolders': 'off' })), true)).spacers.length, 3);
  assert.ok(on.includes('Host \u2800\u2800\n\n# =====') && on.includes('Host \u2800\n\nHost -----------LOCAL'));
  assert.deepStrictEqual(d2.hosts.map(h => h.alias), d.hosts.map(h => h.alias));
  assert.deepStrictEqual(d2.groups.map(g => [g.title, g.total]), d.groups.map(g => [g.title, g.total]));
  assert.strictEqual(c.setSpacers(d2, true), on, 'running it twice changes nothing');
  assert.strictEqual(c.setSpacers(d2, false), SAMPLE);
  // a host added to a group still lands before the next group's spacer
  const f = c.emptyForm(group(d2, 'LOCAL').id);
  Object.assign(f, { alias: 'NEW', hostName: 'x' });
  const d3 = P(c.addHost(d2, f));
  assert.ok(host(d3, 'NEW').end <= d3.spacers[1].start && host(d3, 'NEW').container.title === 'LOCAL');
});

test('disable / enable a host: commented out with #@off, restored exactly', () => {
  const d = P(SAMPLE);
  const off = c.setHostEnabled(d, 'HOST-Apex#0', false);
  assert.ok(off.includes('#@off Host HOST-Apex\n#@off     HostName 203.0.113.10\n#@off     User root\n#@off     RemoteCommand cd /var/www/html; exec bash\n#@off     #10.0.0.2\n'));
  const d2 = P(off);
  const h = host(d2, 'HOST-Apex');
  assert.strictEqual(h.disabled, true);
  assert.strictEqual(c.connectName(h), undefined);
  assert.strictEqual(c.option(h, 'hostname'), '203.0.113.10');
  assert.strictEqual(h.container.title, 'HETZNER HOSTS');
  assert.strictEqual(d2.hosts.length, d.hosts.length);
  assert.strictEqual(c.hostToForm(d2, h).extra, 'RemoteCommand cd /var/www/html; exec bash\n#10.0.0.2');
  // editing, starring and moving a disabled host keeps it disabled
  const f = c.hostToForm(d2, h);
  f.port = '2200';
  let d3 = P(c.updateHost(d2, 'HOST-Apex#0', f));
  assert.ok(text(d3).includes('#@off     Port 2200\n') && host(d3, 'HOST-Apex').disabled);
  d3 = P(c.setHostAttrs(d3, 'HOST-Apex#0', { fav: '1' }));
  assert.ok(text(d3).includes('#@host fav=1\n#@off Host HOST-Apex\n') && host(d3, 'HOST-Apex').disabled);
  d3 = P(c.moveHost(d3, 'HOST-Apex#0', group(d3, 'NOVA').id));
  assert.ok(host(d3, 'HOST-Apex').disabled && host(d3, 'HOST-Apex').container.title === 'NOVA');
  assert.strictEqual(c.setHostEnabled(d2, 'HOST-Apex#0', true), SAMPLE);
  // indented host
  const off2 = c.setHostEnabled(d, 'HOST-Nova#0', false);
  assert.ok(off2.includes('#@off     Host HOST-Nova\n'));
  assert.strictEqual(c.setHostEnabled(P(off2), 'HOST-Nova#0', true), SAMPLE);
});

test('disable / enable a whole group, including its separator host and spacer row', () => {
  const spaced = P(c.setSpacers(P(SAMPLE), true));
  const off = P(c.setContainerEnabled(spaced, group(spaced, 'APEX').id, false));
  const g = group(off, 'APEX');
  assert.ok(c.isDisabled(g) && g.total === 2 && g.sections.length === 2);
  assert.ok(text(off).includes('#@off Host ⠀⠀\n') && text(off).includes('#@off Host -----------APEX-----------\n#@off     HostName 0.0.0.0\n'));
  assert.ok([...g.sections[0].hosts, ...g.sections[1].hosts].every(h => h.disabled));
  assert.ok(!c.isDisabled(group(off, 'LOCAL')) && !host(off, 'PVE').disabled);
  assert.deepStrictEqual(off.groups.map(x => x.title), ['LOCAL', 'APEX', 'NOVA']);
  assert.strictEqual(off.spacers.length, 5);
  assert.strictEqual(c.setContainerEnabled(off, g.id, true), text(spaced));
  // renaming a disabled group keeps it disabled
  assert.ok(c.renameContainer(off, g.id, 'X').includes('#@off Host -----------X-----------\n'));
  // a sub-group only
  const sub = P(c.setContainerEnabled(spaced, group(spaced, 'LOCAL NETWORK HOSTS').id, false));
  assert.ok(host(sub, 'LOCAL-Apex').disabled && !host(sub, 'HOST-Apex').disabled && !c.isDisabled(group(sub, 'APEX')));
});

test('favorites block for the Remote-SSH picker follows the stars', () => {
  const S = t => P(c.syncMirror(P(t)));
  let d = S(c.setHostAttrs(P(c.setSettings(P(SAMPLE), { 'remote-favorites': 'on' })), 'PVE#0', { fav: '1' }));
  assert.ok(d.mirror, 'block exists');
  const block = d.lines.slice(d.mirror.start, d.mirror.end).join('\n');
  assert.ok(block.includes('Host -----------FAVORITES-----------\nHost ★PVE\n    HostName 192.168.1.10\n    User root\n    IdentityFile "~/keys/a b/id_rsa"'));
  assert.ok(d.mirror.start < d.hosts[0].start, 'block is above every host');
  assert.strictEqual(d.hosts.length, P(SAMPLE).hosts.length, 'copies are not listed as hosts');
  assert.deepStrictEqual(d.groups.map(g => g.title), ['LOCAL', 'APEX', 'NOVA']);
  assert.strictEqual(text(S(text(d))), text(d), 'stable');
  // edits flow into the block
  const f = c.hostToForm(d, host(d, 'PVE'));
  f.user = 'admin';
  d = S(c.updateHost(d, 'PVE#0', f));
  assert.ok(d.lines.slice(d.mirror.start, d.mirror.end).includes('    User admin'));
  d = S(c.setHostAttrs(d, 'HOST-Nova#0', { fav: '1' }));
  assert.ok(d.lines.slice(d.mirror.start, d.mirror.end).includes('Host ★HOST-Nova'));
  // a disabled favourite drops out; un-starring everything or switching off removes the block
  assert.ok(!text(S(c.setHostEnabled(d, 'HOST-Nova#0', false))).includes('★HOST-Nova'));
  const none = S(c.setHostAttrs(P(c.setHostAttrs(d, 'PVE#0', { fav: undefined })), 'HOST-Nova#0', { fav: undefined }));
  assert.ok(!none.mirror && !text(none).includes('FAVORITES'));
  const offd = S(c.setSettings(d, { 'remote-favorites': 'off' }));
  assert.ok(!offd.mirror && host(offd, 'PVE').attrs.fav === '1');
});

test('provider: explicit, then address, then folder name, then LOCAL- prefix', () => {
  const d = P(SAMPLE);
  const label = a => (c.providerOf(host(d, a)) || {}).label;
  assert.strictEqual(label('PVE'), 'LAN');
  assert.strictEqual(label('HOST-Apex'), 'Hetzner');
  assert.strictEqual(label('LOCAL-Apex'), 'LAN');
  assert.strictEqual(label('HOST-Nova'), undefined);
  const t = P('# --- HETZNER HOSTS ---\nHost a\n    HostName 100.100.1.2\n#@host provider=aws\nHost b\n    HostName 10.0.0.1\n#@host provider=MyDC\nHost c\nHost LOCAL-x\n    HostName nas.lan\nHost d\n    HostName example.com\n');
  const l2 = a => { const p = c.providerOf(host(t, a)); return p && [p.label, p.auto]; };
  assert.deepStrictEqual(l2('a'), ['Tailscale', true]);
  assert.deepStrictEqual(l2('b'), ['AWS', false]);
  assert.deepStrictEqual(l2('c'), ['MyDC', false]);
  assert.deepStrictEqual(l2('d'), ['Hetzner', true]);
  // round-trips through the form
  const f = c.hostToForm(d, host(d, 'HOST-Nova'));
  f.provider = 'hetzner';
  const d2 = P(c.updateHost(d, 'HOST-Nova#0', f));
  assert.ok(text(d2).includes('    #@host provider=hetzner\n    Host HOST-Nova\n'));
  assert.strictEqual(c.hostToForm(d2, host(d2, 'HOST-Nova')).provider, 'hetzner');
});

test('reorder projects: before another, to the end, with picker rows kept in step', () => {
  const titles = d => d.groups.map(g => g.title);
  const d = P(SAMPLE);
  let m = P(c.moveGroup(d, group(d, 'NOVA').id, group(d, 'LOCAL').id));
  assert.deepStrictEqual(titles(m), ['NOVA', 'LOCAL', 'APEX']);
  assert.deepStrictEqual(m.rootHosts.map(h => h.alias), ['192.168.1.50']);
  assert.strictEqual(m.hosts.length, d.hosts.length);
  assert.strictEqual(host(m, 'HOST-Nova').container.title, 'NOVA');
  assert.strictEqual(host(m, 'LOCAL-Apex').container.title, 'LOCAL NETWORK HOSTS');
  m = P(c.moveGroup(m, group(m, 'NOVA').id));
  assert.strictEqual(text(m), SAMPLE, 'there and back restores the file');
  assert.strictEqual(c.moveGroup(d, group(d, 'NOVA').id), SAMPLE, 'last stays last');
  assert.strictEqual(c.moveGroup(d, group(d, 'LOCAL').id, group(d, 'APEX').id), SAMPLE, 'already before it');
  m = P(c.moveGroup(d, group(d, 'LOCAL').id));
  assert.deepStrictEqual(titles(m), ['APEX', 'NOVA', 'LOCAL']);
  assert.deepStrictEqual(group(m, 'LOCAL').hosts.map(h => h.alias), ['PVE']);
  // with spacer / sub-folder rows in the file
  const s = P(c.setSpacers(d, true));
  const sm = P(c.moveGroup(s, group(s, 'APEX').id));
  assert.deepStrictEqual(titles(sm), ['LOCAL', 'NOVA', 'APEX']);
  assert.strictEqual(sm.spacers.length, 5);
  assert.strictEqual(text(sm), c.setSpacers(P(c.moveGroup(d, group(d, 'APEX').id)), true));
});

test('reorder and move sub-folders', () => {
  const d = P(SAMPLE);
  const secs = (x, g) => group(x, g).sections.map(s => [s.title, s.hosts.map(h => h.alias).join(',')]);
  // swap the two in APEX (the first one's header sits above the project row in the sample)
  let m = P(c.moveSection(d, group(d, 'LOCAL NETWORK HOSTS').id, group(d, 'APEX').id, group(d, 'HETZNER HOSTS').id));
  assert.deepStrictEqual(m.groups.map(g => [g.title, g.total]), [['LOCAL', 1], ['APEX', 2], ['NOVA', 1]]);
  assert.deepStrictEqual(secs(m, 'APEX'), [['LOCAL NETWORK HOSTS', 'LOCAL-Apex'], ['HETZNER HOSTS', 'HOST-Apex']]);
  assert.ok(text(m).includes('#10.0.0.2'));
  // and back: move the first one last
  m = P(c.moveSection(m, group(m, 'LOCAL NETWORK HOSTS').id, group(m, 'APEX').id));
  assert.deepStrictEqual(secs(m, 'APEX'), [['HETZNER HOSTS', 'HOST-Apex'], ['LOCAL NETWORK HOSTS', 'LOCAL-Apex']]);
  assert.strictEqual(c.moveSection(m, group(m, 'LOCAL NETWORK HOSTS').id, group(m, 'APEX').id), text(m), 'last stays last');
  // into another project
  m = P(c.moveSection(d, group(d, 'HETZNER HOSTS').id, group(d, 'NOVA').id));
  assert.deepStrictEqual(m.groups.map(g => [g.title, g.total]), [['LOCAL', 1], ['APEX', 1], ['NOVA', 2]]);
  assert.deepStrictEqual(secs(m, 'APEX'), [['LOCAL NETWORK HOSTS', 'LOCAL-Apex']]);
  assert.deepStrictEqual(secs(m, 'NOVA'), [['HETZNER HOSTS', 'HOST-Apex']]);
  assert.deepStrictEqual(group(m, 'NOVA').hosts.map(h => h.alias), ['HOST-Nova']);
  m = P(c.moveSection(d, group(d, 'LOCAL NETWORK HOSTS').id, group(d, 'LOCAL').id));
  assert.deepStrictEqual(m.groups.map(g => [g.title, g.total]), [['LOCAL', 2], ['APEX', 1], ['NOVA', 1]]);
  assert.strictEqual(m.hosts.length, d.hosts.length);
});

// ---- optional: a real config file
const real = process.argv[2];
if (real) {
  const src = fs.readFileSync(real, 'utf8');
  const d = c.parse(src, real);
  test(`real file: round-trips (${d.lines.length} lines)`, () => assert.strictEqual(text(d), src.endsWith('\n') ? src : src + '\n'));
  test('real file: every host survives a no-op edit, a favourite toggle and a move', () => {
    for (const h of d.hosts) {
      const edited = c.parse(c.updateHost(d, h.id, c.hostToForm(d, h)), real);
      assert.strictEqual(edited.hosts.length, d.hosts.length, h.alias);
      assert.deepStrictEqual(
        c.findHost(edited, h.id).options.map(o => [o.key, o.value]),
        h.options.map(o => [o.key, o.value]),
        h.alias,
      );
      if (!h.attrs.fav) {
        const fav = c.setHostAttrs(d, h.id, { fav: '1' });
        assert.strictEqual(c.setHostAttrs(c.parse(fav, real), h.id, { fav: undefined }), text(d), h.alias);
      }
      for (const g of d.groups) {
        const moved = c.parse(c.moveHost(d, h.id, g.id), real);
        assert.strictEqual(moved.hosts.length, d.hosts.length, `${h.alias} -> ${g.title}`);
        assert.deepStrictEqual(moved.groups.map(x => x.title), d.groups.map(x => x.title), `${h.alias} -> ${g.title}`);
      }
    }
  });
  test('real file: spacer rows add and remove cleanly', () => {
    const clean = c.parse(c.setSpacers(d, false), real); // the file may already have spacer rows
    const on = c.parse(c.setSpacers(clean, true), real);
    assert.strictEqual(on.hosts.length, d.hosts.length);
    assert.ok(on.spacers.length >= d.groups.filter(g => g.markers.some(m => m.kind === 'separator')).length);
    assert.strictEqual(c.setSpacers(on, true), text(on), 'stable');
    assert.strictEqual(c.setSpacers(on, false), text(clean));
  });
  test('real file: every group and host disables and re-enables exactly', () => {
    const anyOff = g => c.isDisabled(g) || [...g.hosts, ...g.sections.flatMap(x => x.hosts)].some(h => h.disabled);
    for (const g of c.allContainers(d).filter(g => !anyOff(g) && !(g.parent && anyOff(g.parent)))) {
      const off = c.parse(c.setContainerEnabled(d, g.id, false), real);
      assert.strictEqual(off.hosts.length, d.hosts.length, g.title);
      assert.deepStrictEqual(off.groups.map(x => x.title), d.groups.map(x => x.title), g.title);
      assert.strictEqual(c.setContainerEnabled(off, g.id, true), text(d), g.title);
    }
    for (const h of d.hosts.filter(h => !h.disabled)) {
      const off = c.parse(c.setHostEnabled(d, h.id, false), real);
      assert.ok(c.findHost(off, h.id).disabled, h.alias);
      assert.strictEqual(c.setHostEnabled(off, h.id, true), text(d), h.alias);
    }
  });
  test('real file: every project can move to each position without losing anything', () => {
    const sig = x => JSON.stringify(x.hosts.map(h => [h.alias, h.disabled, h.container && h.container.title, h.options.length]).sort());
    const order = x => x.groups.map(g => g.title);
    for (const g of d.groups) {
      for (const before of [undefined, ...d.groups.filter(x => x !== g)]) {
        const m = c.parse(c.moveGroup(d, g.id, before && before.id), real);
        assert.strictEqual(sig(m), sig(d), `${g.title} -> ${before ? before.title : 'end'}`);
        const want = order(d).filter(t => t !== g.title);
        want.splice(before ? want.indexOf(before.title) : want.length, 0, g.title);
        assert.deepStrictEqual(order(m), want, `${g.title} -> ${before ? before.title : 'end'}`);
        assert.strictEqual(m.spacers.length, d.spacers.length);
      }
    }
    for (const s of c.allContainers(d).filter(x => x.parent)) {
      for (const g of d.groups) {
        const m = c.parse(c.moveSection(d, s.id, g.id), real);
        assert.strictEqual(m.hosts.length, d.hosts.length, `${s.title} -> ${g.title}`);
        assert.deepStrictEqual(order(m), order(d), `${s.parent.title}/${s.title} -> ${g.title}`);
      }
    }
  });
  console.log('\n  layout seen in ' + real + ':');
  if (d.rootHosts.length) console.log(`    (no group): ${d.rootHosts.length} hosts`);
  for (const g of d.groups) {
    console.log(`    ${g.title}: ${g.total} hosts` + (g.sections.length ? `  [${g.sections.map(s => `${s.title}: ${s.hosts.length}`).join(', ')}]` : ''));
  }
  console.log(`    includes: ${d.includes.join(', ') || '-'}`);
}

console.log(`\n${n} tests passed`);
