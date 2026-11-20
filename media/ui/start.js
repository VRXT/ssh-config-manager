// The home page: favorites, recent hosts and every folder on one screen, with a search box that
// keeps the focus. A click or Enter connects. Uses components.js.
/* global el, send, btn, vscode */
let S = null;
const saved = vscode.getState() || {};
let query = saved.query || '';
let only = saved.only || 'all'; // all | up | down
let collapsed = new Set();
let busy = ''; // key of the tile that was just used
let built = false;

const LABEL = { terminal: 'Terminal', window: 'This window', newWindow: 'New window' };
const DOES = { terminal: 'connect in a terminal', window: 'open in this window', newWindow: 'open in a new window' };
const DOING = { terminal: 'Connecting in a terminal', window: 'Opening in this window', newWindow: 'Opening in a new window' };
const OPENS = {
  emptyWindow: 'Opens by itself when the editor starts with no folder open.',
  always: 'Opens by itself every time the editor starts.',
  never: 'Does not open by itself.',
};

const keep = () => vscode.setState({ query, only });
const words = () => query.toLowerCase().split(/\s+/).filter(Boolean);
const shown = h => (only === 'all' || h.status === only) && words().every(w => h.hay.includes(w));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;

// ---------------------------------------------------------------- connecting

let toastTimer;
function toast(text) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}

function connect(h, key, how) {
  how = how || S.primary;
  send('connect', { name: h.name, how });
  // opening a window takes a moment and shows nothing meanwhile: say that it is happening
  busy = key;
  toast(`${DOING[how]}: ${h.alias}`);
  render();
  setTimeout(() => { if (busy === key) { busy = ''; render(); } }, 2600);
}

// ---------------------------------------------------------------- tiles

/** `text` with the search words marked. */
function marked(text) {
  const low = text.toLowerCase();
  const hits = [];
  for (const w of words()) {
    for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + w.length)) hits.push([i, i + w.length]);
  }
  if (!hits.length) return text;
  hits.sort((a, b) => a[0] - b[0]);
  const out = [];
  let at = 0;
  for (const [s, e] of hits) {
    if (s < at) continue;
    if (s > at) out.push(text.slice(at, s));
    out.push(el('mark', {}, text.slice(s, e)));
    at = e;
  }
  out.push(text.slice(at));
  return out;
}

const spoken = (h, sub) =>
  `${h.alias}, ${sub || 'no address'}, ${h.status === 'up' ? 'up' : h.status === 'down' ? 'down' : 'not checked'}. Enter to ${DOES[S.primary]}.`;
const folderNote = f => (f.down ? `${f.total} · ${f.down} down` : String(f.total));

const act = (label, title, fn, cls) =>
  el('span', { class: 'act' + (cls ? ' ' + cls : ''), role: 'button', title, 'aria-label': title, onclick: e => { e.stopPropagation(); fn(); } }, label);

function tile(h, sec, showFolder) {
  const key = sec + '|' + h.name;
  // a recent host says when it was used, which matters more there than where it is filed
  const when = sec === 'recent' && S.when[h.name];
  const sub = (when ? [h.detail, when] : [h.detail, h.provider, showFolder && h.folder]).filter(Boolean).join(' · ');
  return el('button', {
    class: 'tile' + (h.color ? ' c-' + h.color : '') + (busy === key ? ' busy' : ''), 'data-key': key, 'data-name': h.name, 'data-sub': sub, title: h.note || undefined,
    'aria-label': spoken(h, sub),
    onclick: e => connect(h, key, e.metaKey || e.ctrlKey ? 'terminal' : undefined),
  },
    el('span', { class: 'dot ' + h.status, 'aria-hidden': 'true' }),
    el('span', { class: 'grow' },
      el('span', { class: 'a' }, marked(h.alias), h.fav && el('span', { class: 'star', 'aria-hidden': 'true' }, '★')),
      el('span', { class: 'd' }, sub ? marked(sub) : ' '),
      h.tags.length ? el('span', { class: 'chips' }, h.tags.slice(0, 4).map(t => el('span', { class: 'chip' }, '#' + t))) : null),
    el('span', { class: 'acts' },
      ['terminal', 'window', 'newWindow'].filter(k => k !== S.primary).map(k => act(LABEL[k], DOES[k], () => connect(h, key, k))),
      h.editable && act(h.fav ? '★' : '☆', h.fav ? 'Remove from favorites' : 'Add to favorites', () => send('favorite', { name: h.name }), 'icon' + (h.fav ? ' on' : '')),
      h.editable && act('✎', 'Edit host', () => send('edit', { name: h.name }), 'icon')));
}

