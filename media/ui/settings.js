// The settings page: sections on the left, cards on the right. Uses components.js.
/* global el, send, art, btn, card, item, toggle, seg, opts, setting, note, homeOpenBlock, pickerBlock, backupsBlock, syncBlock, keysBlock, shortcutsBlock, foldersBlock, vscode */
let S;
let current = (vscode.getState() || {}).section || 'general';

function generalBlock(S) {
  const c = S.config;
  return [
    card(item('Config file', el('span', { class: 'mono' }, c.path + (c.exists ? '' : '  (created when you add your first host)')),
      el('div', { class: 'row' },
        btn('Open', () => send('command', { id: 'sshManager.openConfig' }), 'ghost'),
        btn('Change…', () => send('browseConfig'), 'ghost'),
        !c.isDefault && S.sync.mode !== 'include' && btn('Use ~/.ssh/config', () => send('resetConfig'), 'ghost')))),
    card(
      item('Order of hosts', 'Inside each folder.', seg([{ v: 'file', l: 'As in the file' }, { v: 'name', l: 'By name' }], S.s.sort, v => setting('sort', v))),
      item('Favorites section', 'Show your starred hosts pinned at the top of the panel.', toggle(S.s.favorites !== 'off', v => setting('favorites', v ? 'on' : 'off'), 'Favorites section')),
      item('Automatic icons', 'Pick an icon from where a host runs (home network, VPN, cloud) when it has none of its own.', toggle(S.s.autoicon !== 'off', v => setting('autoicon', v ? 'on' : 'off'), 'Automatic icons'))),
    el('div', { class: 'where' }, 'When you click a host'),
    opts([
      { v: 'none', t: 'Just select it', d: 'Connect with Enter or the buttons on the row.' },
      { v: 'terminal', t: 'Connect in a terminal', d: 'Opens an ssh session in the terminal panel.' },
      { v: 'window', t: 'Open in this window', d: 'Remote-SSH, replacing the current window.' },
      { v: 'newWindow', t: 'Open in a new window', d: 'Remote-SSH, in a window of its own.' },
      { v: 'edit', t: 'Open the edit form', d: 'Change the host’s details.' },
    ], S.s.click, v => setting('click', v)),
    el('p', { class: 'muted small gap-t' }, 'These choices are saved inside the config file itself (a #@ssh-manager comment line), so they follow the file to your other computers.'),
  ];
}

function homeBlock(S) {
  const h = S.home;
  const set = (key, value) => send('home', { key, value });
  const panel = { terminal: 'connect in a terminal', window: 'open in this window' }[h.panelClick] || 'open in a new window';
  return [
    el('div', { class: 'row wrap' }, btn('Open the Home Page', () => send('command', { id: 'sshManager.home' }))),
    el('div', { class: 'where' }, 'Open it by itself when the editor starts'),
    homeOpenBlock(S),
    el('div', { class: 'where' }, 'When you click a host on the page'),
    opts([
      { v: 'panel', t: 'Same as the Hosts panel', d: 'Now: ' + panel + '. Change it under General.' },
      { v: 'newWindow', t: 'Open in a new window', d: 'Remote-SSH, in a window of its own.' },
      { v: 'window', t: 'Open in this window', d: 'Remote-SSH, replacing the current window.' },
      { v: 'terminal', t: 'Connect in a terminal', d: 'Opens an ssh session in the terminal panel.' },
    ], h.click, v => set('click', v)),
    card(
      item('Banner', 'The picture and the totals at the top of the page. Without it the hosts start higher up.', toggle(h.banner, v => set('banner', v), 'Banner')),
      item('Size of the hosts', 'Compact shows one line per host and fits more on the screen.',
        seg([{ v: 'comfortable', l: 'Comfortable' }, { v: 'compact', l: 'Compact' }], h.density, v => set('density', v))),
      item('Recent hosts', 'How many of the hosts you connected to last are shown first.',
        seg([{ v: '0', l: 'Off' }, { v: '4', l: '4' }, { v: '8', l: '8' }, { v: '12', l: '12' }], String(h.recent), v => set('recent', Number(v)))),
      item('Forget recent hosts', h.recentCount ? h.recentCount + (h.recentCount === 1 ? ' host is' : ' hosts are') + ' remembered on this computer.' : 'Nothing is remembered yet.',
        btn('Clear', () => send('command', { id: 'sshManager.clearRecentHosts' }), 'ghost'))),
    note('Favorites come first', 'Star a host on the page (hover it and press ☆) or in the Hosts panel, and it is pinned to the top. Folders can be folded away by clicking their name.', true),
    el('p', { class: 'muted small gap-t' }, 'The page never opens by itself in a window that is already connected to a server. These choices are kept on this computer, not in the config file.'),
  ];
}

