// Plain-node tests for reading the config file and explaining read errors:  npm test
const assert = require('assert');
const r = require('../out/readFile');

let n = 0;
const test = (name, fn) => {
  fn();
  n++;
  console.log('  ok  ' + name);
};
const err = (code, message) => Object.assign(new Error(message || code), { code });
const HOME = '/Users/me';
const show = p => (p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);
const ONEDRIVE = HOME + '/Library/CloudStorage/OneDrive-Personal/keys/config';

test('an interrupted read is tried again and then works', () => {
  let calls = 0;
  const slept = [];
  const text = r.readText('/x', { read: () => { if (++calls < 3) throw err('EINTR'); return 'Host a\n'; }, sleep: ms => slept.push(ms) });
  assert.strictEqual(text, 'Host a\n');
  assert.strictEqual(calls, 3);
  assert.deepStrictEqual(slept, [40, 80]);
});

test('it gives up after a few tries and says how many', () => {
  let calls = 0;
  assert.throws(() => r.readText('/x', { read: () => { calls++; throw err('EINTR'); }, sleep: () => undefined }), e => e.code === 'EINTR' && e.attempts === 5);
  assert.strictEqual(calls, 5);
});

test('a missing or forbidden file is not tried again', () => {
  for (const code of ['ENOENT', 'EACCES', 'EISDIR']) {
    let calls = 0;
    assert.throws(() => r.readText('/x', { read: () => { calls++; throw err(code); }, sleep: () => assert.fail('must not wait') }), e => e.code === code && e.attempts === 1);
    assert.strictEqual(calls, 1, code);
  }
});

test('the sync service is recognized from the real path', () => {
  assert.strictEqual(r.cloudService(ONEDRIVE), 'OneDrive');
  assert.strictEqual(r.cloudService(HOME + '/Library/Mobile Documents/com~apple~CloudDocs/ssh/config'), 'iCloud Drive');
  assert.strictEqual(r.cloudService(HOME + '/Dropbox/ssh/config'), 'Dropbox');
  assert.strictEqual(r.cloudService('C:\\Users\\me\\OneDrive\\ssh\\config'), 'OneDrive');
  assert.strictEqual(r.cloudService(HOME + '/Library/CloudStorage/Box-Box/config'), 'a cloud-synced folder');
  assert.strictEqual(r.cloudService(HOME + '/.ssh/config'), undefined);
});

test('EINTR on a link into OneDrive: named, explained, and retried by itself', () => {
  const e = Object.assign(err('EINTR', 'EINTR: interrupted system call, read'), { attempts: 5 });
  const p = r.explainReadError(e, HOME + '/.ssh/config', ONEDRIVE, show, 'darwin');
  assert.strictEqual(p.title, 'Cannot read ~/.ssh/config');
  assert.ok(p.why.includes('OneDrive') && p.why.includes('EINTR'), p.why);
  assert.strictEqual(p.retrying, true);
  assert.ok(p.steps.some(s => s.includes('Always Keep on This Device')));
  assert.ok(p.steps.some(s => s.includes(`cat "${ONEDRIVE}"`)));
  const report = r.problemReport(p).join('\n');
  assert.ok(report.includes('Links to: ' + ONEDRIVE) && report.includes('tried 5 times') && report.includes('interrupted system call'), report);
});

test('the same error on a plain file does not blame a sync app', () => {
  const p = r.explainReadError(err('EINTR'), HOME + '/.ssh/config', HOME + '/.ssh/config', show, 'linux');
  assert.ok(!/OneDrive|sync app/.test(p.why + p.steps.join(' ')), p.why);
  assert.ok(!r.problemReport(p).join('\n').includes('Links to'));
});

test('no permission, a folder, anything else', () => {
  const file = HOME + '/.ssh/config';
  const perm = r.explainReadError(err('EACCES'), file, file, show, 'darwin');
  assert.ok(perm.steps[0].includes('chmod 600') && perm.steps.some(s => s.includes('Privacy & Security')) && !perm.retrying);
  assert.ok(!r.explainReadError(err('EACCES'), file, file, show, 'linux').steps.some(s => s.includes('Privacy & Security')));
  assert.ok(r.explainReadError(err('EISDIR'), file, file, show).why.includes('is a folder'));
  const other = r.explainReadError(err('EWHATEVER', 'EWHATEVER: something odd'), file, file, show);
  assert.ok(other.why.includes('something odd') && !other.retrying);
});

console.log(`\n${n} tests passed`);
