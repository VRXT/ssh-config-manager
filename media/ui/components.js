// Shared building blocks of the settings page and the setup wizard.
// `S` is the state object the extension posts; `send(type, data)` asks the extension to do something.
/* global acquireVsCodeApi */
const vscode = acquireVsCodeApi();
const send = (type, data) => vscode.postMessage(Object.assign({ type }, data || {}));

/** el('div', { class: 'x', onclick: fn }, child, 'text', ...) */
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid !== undefined && kid !== null && kid !== false) e.append(kid);
  return e;
}

const art = (S, name, alt) => el('img', { class: 'art', src: S.art[name], alt: alt || '' });
const btn = (label, onclick, kind) => el('button', { class: 'btn' + (kind ? ' ' + kind : ''), onclick }, label);
const card = (...kids) => el('div', { class: 'card' }, kids);

/** One setting: title and description on the left, the control on the right. */
function item(title, desc, control, top) {
  return el('div', { class: 'item' + (top ? ' top' : '') }, el('div', { class: 'grow' }, el('div', { class: 't' }, title), desc && el('div', { class: 'd' }, desc)), control);
}

function toggle(on, onchange, label, disabled) {
  return el('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!on), 'aria-label': label, disabled, onclick: () => onchange(!on) });
}

function seg(options, value, onpick, disabled) {
  return el('div', { class: 'seg', role: 'group' }, options.map(o => el('button', { 'aria-pressed': String(o.v === value), disabled, onclick: () => o.v !== value && onpick(o.v) }, o.l)));
}

/** Pick-one cards. options: [{ v, t, d, badge }] */
function opts(options, value, onpick, cls) {
  return el('div', { class: 'opts' + (cls ? ' ' + cls : '') }, options.map(o =>
    el('button', { class: 'opt', 'aria-pressed': String(o.v === value), onclick: () => onpick(o.v) },
      el('span', { class: 'tick' }), el('span', { class: 't' }, o.t, o.badge && el('span', { class: 'badge' }, o.badge)), el('span', { class: 'd' }, o.d))));
}

const statusLine = (kind, text) => el('div', { class: 'status' }, el('span', { class: 'dot ' + kind }), el('span', {}, text));
const note = (title, text, info) => el('div', { class: 'note' + (info ? ' info' : '') }, el('b', {}, title), text);
const setting = (key, value) => send('set', { key, value });

// ---------------------------------------------------------------- Remote-SSH list

/** How the stock Remote-SSH host list looks with the current file: rows [{ k: 'head' | 'host' | 'blank', text }]. */
function pickerPreview(S) {
  const rows = S.preview.length ? S.preview : [{ k: 'host', text: 'your-first-host' }];
  let marked = false;
  return el('div', { class: 'picker', 'aria-label': 'Preview of the Remote-SSH host list' },
    el('div', { class: 'in' }, 'Select configured SSH host…'),
    rows.map(r => {
      const sel = !marked && r.k === 'host';
      marked = marked || sel;
      return el('div', { class: 'r' + (r.k === 'head' ? ' h' : '') + (sel ? ' sel' : '') }, r.text || ' ');
    }),
    S.previewMore > 0 && el('div', { class: 'r h' }, '… and ' + S.previewMore + ' more'));
}

function pickerBlock(S) {
  const on = S.s.picker === 'on';
  return [
    card(
      item('Format the Remote-SSH host list', 'Adds a heading for every folder and subfolder and a blank row between folders, so the list VS Code shows for Remote-SSH is grouped like this panel instead of one long list.',
        toggle(on, v => send('picker', { on: v }), 'Format the Remote-SSH host list')),
      item('Subfolder headings', 'How a subfolder is announced in that list.',
        seg([{ v: 'dashes', l: '--- Name ---' }, { v: 'arrow', l: '▾ Name' }, { v: 'off', l: 'None' }], S.s.subfolders, v => setting('remote-subfolders', v), !on)),
      item('Favorites on top', 'Repeats your starred hosts at the top of the list as ★name.',
        toggle(S.s.remoteFavorites === 'on', v => setting('remote-favorites', v ? 'on' : 'off'), 'Favorites on top'))),
    S.s.pickerUndecided && note('Not switched on yet', 'It turns on by itself with your next change (a new host or folder, for example). Use the switch above to turn it on now, or to keep the plain list.', true),
    el('div', { class: 'where' }, 'Preview: your Remote-SSH list now'),
    pickerPreview(S),
    el('p', { class: 'muted small gap-t' }, 'These rows are written into the config file as harmless extra Host lines. Turning the switch off removes them again.'),
  ];
}

// ---------------------------------------------------------------- backups

function backupsBlock(S, limit) {
  const B = S.backups;
  const list = B.items.slice(0, limit || B.items.length);
  return [
    card(
      item('Backups folder', el('span', { class: 'mono' }, B.dir), el('div', { class: 'row' }, btn('Open Folder', () => send('openBackups'), 'ghost'), btn('Back Up Now', () => send('backupNow')))),
      item('How many to keep', 'A backup is saved automatically before every change. The oldest ones are deleted beyond this number.',
        el('input', { type: 'number', min: '1', max: '500', value: String(B.keep), class: 'num', 'aria-label': 'How many backups to keep',
          onchange: e => send('keep', { value: Number(e.target.value) }) }))),
    el('div', { class: 'where' }, B.items.length ? 'Restore points (' + B.items.length + ')' : 'No backups yet'),
    list.length ? card(list.map(b => el('div', { class: 'item' },
      el('div', { class: 'grow' }, el('div', { class: 't' }, b.ago), el('div', { class: 'd' }, b.when + ' · ' + b.hosts + (b.hosts === 1 ? ' host' : ' hosts') + ' · ' + b.size)),
      el('div', { class: 'row' }, btn('Compare', () => send('compareBackup', { file: b.file }), 'ghost'), btn('Restore', () => send('restoreBackup', { file: b.file }), 'ghost')))))
      : el('p', { class: 'muted' }, 'The first backup is made the next time anything changes, or right now with Back Up Now.'),
    B.items.length > list.length && el('p', { class: 'muted small' }, 'Showing the newest ' + list.length + '. Open the folder to see all of them.'),
  ];
}

// ---------------------------------------------------------------- sync

function keysNote(S) {
  return note('Your SSH keys are not synced',
    el('span', {}, 'Only the config file is shared. For safety, private keys stay on each computer: copy them to your other computers yourself (to the same path the config uses, for example ', el('code', {}, '~/.ssh'), '), or make a new key there with ', el('b', { class: 'inl' }, 'Set Up SSH Key…'), '.'));
}

function syncBlock(S) {
  const Y = S.sync;
  const kind = Y.state === 'ok' ? 'ok' : Y.state === 'off' ? '' : Y.state === 'conflict' ? 'warn' : 'bad';
  const cards = [{ v: 'off', t: 'Off', d: 'The config lives on this computer only.' }].concat(Y.modes.map(m => ({ v: m.id, t: m.label, d: m.summary, badge: m.id === 'copy' ? 'Recommended' : undefined })));
  return [
    card(el('div', { class: 'stack' },
      statusLine(kind, Y.message + (Y.lastAgo ? ' Last checked ' + Y.lastAgo + '.' : '')),
      Y.file && el('div', { class: 'd mono indent tight' }, Y.file),
      Y.mode !== 'off' && el('div', { class: 'row wrap indent gap-t' },
        Y.mode === 'copy' && btn('Sync Now', () => send('syncNow')),
        Y.state !== 'ok' && btn('Repair…', () => send('syncSetup', { mode: Y.mode })),
        btn('Change File…', () => send('syncSetup', { mode: Y.mode }), 'ghost'),
        btn('Turn Off', () => send('syncOff'), 'danger')))),
    el('div', { class: 'where' }, 'How this computer uses the shared file'),
    opts(cards, Y.mode, v => (v === 'off' ? Y.mode !== 'off' && send('syncOff') : send('syncSetup', { mode: v })), 'two'),
    el('p', { class: 'muted small gap-t' }, 'Pick a file inside your Dropbox, iCloud Drive or OneDrive folder. Then do the same on your other computers and choose the same file.'),
    keysNote(S),
  ];
}

// ---------------------------------------------------------------- ssh keys

function keysBlock(S) {
  const K = S.keys;
  const all = K.missing.length === 0;
  return [
    card(el('div', { class: 'stack' },
      statusLine(all ? 'ok' : 'warn', K.withKeys === 0 ? 'No host in your config names a key file.' : all
        ? 'All ' + K.withKeys + (K.withKeys === 1 ? ' host that names a key has' : ' hosts that name a key have') + ' it on this computer.'
        : K.missing.length + (K.missing.length === 1 ? ' host uses a key' : ' hosts use keys') + ' that are not on this computer.'),
      el('div', { class: 'row wrap indent gap-t' }, btn('Check Keys…', () => send('checkKeys'), all ? 'ghost' : undefined)))),
    !all && card(K.missing.slice(0, 12).map(m => el('div', { class: 'item' },
      el('div', { class: 'grow' }, el('div', { class: 't' }, m.alias), el('div', { class: 'd mono' }, m.keys.join('  ·  '))),
      btn('Set Up Key…', () => send('setupKey', { hostId: m.hostId }), 'ghost')))),
    K.missing.length > 12 && el('p', { class: 'muted small' }, 'And ' + (K.missing.length - 12) + ' more. Use Check Keys to see all of them.'),
    note('On a new computer', el('span', {}, 'Copy your private keys there yourself (never through the shared config), keep them at the same path, and make sure only you can read them. Or right-click a host and choose ',
      el('b', { class: 'inl' }, 'Set Up SSH Key…'), ' to make a new key and install it on the server in one step.'), true),
  ];
}

// ---------------------------------------------------------------- shortcuts

function shortcutsBlock(S, compact) {
  const out = [];
  for (const group of ['Connect', 'Organize', 'Find']) {
    const list = S.shortcuts.filter(s => s.group === group);
    out.push(el('div', { class: 'where' }, group));
    out.push(card(el('div', { class: 'keys' }, list.map(s => [
      el('div', {}, s.label, s.where === 'anywhere' && el('span', { class: 'badge' }, 'anywhere')),
      el('div', { class: 'k' }, s.caps.map(c => el('kbd', {}, c))),
    ]))));
  }
  if (!compact) {
    out.unshift(el('p', { class: 'muted' }, 'Shortcuts work while the Hosts list has focus (click it once), except the ones marked “anywhere”. They also show next to each action in the right-click menu.'));
  }
  out.push(el('div', { class: 'row tight' }, btn('Customize in VS Code…', () => send('keybindings'), 'ghost')));
  return out;
}

// ---------------------------------------------------------------- folders

function foldersBlock(S) {
  const c = S.config;
  return [
    card(
      item('Your folders', c.folders + (c.folders === 1 ? ' folder' : ' folders') + ', ' + c.subfolders + (c.subfolders === 1 ? ' subfolder' : ' subfolders') + ', ' + c.hosts + (c.hosts === 1 ? ' host' : ' hosts') + (c.loose ? ' (' + c.loose + ' not in a folder yet)' : ''),
        el('div', { class: 'row' }, btn('New Folder', () => send('command', { id: 'sshManager.addGroup' })), btn('New Host', () => send('command', { id: 'sshManager.addHost' }), 'ghost')))),
    card(
      item('Folders and subfolders', 'A folder holds hosts and subfolders, like in Finder or Explorer: for example a folder per project or customer, with subfolders such as Production and Staging.'),
      item('Move things by dragging', 'Drag a host onto a folder or subfolder to move it there, or onto another host to place it next to it. Right-click anything for Rename, Move, Color and Icon.'),
      item('Turn a whole folder off', 'Right-click a folder and choose Enable / Disable to hide all of its hosts from ssh without deleting them.')),
  ];
}