function statusBlock(S) {
  const h = S.health;
  const every = [0, 60, 300, 900].includes(h.interval) ? h.interval : null;
  return [
    el('div', { class: 'where' }, 'How to tell that a server is up'),
    opts([
      { v: 'ssh', t: 'SSH port', d: 'Up when something answers on the host’s SSH port. No login is made. Best for most servers.' },
      { v: 'ping', t: 'Ping', d: 'Up when the host answers a ping. Many cloud servers block ping and would show as down.' },
      { v: 'http', t: 'Web address', d: 'Up when https://<HostName>/ answers. For web servers.' },
      { v: 'off', t: 'Off', d: 'No dots. Nothing is checked.' },
    ], h.check, v => send('health', { key: 'check', value: v })),
    card(
      item('Check again', 'Only while the Hosts panel is visible.' + (every === null ? ' Now: every ' + h.interval + ' seconds.' : ''),
        seg([{ v: '60', l: '1 min' }, { v: '300', l: '5 min' }, { v: '900', l: '15 min' }, { v: '0', l: 'Only on Refresh' }], every === null ? '' : String(every), v => send('health', { key: 'interval', value: Number(v) }), h.check === 'off')),
      item('Animate the dot', 'A soft pulse while a server is up, a slow blink while it is down.', toggle(h.animation, v => send('health', { key: 'animation', value: v }), 'Animate the dot', h.check === 'off')),
      item('Check now', 'The Refresh button of the Hosts panel does the same.', btn('Check Now', () => send('command', { id: 'sshManager.checkHealth' }), 'ghost'))),
    note('One host, another way', 'Right-click a host → Set Status Check… to give it its own check: SSH port, ping, a web address such as https://example.com/health, or none.', true),
    el('p', { class: 'muted small gap-t' }, 'Green = up, red = down, a grey ring = not checked. A folder is yellow when some of its hosts are up and some are down. Hosts behind a jump host cannot be reached from this computer directly, so they stay grey unless you give them a web address. For the reason a host is down, right-click it → Test Connection…'),
  ];
}

function helpBlock(S) {
  return [
    card(
      item('Setup wizard', 'Walks through folders, the Remote-SSH list, backups, sync, keys and shortcuts, step by step. You can run it as often as you like.', btn('Run the Wizard', () => send('command', { id: 'sshManager.wizard' }))),
      item('Guide in VS Code', 'The same topics as a checklist on VS Code’s own Get Started page.', btn('Open the Guide', () => send('command', { id: 'sshManager.walkthrough' }), 'ghost')),
      item('The config file', 'Everything this extension stores is a plain comment in your SSH config. Have a look.', btn('Open Config File', () => send('command', { id: 'sshManager.openConfig' }), 'ghost'))),
    el('p', { class: 'muted small' }, 'SSH Config Manager ' + S.version),
  ];
}

const SECTIONS = [
  { id: 'general', label: 'General', art: 'settings', title: 'General', lead: 'How the Hosts panel behaves.', body: generalBlock },
  { id: 'home', label: 'Home page', art: 'start', title: 'Home page', lead: 'Every host one click away, on a page that can open by itself when the editor starts.', body: homeBlock },
  { id: 'status', label: 'Server status', art: 'settings', title: 'Server status', lead: 'A dot next to every host shows whether the server is up or down right now.', body: statusBlock },
  { id: 'folders', label: 'Folders', art: 'folders', title: 'Folders', lead: 'Keep hosts in folders and subfolders, the way you keep files.', body: foldersBlock },
  { id: 'picker', label: 'Remote-SSH list', art: 'picker', title: 'Remote-SSH list', lead: 'Make VS Code’s own “Connect to Host” list as organized as this panel.', body: pickerBlock },
  { id: 'backups', label: 'Backups', art: 'backup', title: 'Backups', lead: 'A copy of your config is saved before every change, in a folder right next to it. Restore any of them with one click.', body: S => backupsBlock(S, 12) },
  { id: 'sync', label: 'Sync', art: 'sync', title: 'Sync between computers', lead: 'Use the same hosts on every computer through a file in Dropbox, iCloud Drive or OneDrive.', body: syncBlock, flag: S => S.sync.state === 'conflict' || S.sync.state === 'error' },
  { id: 'keys', label: 'SSH keys', art: 'keys', title: 'SSH keys', lead: 'Keys never leave the computer they are on. This checks that the keys your hosts need are here.', body: keysBlock, flag: S => S.keys.missing.length > 0 },
  { id: 'shortcuts', label: 'Shortcuts', art: 'shortcuts', title: 'Keyboard shortcuts', lead: 'Everything in the panel without the mouse.', body: S => shortcutsBlock(S) },
  { id: 'help', label: 'Setup & help', art: 'welcome', title: 'Setup & help', lead: 'Start over with the wizard, or open the guide.', body: helpBlock },
];

function render() {
  if (!S) return;
  const sec = SECTIONS.find(s => s.id === current) || SECTIONS[0];
  const scroll = document.scrollingElement ? document.scrollingElement.scrollTop : 0;
  document.getElementById('app').replaceChildren(el('div', { class: 'layout' },
    el('nav', { class: 'nav', 'aria-label': 'Settings sections' },
      el('div', { class: 'brand' }, 'SSH Config Manager'), el('div', { class: 'sub' }, 'Settings'),
      SECTIONS.map(s => el('button', { 'aria-current': String(s.id === sec.id), onclick: () => go(s.id) }, s.label, s.flag && s.flag(S) && el('span', { class: 'flag', title: 'Needs your attention' })))),
    el('main', { class: 'main' }, art(S, sec.art), el('h1', {}, sec.title), el('p', { class: 'lead' }, sec.lead), sec.body(S))));
  if (document.scrollingElement) document.scrollingElement.scrollTop = scroll;
}

function go(id) {
  current = id;
  vscode.setState({ section: id });
  render();
  if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
}

window.addEventListener('message', ({ data }) => {
  if (data.type === 'state') { S = data.state; render(); }
  if (data.type === 'section') { go(data.id); }
});
send('ready');
