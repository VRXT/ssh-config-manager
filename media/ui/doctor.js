// The connection test screen: a checklist that fills in as each check finishes, with the fix
// next to whatever went wrong. Uses components.js.
/* global el, send, btn, card, vscode */
const TITLES = [
  ['config', 'Read the ssh config'],
  ['dns', 'Find the server'],
  ['port', 'Reach the SSH port'],
  ['keys', 'Check the key file'],
  ['agent', 'Check the SSH agent'],
  ['hostkey', 'Check the server’s identity'],
  ['login', 'Log in with a key'],
];
const MARK = { ok: '✓', warn: '!', fail: '✕', skip: '–' };
const WORD = { ok: 'Passed', warn: 'Worth a look', fail: 'Problem', skip: 'Skipped' };

let D = null; // { alias, art, steps: {id: step}, running, verdict }

function row(id, title) {
  const s = D.steps[id];
  // steps after a stop (ssh missing, config unreadable) never arrive: show them as not run
  const state = s ? s.status : D.running ? 'run' : 'skip';
  return el('div', { class: 'check ' + state },
    el('div', { class: 'mark', 'aria-hidden': 'true' }, s ? MARK[s.status] : D.running ? '' : MARK.skip),
    el('div', { class: 'grow' },
      el('div', { class: 't' }, title, s && el('span', { class: 'state' }, WORD[s.status])),
      el('div', { class: 'd' }, s ? s.detail : D.running ? 'Checking…' : 'Not run.'),
      s && s.fixes && s.fixes.length && el('div', { class: 'row wrap fixes' },
        s.fixes.map((f, i) => btn(f.label, () => send('fix', { id: f.id, arg: f.arg }), i === 0 && s.status !== 'ok' ? undefined : 'ghost')))));
}

function render() {
  if (!D) return;
  const v = D.verdict;
  document.getElementById('app').replaceChildren(el('main', { class: 'main solo' },
    el('img', { class: 'art', src: D.art, alt: '' }),
    el('h1', {}, 'Connection test: ' + D.alias),
    el('p', { class: 'lead' }, D.running
      ? 'Checking each step between this computer and the server…'
      : 'Each step between this computer and the server, in the order ssh takes them.'),
    v && el('div', { class: 'verdict ' + v.status, role: 'status' }, el('span', { class: 'dot ' + (v.status === 'fail' ? 'bad' : v.status) }), el('span', {}, v.text)),
    card(TITLES.map(([id, title]) => row(id, title))),
    el('div', { class: 'row wrap' },
      btn(D.running ? 'Testing…' : 'Test Again', () => send('run'), D.running ? 'ghost' : undefined),
      !D.running && btn('Copy Report', () => send('copy'), 'ghost'),
      !D.running && btn('Edit Host', () => send('fix', { id: 'editHost' }), 'ghost')),
    el('p', { class: 'muted small gap-t' }, 'The test uses your own ssh program and makes one real connection attempt to this host. It never asks for or stores a password, and it changes nothing unless you press one of the fix buttons.')));
  const again = document.querySelector('.main.solo .row .btn');
  if (again && D.running) again.disabled = true;
}

window.addEventListener('message', ({ data }) => {
  if (data.type === 'start') { D = { alias: data.alias, art: data.art, steps: {}, running: true, verdict: null }; }
  if (data.type === 'step' && D) { D.steps[data.step.id] = data.step; }
  if (data.type === 'done' && D) { D.running = false; D.verdict = data.verdict; }
  render();
});
send('ready');