// ---------------------------------------------------------------- sections

function toggleSection(key) {
  collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key);
  send('collapsed', { keys: [...collapsed] });
  render();
}

/** One heading with its hosts. opts: { key, subfolders, note, link, showFolder, color } */
function section(title, hosts, opts) {
  const subs = (opts.subfolders || []).map(g => ({ title: g.title, hosts: g.hosts.filter(shown) })).filter(g => g.hosts.length);
  hosts = hosts.filter(shown);
  const count = hosts.length + subs.reduce((n, g) => n + g.hosts.length, 0);
  if (!count) return null;
  const closed = collapsed.has(opts.key) && !words().length;
  return el('section', { class: 'sec' + (closed ? ' closed' : ''), 'data-sec': opts.key },
    el('div', { class: 'head' },
      el('button', { class: 'fold' + (opts.color ? ' c-' + opts.color : ''), 'aria-expanded': String(!closed), onclick: () => toggleSection(opts.key) },
        el('span', { class: 'chev', 'aria-hidden': 'true' }, closed ? '▸' : '▾'), el('h2', {}, title), el('span', { class: 'n' }, opts.note || String(count))),
      el('span', { class: 'line' }), opts.link),
    closed ? null : [
      hosts.length ? el('div', { class: 'tiles' }, hosts.map(h => tile(h, opts.key, opts.showFolder))) : null,
      subs.map(g => [el('div', { class: 'sub' }, g.title, el('span', { class: 'n' }, String(g.hosts.length))), el('div', { class: 'tiles' }, g.hosts.map(h => tile(h, opts.key + '/' + g.title)))]),
    ]);
}

const everyHost = m => [...m.folders.flatMap(f => [...f.hosts, ...f.subfolders.flatMap(s => s.hosts)]), ...m.loose, ...m.included.flatMap(i => i.hosts)];

function list() {
  const m = S.model;
  if (S.error) return el('div', { class: 'note' }, el('b', {}, 'The config file could not be read'), S.error);
  if (!m.total) {
    return el('div', { class: 'empty' },
      el('img', { src: S.art.empty, alt: '' }),
      el('h2', {}, 'No hosts yet'),
      el('p', { class: 'muted' }, 'Add your first server and it shows up here, one click away.'),
      el('div', { class: 'row wrap' }, btn('Add Host', () => send('command', { id: 'sshManager.addHost' })), btn('Setup Wizard', () => send('command', { id: 'sshManager.wizard' }), 'ghost')));
  }
  if (words().length) {
    const hits = everyHost(m).filter(shown);
    return hits.length
      ? section(plural(hits.length, 'result'), everyHost(m), { key: 'results', showFolder: true, note: `Enter: ${DOES[S.primary]} the first` })
      : el('div', { class: 'none' }, `No host matches “${query}”${only === 'all' ? '' : ' among the hosts that are ' + only}. `,
        el('a', { role: 'button', tabindex: '0', onclick: reset }, 'Clear the search'));
  }
  const names = m.folders.map(f => 'f:' + f.title);
  const allClosed = names.length > 0 && names.every(k => collapsed.has(k));
  const out = [
    section('Favorites', m.favorites, { key: 'fav', showFolder: true }),
    section('Recent', m.recent, { key: 'recent', showFolder: true, link: el('a', { role: 'button', tabindex: '0', onclick: () => send('clearRecent') }, 'Clear') }),
    names.length > 1 && el('div', { class: 'allhead' }, el('span', {}, plural(names.length, 'folder')), el('span', { class: 'line' }),
      el('a', { role: 'button', tabindex: '0', onclick: () => { names.forEach(k => (allClosed ? collapsed.delete(k) : collapsed.add(k))); send('collapsed', { keys: [...collapsed] }); render(); } },
        allClosed ? 'Expand all' : 'Collapse all')),
    m.folders.map(f => section(f.title, f.hosts, { key: 'f:' + f.title, subfolders: f.subfolders, color: f.color, note: folderNote(f) })),
    section('No folder', m.loose, { key: 'loose' }),
    m.included.map(i => section('Included: ' + i.title, i.hosts, { key: 'i:' + i.title })),
  ].flat(Infinity).filter(Boolean);
  return out.some(n => n.tagName === 'SECTION') ? out : el('div', { class: 'none' }, `No host is ${only} right now. `, el('a', { role: 'button', tabindex: '0', onclick: reset }, 'Show all hosts'));
}

