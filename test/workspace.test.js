// Plain-node tests for: Remote-SSH list formatting by default, backups, sync, key checks,
// keyboard shortcuts and the manifest.  npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const c = require('../out/sshConfig');
const b = require('../out/backups');
const y = require('../out/sync');
const k = require('../out/keys');
const sc = require('../out/shortcuts');
const pv = require('../out/preview');
const rp = require('../out/remoteProvider');
const pkg = require('../package.json');

let n = 0;
const test = (name, fn) => {
  fn();
  n++;
  console.log('  ok  ' + name);
};
const P = t => c.parse(t, 'config');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sshm-ws-'));
const Z = '\u200b';

// what a new user has after making folders in the GUI: #@group comments, no separator hosts
const GUI = `#@group "Acme Store" color=blue

#@section Production

#@host fav=1
Host web-1
    HostName 203.0.113.21

Host db
    HostName 10.0.1.15

#@section Staging

Host staging
    HostName 198.51.100.30

#@group "Home Lab"

Host nas
    HostName 192.168.1.20
`;

test('Remote-SSH list: GUI-made folders get a heading and a blank row each', () => {
  const on = c.setSpacers(P(GUI), true);
  const d = P(on);
  assert.ok(on.includes(`Host ${Z}-----------Acme\u00a0Store-----------${Z}\n`), 'heading for the first folder');
  assert.ok(on.includes(`Host ${Z}-----------Home\u00a0Lab-----------${Z}${Z}\n`), 'heading for the second folder, unique name');
  assert.ok(on.includes(`Host ${Z}---\u00a0Production\u00a0---`) && on.includes(`Host ${Z}---\u00a0Staging\u00a0---`), 'subfolder headings');
  assert.strictEqual(d.spacers.length, 6, '2 blank rows + 2 folder headings + 2 subfolder headings');
  // the decoration rows change nothing the GUI shows
  assert.deepStrictEqual(d.hosts.map(h => h.alias), ['web-1', 'db', 'staging', 'nas']);
  assert.deepStrictEqual(d.groups.map(g => [g.title, g.total, g.sections.map(s => s.title)]), [['Acme Store', 3, ['Production', 'Staging']], ['Home Lab', 1, []]]);
  assert.strictEqual(d.hosts.find(h => h.alias === 'web-1').attrs.fav, '1', '#@host line still belongs to its host');
  assert.strictEqual(c.setSpacers(d, true), on, 'running it twice changes nothing');
  assert.strictEqual(c.setSpacers(d, false), GUI, 'turning it off restores the file exactly');
});

test('Remote-SSH list: the preview shows headings, gaps and hosts in file order', () => {
  const { rows, more } = pv.remoteListPreview(P(c.setSpacers(P(GUI), true)));
  assert.deepStrictEqual(rows.map(r => r.k + ':' + r.text), [
    'blank:', 'head:-----------Acme Store-----------', 'head:--- Production ---', 'host:web-1', 'host:db', 'head:--- Staging ---', 'host:staging',
    'blank:', 'head:-----------Home Lab-----------', 'host:nas',
  ]);
  assert.strictEqual(more, 0);
  assert.deepStrictEqual(pv.remoteListPreview(P('Host *\n  User x\nHost a b\nHost one\n')).rows, [{ k: 'host', text: 'one' }], 'patterns and multi-name entries are not listed');
  assert.strictEqual(pv.remoteListPreview(P(GUI), 2).more, 2);
});

test('formatting is on by default once there are folders, and stays off when turned off', () => {
  const first = c.finalize(GUI, 'config');
  assert.strictEqual(first.autoEnabled, true, 'switched on by default: the caller tells the user');
  const d = P(first.text);
  assert.strictEqual(d.settings['remote-picker'], 'on');
  assert.strictEqual(d.settings['remote-favorites'], 'on', 'favorites on top come with the default');
  assert.ok(d.spacers.length >= 6 && d.mirror, 'rows and the favorites block are written');
  assert.ok(first.text.includes('Host \u2605web-1'), 'starred host repeated on top');

  const again = c.finalize(first.text, 'config');
  assert.deepStrictEqual(again, { text: first.text, autoEnabled: false }, 'second save: no change, no second notice');

  const off = c.finalize(c.setPickerFormatting(d, false), 'config').text;
  assert.strictEqual(P(off).settings['remote-picker'], 'off');
  assert.strictEqual(P(off).spacers.length, 0, 'rows are gone');
  assert.strictEqual(c.finalize(c.addGroup(P(off), 'Another'), 'config').autoEnabled, false, 'and it stays off after later edits');
  assert.strictEqual(P(c.finalize(c.addGroup(P(off), 'Another'), 'config').text).spacers.length, 0);

  assert.deepStrictEqual(c.finalize('Host a\n    HostName 203.0.113.1\n', 'config'), { text: 'Host a\n    HostName 203.0.113.1\n', autoEnabled: false }, 'no folders: a plain file is left alone');
  assert.strictEqual(c.pickerFormatting(P('Host a\n')), 'off');
  assert.strictEqual(c.pickerFormatting(P(GUI)), 'on');
});

