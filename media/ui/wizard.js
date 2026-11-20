// The setup wizard: numbered steps on the left, one topic per screen, Back / Continue.
// Every step can be reached again by clicking it, and the whole wizard can be run again any time.
/* global el, send, art, btn, card, item, toggle, homeOpenBlock, pickerBlock, backupsBlock, syncBlock, keysBlock, shortcutsBlock, foldersBlock, vscode */
let S;
const saved = vscode.getState() || {};
let step = saved.step || 0;
let seen = saved.seen || 0;

function welcomeBlock(S) {
  const c = S.config;
  return [
    card(el('div', { class: 'big' },
      el('div', { class: 'num' }, String(c.hosts)),
      el('div', { class: 'grow' },
        el('div', { class: 't' }, c.exists ? (c.hosts === 1 ? 'host found in your SSH config' : 'hosts found in your SSH config') : 'No SSH config yet'),
        el('div', { class: 'd mono' }, c.path + (c.exists ? '' : '  (created when you add your first host)'))))),
    card(
      item('Nothing is converted', 'Your config file stays a normal SSH config that ssh, Remote-SSH and every other tool read as before. Folders, colors, tags and notes are saved in it as comments.'),
      item('Every change is backed up', 'Before the extension writes anything, it saves a copy next to the file. You can restore any of them later.'),
      item('This takes about a minute', 'Each step is optional. Skip what you do not need; you can run this wizard again from the panel’s ⋯ menu.')),
  ];
}

function backupStep(S) {
  return backupsBlock(S, 4);
}

function homeStep(S) {
  return [
    homeOpenBlock(S),
    card(
      item('Favorites and recent hosts first', 'Then every folder. Type to search, press Enter to connect.'),
      item('Have a look', 'It opens next to this wizard.', btn('Open the Home Page', () => send('command', { id: 'sshManager.home' }), 'ghost'))),
    el('p', { class: 'muted small gap-t' }, 'More choices for the page (what a click does, compact size, recent hosts) are in Settings → Home page.'),
  ];
}

function doneBlock(S) {
  const c = S.config;
  const rows = [
    [c.folders > 0, c.folders > 0 ? c.folders + (c.folders === 1 ? ' folder' : ' folders') + ' and ' + c.subfolders + (c.subfolders === 1 ? ' subfolder' : ' subfolders') : 'No folders yet: add one with the folder button in the panel'],
    [S.s.picker === 'on', S.s.picker === 'on' ? 'The Remote-SSH list is formatted' : 'The Remote-SSH list is left as it is'],
    [S.backups.items.length > 0, S.backups.items.length > 0 ? S.backups.items.length + ' restore point' + (S.backups.items.length === 1 ? '' : 's') + ' saved' : 'Backups start with your first change'],
    [S.sync.mode !== 'off', S.sync.mode !== 'off' ? 'Sync is on: ' + S.sync.file : 'Sync is off: this computer only'],
    [S.keys.missing.length === 0, S.keys.missing.length === 0 ? 'The keys your hosts need are on this computer' : S.keys.missing.length + ' host' + (S.keys.missing.length === 1 ? ' needs a key' : 's need keys') + ' that are not on this computer'],
  ];
  return [
    card(rows.map(([ok, text]) => el('div', { class: 'item' }, el('div', { class: 'status grow' }, el('span', { class: 'dot ' + (ok ? 'ok' : '') }), el('span', {}, text))))),
    el('div', { class: 'row wrap' }, btn('Open the Hosts Panel', () => send('finish')), btn('Open Settings', () => send('command', { id: 'sshManager.settingsPage' }), 'ghost')),
    el('p', { class: 'muted small gap-t' }, 'To see this wizard again: the ⋯ menu at the top of the Hosts panel → Setup Wizard, or run “SSH Manager: Setup Wizard” from the Command Palette.'),
  ];
}

const STEPS = [
  { label: 'Welcome', art: 'welcome', title: 'Welcome to SSH Config Manager', lead: 'Your SSH hosts in one tidy panel: folders, search, one-click connect. Let’s set it up.', body: welcomeBlock },
  { label: 'Folders', art: 'folders', title: 'Organize hosts in folders', lead: 'A folder for each project or customer, subfolders inside for things like Production and Staging.', body: foldersBlock },
  { label: 'Remote-SSH list', art: 'picker', title: 'Tidy the Remote-SSH list too', lead: 'VS Code’s own “Connect to Host” list shows every host in one long row. Give it the same folders, with headings and gaps.', body: pickerBlock },
  { label: 'Backups', art: 'backup', title: 'Backups you can restore', lead: 'A copy of the config is saved in a folder next to it before every change.', body: backupStep },
  { label: 'Sync', art: 'sync', title: 'The same hosts on every computer', lead: 'Optional. Share the config through a file in Dropbox, iCloud Drive or OneDrive.', body: syncBlock },
  { label: 'SSH keys', art: 'keys', title: 'Check your SSH keys', lead: 'Keys are never synced or copied by the extension. This checks the ones your hosts need are on this computer.', body: keysBlock },
  { label: 'Home page', art: 'start', title: 'A home page for your hosts', lead: 'Every host one click away, with the ones you use most on top. It can open by itself when you start the editor.', body: homeStep },
  { label: 'Shortcuts', art: 'shortcuts', title: 'Work from the keyboard', lead: 'Click the Hosts list once, then:', body: S => shortcutsBlock(S, true) },
  { label: 'All set', art: 'done', title: 'You’re all set', lead: 'Here is where things stand.', body: doneBlock },
];

function go(n) {
  step = Math.max(0, Math.min(STEPS.length - 1, n));
  seen = Math.max(seen, step);
  vscode.setState({ step, seen });
  render();
  if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
}

function render() {
  if (!S) return;
  const st = STEPS[step];
  const last = step === STEPS.length - 1;
  const scroll = document.scrollingElement ? document.scrollingElement.scrollTop : 0;
  const bar = el('i');
  bar.style.width = Math.round(((step + 1) / STEPS.length) * 100) + '%';
  document.getElementById('app').replaceChildren(el('div', { class: 'layout' },
    el('nav', { class: 'nav', 'aria-label': 'Setup steps' },
      el('div', { class: 'brand' }, 'SSH Config Manager'), el('div', { class: 'sub' }, 'Setup'),
      STEPS.map((s, i) => el('button', { class: i < step ? 'done' : '', 'aria-current': String(i === step), onclick: () => go(i) },
        el('span', { class: 'n' }, i < step ? '✓' : String(i + 1)), s.label))),
    el('main', { class: 'main' },
      el('div', { class: 'progress' }, bar),
      art(S, st.art), el('h1', {}, st.title), el('p', { class: 'lead' }, st.lead), st.body(S),
      el('div', { class: 'foot' },
        el('span', { class: 'count' }, 'Step ' + (step + 1) + ' of ' + STEPS.length),
        !last && btn('Skip Setup', () => send('finish'), 'ghost'),
        step > 0 && btn('Back', () => go(step - 1), 'ghost'),
        last ? btn('Finish', () => send('finish')) : btn('Continue', () => go(step + 1))))));
  if (document.scrollingElement) document.scrollingElement.scrollTop = scroll;
}

window.addEventListener('message', ({ data }) => {
  if (data.type === 'state') { S = data.state; render(); }
  if (data.type === 'restart') { step = 0; seen = 0; vscode.setState({ step, seen }); render(); }
});
send('ready');