function reset() {
  query = '';
  only = 'all';
  keep();
  const q = document.getElementById('q');
  q.value = '';
  q.focus();
  render();
}

// ---------------------------------------------------------------- page

function setOnly(v) {
  only = only === v ? 'all' : v;
  keep();
  render();
}

function stats() {
  const m = S.model;
  const pill = (v, text, dot) => el('button', { class: 'stat', 'aria-pressed': String(only === v), title: only === v ? 'Show all hosts' : `Show only the hosts that are ${v}`, onclick: () => setOnly(v) },
    el('span', { class: 'dot ' + dot }), text);
  return el('div', { class: 'stats' },
    el('span', { class: 'stat plain' }, plural(m.total, 'host') + (m.folders.length ? ' in ' + plural(m.folders.length, 'folder') : '')),
    m.up ? pill('up', `${m.up} up`, 'ok') : null,
    m.down ? pill('down', `${m.down} down`, 'bad') : null);
}

function header() {
  if (!S.opts.banner) {
    return el('div', { class: 'slim' }, el('h1', {}, 'SSH Home'), stats());
  }
  return el('div', { class: 'banner' },
    el('img', { src: S.art.banner, alt: '' }), el('div', { class: 'shade' }),
    el('div', { class: 'txt' }, el('h1', {}, 'SSH Home'), el('p', {}, 'Pick a server and you are in.'), stats()));
}

function foot() {
  return [
    el('span', { class: 'grow' }, OPENS[S.opts.open] + ' ', el('a', { role: 'button', tabindex: '0', onclick: () => send('settings') }, 'Home page settings')),
    btn('Add Folder', () => send('command', { id: 'sshManager.addGroup' }), 'ghost'),
    btn('Hosts Panel', () => send('command', { id: 'sshManager.hosts.focus' }), 'ghost'),
    btn('Config File', () => send('command', { id: 'sshManager.openConfig' }), 'ghost'),
  ];
}

function render() {
  if (!S) return;
  const app = document.getElementById('app');
  if (!built) {
    built = true;
    app.replaceChildren(el('div', { class: 'home', id: 'home' },
      el('div', { id: 'header' }),
      el('div', { class: 'find' },
        el('input', { id: 'q', type: 'text', value: query, placeholder: 'Search hosts by name, address, tag, folder or provider', 'aria-label': 'Search hosts', spellcheck: 'false', autocomplete: 'off',
          oninput: e => { query = e.target.value; keep(); render(); } }),
        el('span', { class: 'hint', id: 'hint' }),
        btn('Add Host', () => send('command', { id: 'sshManager.addHost' })),
        el('button', { class: 'btn ghost', title: 'Check which servers are up', onclick: () => { send('recheck'); toast('Checking which servers are up…'); } }, 'Check Status')),
      el('div', { id: 'list' }),
      el('div', { class: 'homefoot', id: 'foot' }),
      el('div', { id: 'toast', role: 'status', 'aria-live': 'polite' })));
    document.getElementById('q').focus();
  }
  // a redraw (a status came in, a setting changed) must not take the keyboard away from a host
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : '';
  document.getElementById('home').className = 'home ' + S.opts.density;
  document.getElementById('header').replaceChildren(header());
  document.getElementById('hint').textContent = `Search, then Enter: ${DOES[S.primary]} · ${S.mac ? '⌘' : 'Ctrl'}+Enter: terminal`;
  document.getElementById('list').replaceChildren(...[list()].flat(Infinity).filter(Boolean));
  document.getElementById('foot').replaceChildren(...foot());
  if (focused) {
    const again = [...document.querySelectorAll('.tile')].find(t => t.dataset.key === focused);
    if (again) again.focus({ preventScroll: true });
  }
}