test('a hand-written file that already has its rows keeps its own favorites choice', () => {
  const hand = 'Host -----------APEX-----------\n    HostName 0.0.0.0\n\n#@host fav=1\nHost a\n    HostName 203.0.113.9\n';
  const withRows = c.setSpacers(P(hand), true);
  const out = c.finalize(withRows, 'config');
  assert.strictEqual(out.autoEnabled, false, 'it was on already: nothing to announce');
  assert.strictEqual(P(out.text).settings['remote-picker'], 'on');
  assert.strictEqual(P(out.text).settings['remote-favorites'], undefined, 'favorites block is not forced on');
  assert.ok(!P(out.text).mirror);
});

test('backups: named by date, newest first, no duplicates, oldest pruned', () => {
  const dir = path.join(tmp(), 'ssh-config-backups');
  try {
    assert.strictEqual(b.backupDir('/home/me/.ssh/config'), path.join('/home/me/.ssh', 'ssh-config-backups'));
    assert.strictEqual(b.backupName(new Date(2026, 10, 18, 9, 5, 3)), 'config-2026-11-18_09-05-03.bak');
    assert.deepStrictEqual(b.listBackups(dir), [], 'no folder yet');
    assert.strictEqual(b.writeBackup(dir, ''), undefined, 'an empty config is not backed up');

    const t = i => new Date(2026, 10, 18, 10, i, 0);
    const first = b.writeBackup(dir, 'Host a\nHost b\n', 3, t(1));
    assert.ok(first.endsWith('config-2026-11-18_10-01-00.bak'));
    assert.strictEqual(b.writeBackup(dir, 'Host a\nHost b\n', 3, t(2)), undefined, 'same content as the newest: skipped');
    b.writeBackup(dir, 'Host a\n', 3, t(3));
    b.writeBackup(dir, 'Host a\nHost *\nHost c\n', 3, t(4));
    b.writeBackup(dir, 'Host z\n', 3, t(5));
    const list = b.listBackups(dir);
    assert.deepStrictEqual(list.map(x => x.name), ['config-2026-11-18_10-05-00.bak', 'config-2026-11-18_10-04-00.bak', 'config-2026-11-18_10-03-00.bak'], 'kept the newest 3');
    assert.deepStrictEqual(list.map(x => x.hosts), [1, 2, 1], 'host count, wildcard patterns not counted');
    b.writeBackup(dir, c.setSpacers(P(GUI), true), 9, t(6));
    assert.strictEqual(b.listBackups(dir)[0].hosts, 4, 'the Remote-SSH formatting rows are not counted as hosts');
    fs.unlinkSync(b.listBackups(dir)[0].file);
    assert.strictEqual(list[0].date.getTime(), t(5).getTime());
    assert.ok(!fs.existsSync(first), 'the oldest one was deleted');
    assert.strictEqual(fs.statSync(dir).mode & 0o077, 0, 'folder is private');
    assert.strictEqual(fs.statSync(list[0].file).mode & 0o077, 0, 'files are private');
    const same = b.writeBackup(dir, 'Host q\n', 9, t(5));
    assert.ok(same.endsWith('config-2026-11-18_10-05-00-2.bak'), 'two in the same second do not overwrite each other');
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('backups: "how long ago" wording', () => {
  const now = new Date(2026, 10, 18, 12, 0, 0);
  const back = s => new Date(now.getTime() - s * 1000);
  assert.strictEqual(b.ago(back(5), now), 'just now');
  assert.strictEqual(b.ago(back(60), now), '1 minute ago');
  assert.strictEqual(b.ago(back(60 * 45), now), '45 minutes ago');
  assert.strictEqual(b.ago(back(3600 * 3), now), '3 hours ago');
  assert.strictEqual(b.ago(back(86400), now), 'yesterday');
  assert.strictEqual(b.ago(back(86400 * 6), now), '6 days ago');
});

test('sync, copy both ways: who has to be copied where', () => {
  const [A, B2, C] = ['a', 'b', 'c'];
  assert.strictEqual(y.decideCopy(undefined, undefined, undefined), 'noop');
  assert.strictEqual(y.decideCopy(A, undefined, undefined), 'push', 'shared file does not exist yet');
  assert.strictEqual(y.decideCopy(undefined, A, undefined), 'pull', 'this computer has no config yet');
  assert.strictEqual(y.decideCopy(A, A, undefined), 'noop');
  assert.strictEqual(y.decideCopy(A, B2, undefined), 'conflict', 'different and never synced: ask');
  assert.strictEqual(y.decideCopy(B2, A, A), 'push', 'only this computer changed');
  assert.strictEqual(y.decideCopy(A, B2, A), 'pull', 'only the other computer changed');
  assert.strictEqual(y.decideCopy(B2, C, A), 'conflict', 'both changed');
  assert.strictEqual(y.decideCopy(A, A, C), 'noop', 'both changed to the same thing');
  assert.strictEqual(y.hashText('Host a\r\n'), y.hashText('Host a\n'), 'line endings alone are not a change');
  assert.notStrictEqual(y.hashText('Host a\n'), y.hashText('Host b\n'));
});

test('sync, include: the line in ~/.ssh/config', () => {
  const ssh = path.join(os.homedir(), '.ssh');
  const shared = path.join(os.homedir(), 'Dropbox', 'SSH files', 'ssh_config');
  assert.strictEqual(y.includeLine('C:\\Users\\me\\OneDrive\\SSH\\ssh_config'), 'Include "C:/Users/me/OneDrive/SSH/ssh_config"');
  const line = y.includeLine(shared);
  assert.strictEqual(y.addInclude('', shared), line + '\n');
  const local = 'Host *\n    ServerAliveInterval 30\n';
  const added = y.addInclude(local, shared);
  assert.strictEqual(added, line + '\n\n' + local, 'at the very top, where it applies to every host');
  assert.strictEqual(y.addInclude(added, shared), added, 'not added twice');
  assert.ok(y.hasInclude(added, shared));
  assert.ok(y.hasInclude('include ~/Dropbox/"SSH files"/ssh_config\n', shared) === false, 'a differently quoted path is another path');
  assert.ok(y.hasInclude('Include "~/Dropbox/SSH files/ssh_config"\n', shared), '~ is this user\u2019s home');
  assert.ok(y.hasInclude('Include work\n', path.join(ssh, 'work')), 'relative paths are relative to ~/.ssh');
  assert.ok(!y.hasInclude(local, shared));
  assert.strictEqual(y.removeInclude(added, shared), local, 'removing it restores the file');
  assert.strictEqual(y.removeInclude('Include work ' + `"${shared}"` + '\nHost a\n', shared), 'Include work\nHost a\n', 'other includes on the line are kept');
  // the parser reads the same line, so the hosts of the shared file show up as included
  assert.deepStrictEqual(P(added).includes, [shared.replace(/\\/g, '/')]);
});

if (process.platform !== 'win32') {
  test('sync, link: the config becomes a link and can become a file again', () => {
    const dir = tmp();
    try {
      const local = path.join(dir, 'home', '.ssh', 'config');
      const shared = path.join(dir, 'cloud', 'ssh_config');
      assert.throws(() => y.makeLink(local, shared), /does not exist/);
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, 'Host old\n');
      y.writeContent(shared, 'Host shared\n');
      assert.ok(!y.isLinkTo(local, shared));
      y.makeLink(local, shared);
      assert.ok(y.isLinkTo(local, shared) && y.samePath(local, shared));
      assert.strictEqual(fs.readFileSync(local, 'utf8'), 'Host shared\n', 'reads the shared file');
      fs.writeFileSync(local, 'Host edited\n');
      assert.strictEqual(fs.readFileSync(shared, 'utf8'), 'Host edited\n', 'a write through the link lands in the shared file');
      y.writeContent(local, 'Host again\n');
      assert.ok(y.isLinkTo(local, shared), 'copying into a linked config keeps the link');
      assert.strictEqual(fs.readFileSync(shared, 'utf8'), 'Host again\n');
      y.makeLink(local, shared);
      assert.ok(y.isLinkTo(local, shared), 'linking twice is fine');

      y.unlinkToCopy(local);
      assert.ok(!fs.lstatSync(local).isSymbolicLink() && !y.isLinkTo(local, shared));
      assert.strictEqual(fs.readFileSync(local, 'utf8'), 'Host again\n', 'same content, now a normal file');
      assert.strictEqual(fs.statSync(local).mode & 0o077, 0, 'private');
      fs.writeFileSync(local, 'Host mine\n');
      assert.strictEqual(fs.readFileSync(shared, 'utf8'), 'Host again\n', 'the shared file is no longer touched');
      assert.deepStrictEqual(fs.readdirSync(path.dirname(local)), ['config'], 'no temporary files left behind');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('sync: synced folders are found on this computer', () => {
  const home = tmp();
  try {
    assert.deepStrictEqual(y.cloudFolders(home).filter(f => f.dir.startsWith(home)), []);
    fs.mkdirSync(path.join(home, 'Dropbox'));
    fs.mkdirSync(path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'), { recursive: true });
    fs.mkdirSync(path.join(home, 'Library', 'CloudStorage', 'OneDrive-Personal'), { recursive: true });
    assert.deepStrictEqual(y.cloudFolders(home).filter(f => f.dir.startsWith(home)).map(f => f.label), ['iCloud Drive', 'Dropbox', 'OneDrive']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ssh keys: a host is flagged only when none of its keys is on this computer', () => {
  const home = tmp();
  try {
    fs.mkdirSync(path.join(home, '.ssh'));
    fs.writeFileSync(path.join(home, '.ssh', 'here'), 'key');
    const d = P(`Host ok
    IdentityFile ~/.ssh/here
Host fallback
    IdentityFile ~/.ssh/not-here
    IdentityFile ~/.ssh/here
Host gone
    IdentityFile ~/.ssh/not-here
    IdentityFile "~/Other Place/id"
Host token
    IdentityFile ~/.ssh/%h_key
Host nokey
    HostName 203.0.113.1
#@off Host disabled
#@off     IdentityFile ~/.ssh/not-here
`);
    const missing = k.missingKeys(d, home);
    assert.deepStrictEqual(missing.map(m => [m.alias, m.key]), [['gone', '~/.ssh/not-here'], ['gone', '~/Other Place/id']]);
    assert.strictEqual(missing[0].file, path.join(home, '.ssh', 'not-here'));
    fs.writeFileSync(path.join(home, '.ssh', 'not-here'), 'key');
    assert.deepStrictEqual(k.missingKeys(d, home), [], 'copying one key over is enough');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('remote windows: any editor\'s SSH extension counts, and the right one is suggested', () => {
  const ext = (id, events) => ({ id, packageJSON: { activationEvents: events } });
  assert.strictEqual(rp.findRemoteProvider([]), undefined);
  assert.strictEqual(rp.findRemoteProvider([ext('vrxt.ssh-config-manager', ['onStartupFinished'])]), undefined, 'this extension itself is not one');
  assert.strictEqual(rp.findRemoteProvider([ext('ms-vscode-remote.remote-ssh')]).name, 'Remote - SSH');
  assert.strictEqual(rp.findRemoteProvider([ext('anysphere.remote-ssh')]).name, 'Remote - SSH (Cursor)');
  assert.strictEqual(rp.findRemoteProvider([ext('Jeanp413.Open-Remote-SSH')]).id, 'jeanp413.open-remote-ssh', 'ids are compared without case');
  assert.deepStrictEqual(
    rp.findRemoteProvider([ext('some.other'), ext('acme.fork-remote-ssh', ['onCommand:x', 'onResolveRemoteAuthority:ssh-remote'])]),
    { id: 'acme.fork-remote-ssh', name: 'acme.fork-remote-ssh' },
    'an unknown build is recognized by what it resolves',
  );
  assert.strictEqual(rp.findRemoteProvider([{ id: 'broken.one' }, ext('x.y', 'not-an-array')]), undefined, 'odd manifests do not throw');
  assert.strictEqual(rp.suggestedProvider('Visual Studio Code').id, 'ms-vscode-remote.remote-ssh');
  assert.strictEqual(rp.suggestedProvider('Visual Studio Code - Insiders').id, 'ms-vscode-remote.remote-ssh');
  assert.strictEqual(rp.suggestedProvider('Cursor').id, 'anysphere.remote-ssh');
  assert.strictEqual(rp.suggestedProvider('VSCodium').id, 'jeanp413.open-remote-ssh');
  assert.strictEqual(rp.suggestedProvider('Windsurf').id, 'jeanp413.open-remote-ssh');
});

test('keyboard shortcuts: package.json matches the list, and every shortcut has a real command', () => {
  const contributes = pkg.contributes;
  assert.deepStrictEqual(contributes.keybindings, sc.keybindings(), 'run the manifest generator after changing src/shortcuts.ts');
  const commands = new Set(contributes.commands.map(x => x.command));
  for (const s of sc.SHORTCUTS) {
    assert.ok(commands.has(s.command), s.command);
  }
  // no two shortcuts fight over the same key in the same situation
  for (const field of ['key', 'mac']) {
    const seen = new Set();
    for (const kb of contributes.keybindings) {
      const id = kb[field] + ' | ' + (kb.when || '');
      assert.ok(!seen.has(id), `duplicate ${field}: ${id}`);
      seen.add(id);
    }
  }
  assert.deepStrictEqual(sc.keyCaps(sc.SHORTCUTS[0], 'darwin'), ['\u2318', '\u2325', 'S']);
  assert.deepStrictEqual(sc.keyCaps(sc.SHORTCUTS[0], 'win32'), ['Ctrl', 'Alt', 'S']);
  assert.strictEqual(sc.whenClause(sc.SHORTCUTS.find(s => s.command === 'sshManager.renameGroup')), 'focusedView == sshManager.hosts && sshManager.selection == folder');
});

test('manifest: menus, guide and screens only point at things that exist', () => {
  const contributes = pkg.contributes;
  const commands = new Set(contributes.commands.map(x => x.command));
  for (const [menu, items] of Object.entries(contributes.menus)) {
    for (const m of items) {
      assert.ok(commands.has(m.command), `${menu}: ${m.command}`);
    }
  }
  const root = path.join(__dirname, '..');
  const [guide] = contributes.walkthroughs;
  assert.strictEqual(guide.id, 'sshManager.gettingStarted');
  for (const step of guide.steps) {
    assert.ok(fs.existsSync(path.join(root, step.media.image)), step.media.image);
    assert.ok(step.media.altText);
    for (const [, id] of step.description.matchAll(/\(command:([\w.]+)\)/g)) {
      assert.ok(commands.has(id), `guide step ${step.id}: ${id}`);
    }
    assert.ok(commands.has(step.completionEvents[0].replace('onCommand:', '')));
  }
  for (const name of ['hero', 'welcome', 'folders', 'picker', 'backup', 'sync', 'keys', 'shortcuts', 'settings', 'done']) {
    assert.ok(fs.existsSync(path.join(root, 'media', 'art', name + '.jpg')), name);
  }
  for (const f of ['ui.css', 'components.js', 'settings.js', 'wizard.js']) {
    assert.ok(fs.existsSync(path.join(root, 'media', 'ui', f)), f);
  }
  // the screens ask the extension only for commands it has
  const used = new Set();
  for (const f of ['components.js', 'settings.js', 'wizard.js']) {
    for (const [, id] of fs.readFileSync(path.join(root, 'media', 'ui', f), 'utf8').matchAll(/id: '(sshManager\.[A-Za-z]+)'/g)) {
      used.add(id);
    }
  }
  assert.ok(used.size >= 4);
  for (const id of used) {
    assert.ok(commands.has(id), `screen uses ${id}`);
  }
  // paths are per computer, so these settings must not roam with Settings Sync
  for (const key of ['sshManager.configFile', 'sshManager.sync.mode', 'sshManager.sync.file']) {
    assert.strictEqual(contributes.configuration.properties[key].scope, 'machine', key);
  }
});

console.log(`\n${n} tests passed`);
