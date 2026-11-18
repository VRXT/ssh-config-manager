/**
 * The keyboard shortcuts, in one place: package.json's keybindings are checked against this list
 * by the tests, and the settings page and the setup wizard show it to the user.
 * Free of the vscode API.
 */
export interface Shortcut {
  command: string;
  label: string;
  /** VS Code key syntax, as in package.json */
  mac: string;
  key: string;
  /** 'anywhere' or 'panel' (the Hosts list has focus) */
  where: 'anywhere' | 'panel';
  /** extra `when` clause the panel shortcut needs (what is selected) */
  on?: 'host' | 'folder';
  group: 'Connect' | 'Organize' | 'Find';
}

export const SHORTCUTS: Shortcut[] = [
  { command: 'sshManager.quickConnect', label: 'Connect to a host from anywhere', mac: 'cmd+alt+s', key: 'ctrl+alt+s', where: 'anywhere', group: 'Connect' },
  { command: 'sshManager.connect', label: 'Connect to the selected host', mac: 'enter', key: 'enter', where: 'panel', on: 'host', group: 'Connect' },
  { command: 'sshManager.connectNewWindow', label: 'Open in a new window (Remote-SSH)', mac: 'cmd+enter', key: 'ctrl+enter', where: 'panel', on: 'host', group: 'Connect' },
  { command: 'sshManager.connectTerminal', label: 'Connect in a terminal', mac: 'alt+enter', key: 'alt+enter', where: 'panel', on: 'host', group: 'Connect' },
  { command: 'sshManager.copySsh', label: 'Copy the ssh command', mac: 'cmd+c', key: 'ctrl+c', where: 'panel', on: 'host', group: 'Connect' },

  { command: 'sshManager.addHost', label: 'New host', mac: 'cmd+n', key: 'ctrl+n', where: 'panel', group: 'Organize' },
  { command: 'sshManager.addGroup', label: 'New folder', mac: 'cmd+shift+n', key: 'ctrl+shift+n', where: 'panel', group: 'Organize' },
  { command: 'sshManager.editHost', label: 'Edit the selected host', mac: 'f2', key: 'f2', where: 'panel', on: 'host', group: 'Organize' },
  { command: 'sshManager.renameGroup', label: 'Rename the selected folder', mac: 'f2', key: 'f2', where: 'panel', on: 'folder', group: 'Organize' },
  { command: 'sshManager.duplicateHost', label: 'Duplicate the selected host', mac: 'cmd+shift+d', key: 'ctrl+shift+d', where: 'panel', on: 'host', group: 'Organize' },
  { command: 'sshManager.toggleFavorite', label: 'Add to / remove from favorites', mac: 'cmd+d', key: 'ctrl+d', where: 'panel', on: 'host', group: 'Organize' },
  { command: 'sshManager.moveUp', label: 'Move up', mac: 'alt+up', key: 'alt+up', where: 'panel', group: 'Organize' },
  { command: 'sshManager.moveDown', label: 'Move down', mac: 'alt+down', key: 'alt+down', where: 'panel', group: 'Organize' },
  { command: 'sshManager.deleteHost', label: 'Delete the selected host', mac: 'cmd+backspace', key: 'delete', where: 'panel', on: 'host', group: 'Organize' },
  { command: 'sshManager.deleteGroup', label: 'Delete the selected folder', mac: 'cmd+backspace', key: 'delete', where: 'panel', on: 'folder', group: 'Organize' },

  { command: 'sshManager.filter', label: 'Search hosts', mac: 'cmd+f', key: 'ctrl+f', where: 'panel', group: 'Find' },
  { command: 'sshManager.settingsPage', label: 'Open settings', mac: 'cmd+,', key: 'ctrl+,', where: 'panel', group: 'Find' },
];

const PANEL = 'focusedView == sshManager.hosts';

/** The `when` clause a shortcut gets in package.json. */
export function whenClause(s: Shortcut): string | undefined {
  if (s.where === 'anywhere') {
    return undefined;
  }
  return s.on ? `${PANEL} && sshManager.selection == ${s.on}` : PANEL;
}

/** package.json `contributes.keybindings`, generated from the list above. */
export function keybindings(): { command: string; key: string; mac: string; when?: string }[] {
  return SHORTCUTS.map(s => {
    const when = whenClause(s);
    return when ? { command: s.command, key: s.key, mac: s.mac, when } : { command: s.command, key: s.key, mac: s.mac };
  });
}

const MAC_SYMBOL: Record<string, string> = { cmd: '⌘', alt: '⌥', shift: '⇧', ctrl: '⌃', enter: '↩', backspace: '⌫', up: '↑', down: '↓' };
const WIN_NAME: Record<string, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', enter: 'Enter', delete: 'Del', backspace: 'Backspace', up: '↑', down: '↓' };

/** The keys of a shortcut as the user's keyboard shows them, one string per key cap. */
export function keyCaps(s: Shortcut, platform: string): string[] {
  const mac = platform === 'darwin';
  return (mac ? s.mac : s.key).split('+').map(k => (mac ? MAC_SYMBOL[k] : WIN_NAME[k]) ?? (k.length === 1 ? k.toUpperCase() : k.toUpperCase()));
}