/**
 * Only the up / down state of some hosts changed, which happens every time a status check
 * finishes: recolor the dots where they are instead of building the whole list again.
 */
function patchStatus() {
  const by = new Map(everyHost(S.model).map(h => [h.name, h]));
  for (const t of document.querySelectorAll('.tile')) {
    const h = by.get(t.dataset.name);
    if (h) {
      t.firstChild.className = 'dot ' + h.status;
      t.setAttribute('aria-label', spoken(h, t.dataset.sub));
    }
  }
  const notes = new Map(S.model.folders.map(f => ['f:' + f.title, folderNote(f)]));
  for (const sec of document.querySelectorAll('.sec')) {
    const note = notes.get(sec.dataset.sec);
    if (note) sec.querySelector('.fold .n').textContent = note;
  }
  document.getElementById('header').replaceChildren(header());
}

/** The state without anything a status check changes. */
const shape = state => JSON.stringify(state, (k, v) => (k === 'status' || k === 'up' || k === 'down' || k === 'collapsed' ? undefined : v));
let lastState = '';
let lastShape = '';

function receive(state) {
  // Which folders are folded is taken from the extension once, when the page opens. After that the
  // page decides: a status update that was already on its way must not undo a click made just now.
  if (built) state.collapsed = [...collapsed]; else collapsed = new Set(state.collapsed);
  const text = JSON.stringify(state);
  if (text === lastState) return; // the config was re-read and nothing changed
  const sh = shape(state);
  // with a status filter on, a changed status changes which hosts are listed: redraw then
  const statusOnly = built && sh === lastShape && only === 'all';
  lastState = text;
  lastShape = sh;
  S = state;
  statusOnly ? patchStatus() : render();
}

// ---------------------------------------------------------------- keyboard
// Type anywhere to search. Arrows walk the hosts as the grid they are drawn in. Enter in the search
// box takes the first host. Esc clears. "/" goes back to the search box.

function vertical(tiles, from, down) {
  const a = from.getBoundingClientRect();
  let best = null;
  let bestScore = Infinity;
  for (const t of tiles) {
    const b = t.getBoundingClientRect();
    const dy = down ? b.top - a.top : a.top - b.top;
    if (dy < 4) continue; // same row, or the wrong way
    const score = dy * 4 + Math.abs(b.left - a.left); // the nearest row first, then the nearest column
    if (score < bestScore) { bestScore = score; best = t; }
  }
  return best;
}

document.addEventListener('keydown', e => {
  const q = document.getElementById('q');
  if (!q) return;
  const active = document.activeElement;
  const tiles = [...document.querySelectorAll('.tile')];
  const at = tiles.indexOf(active);
  const typing = active === q;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!tiles.length || active.tagName === 'SELECT') return;
    e.preventDefault();
    if (at < 0) { if (e.key === 'ArrowDown') tiles[0].focus(); return; }
    const next = vertical(tiles, active, e.key === 'ArrowDown');
    if (next) next.focus(); else if (e.key === 'ArrowUp') q.focus();
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && at >= 0) {
    e.preventDefault();
    const next = tiles[at + (e.key === 'ArrowRight' ? 1 : -1)];
    if (next) next.focus();
  } else if (e.key === 'Enter' && typing) {
    // only after a search: a stray Enter on the freshly opened page must not connect to anything
    if (tiles.length && words().length) { e.preventDefault(); tiles[0].dispatchEvent(new MouseEvent('click', { metaKey: e.metaKey, ctrlKey: e.ctrlKey })); }
  } else if (e.key === 'Enter' && at >= 0 && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    tiles[at].dispatchEvent(new MouseEvent('click', { metaKey: true }));
  } else if ((e.key === 'Enter' || e.key === ' ') && active && active.getAttribute('role') === 'button' && active.tagName === 'A') {
    e.preventDefault();
    active.click();
  } else if (e.key === 'Escape') {
    if (query || only !== 'all') reset(); else q.focus();
  } else if (e.key === '/' && !typing) {
    e.preventDefault();
    q.focus();
    q.select();
  } else if (e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey && !typing && active.tagName !== 'SELECT') {
    q.focus(); // the key then types into the box
  }
});

window.addEventListener('message', ({ data }) => {
  if (data.type === 'state') receive(data.state);
});
send('ready');
