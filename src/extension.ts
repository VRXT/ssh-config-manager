import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { PublicKey, addIdentityFile, installKeyCommand, keyFileName, keygenArgs, listPublicKeys, missingKeys } from './keys';
import {
  Container, Host, addGroup, addSection, allContainers, connectName, containerPath, deleteContainer, deleteHost,
  PROVIDERS, findContainer, findHost, hostTags, hostToForm, optionAll, isDisabled, moveGroup, moveHost, moveSection, option, parse, renameContainer, setContainerAttrs, setContainerEnabled, setHostAttrs, setHostEnabled, setPickerFormatting, skipsSectionLevel,
} from './sshConfig';
import { ago } from './backups';
import { openHostEditor } from './hostEditor';
import { Panels } from './panels';
import { describeFilter, emptyFilter } from './search';
import { folderProblem, sshInFolder } from './remote';
import { findRemoteProvider, suggestedProvider } from './remoteProvider';
import { SearchViewProvider } from './searchView';
import { Store, collapseHome, expandHome } from './store';
import { SyncController } from './syncController';
import { COLORS, COLOR_DOTS, HostTree, ICONS, Node, autoIcon, hostDetail, hostSummary, isFav } from './tree';

export function activate(context: vscode.ExtensionContext): void {
  // Created first, with a fixed id, so nothing later in activation can keep it from showing
  // and VS Code remembers whether the user hid it (status bar context menu).
  const status = vscode.window.createStatusBarItem('sshManager.status', vscode.StatusBarAlignment.Left, 10000);
  status.name = 'SSH Config Manager';
  status.text = '$(plug) SSH';
  status.tooltip = 'SSH Config Manager: connect to a host';
  status.command = 'sshManager.quickConnect';
  status.show();
  context.subscriptions.push(status);

  const store = new Store(vscode.Uri.joinPath(context.globalStorageUri, 'backups').fsPath);
  const tree = new HostTree(store);
  const view = vscode.window.createTreeView('sshManager.hosts', {
    treeDataProvider: tree,
    dragAndDropController: tree,
    canSelectMany: true,
    showCollapseAll: true,
  });

  const search = new SearchViewProvider(store, tree);
  const sync = new SyncController(store, context.globalState);
  const panels = new Panels(context, store, sync);
  context.subscriptions.push(sync, panels);

  // what is selected, for the keyboard shortcuts that only make sense on a host or on a folder
  const selectionKind = () => {
    const n = view.selection[0];
    return !n ? '' : n.type === 'container' ? 'folder' : n.type === 'host' ? (n.host.isPattern ? 'pattern' : 'host') : 'other';
  };
  const setSelection = () => vscode.commands.executeCommand('setContext', 'sshManager.selection', selectionKind());
  context.subscriptions.push(view.onDidChangeSelection(setSelection));
  setSelection();

  const refreshChrome = () => {
    view.description = tree.filtered ? `filter: ${describeFilter(tree.currentFilter)}` : undefined;
    view.message = store.error ? `Cannot read ${store.configPath}: ${store.error}` : undefined;
  };
  store.onDidChange(refreshChrome);
  tree.onDidChangeFilter(refreshChrome);
  refreshChrome();

  context.subscriptions.push(
    store,
    view,
    vscode.window.registerWebviewViewProvider(SearchViewProvider.id, search),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('sshManager.configFile')) {
        store.reload();
      }
    }),
  );

  // ---- pickers used when a command is run from the palette instead of the tree

  const pickHost = async (node: Node | undefined, editable = false): Promise<Host | undefined> => {
    if (node?.type === 'host') {
      return node.host;
    }
    const picked = await vscode.window.showQuickPick(hostItems(editable), {
      placeHolder: 'Select a host',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    return picked?.h;
  };

  /** Hosts as quick-pick rows, with a real heading per group instead of fake separator hosts. */
  type HostItem = vscode.QuickPickItem & { h?: Host; spacer?: boolean };
  const hostItems = (editable: boolean, spaced = false): HostItem[] => {
    const { doc, included } = store;
    const out: HostItem[] = [];
    const usable = (h: Host) => (editable ? !h.readonly : !!connectName(h));
    // The quick pick has no real tree, so the hierarchy is drawn with header rows and indentation:
    //   PROJECT
    //       sub-folder
    //           host
    const indent = (depth: number) => '  '.repeat(depth);
    const safe = (icon: string, fallback: string) => (/^[a-z0-9-]+$/.test(icon) ? icon : fallback);
    // Quick picks cannot color an icon (VS Code ignores ThemeIcon colors there), so a colored dot
    // next to the name stands in for the color the host or group has in the tree.
    const dot = (color?: string) => (color && COLOR_DOTS[color] ? COLOR_DOTS[color] + ' ' : '');
    const row = (h: Host, depth: number): HostItem => {
      const icon = h.attrs.icon || (doc.settings.autoicon === 'off' ? 'server' : autoIcon(h));
      const tags = hostTags(h).map(t => '#' + t).join(' ');
      return {
        label: `${indent(depth)}$(${safe(icon, 'server')}) ${dot(h.attrs.color)}${h.alias}`,
        description: [hostSummary(h), tags].filter(Boolean).join('  '),
        detail: h.attrs.note ? indent(depth) + h.attrs.note : undefined,
        h,
      };
    };
    const header = (title: string, icon: string, depth: number, count: number, color?: string): HostItem => ({
      label: `${indent(depth)}$(${icon}) ${dot(color)}${title}`,
      description: String(count),
    });
    const gap = () => {
      if (out.length) {
        if (spaced) {
          out.push({ label: ' ', spacer: true }); // empty row = breathing room between projects
        }
        out.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      }
    };
    const block = (
      title: string,
      icon: string,
      direct: Host[],
      sections: { title: string; icon: string; color?: string; hosts: Host[] }[],
      color?: string,
    ) => {
      const own = direct.filter(usable);
      const subs = sections.map(s => ({ ...s, hosts: s.hosts.filter(usable) })).filter(s => s.hosts.length);
      const total = own.length + subs.reduce((n, s) => n + s.hosts.length, 0);
      if (!total) {
        return;
      }
      gap();
      out.push(header(title, icon, 0, total, color), ...own.map(h => row(h, 1)));
      for (const s of subs) {
        out.push(header(s.title, s.icon, 1, s.hosts.length, s.color), ...s.hosts.map(h => row(h, 2)));
      }
    };

    if (doc.settings.favorites !== 'off') {
      block('Favorites', 'star-full', doc.hosts.filter(isFav), []);
    }
    const loose = doc.rootHosts.filter(usable);
    if (loose.length) {
      gap();
      out.push(...loose.map(h => row(h, 0)));
    }
    for (const g of doc.groups) {
      const only = skipsSectionLevel(g); // one hand-written sub-folder holding everything: skip that level
      block(
        g.title,
        safe(g.attrs.icon || 'folder-library', 'folder-library'),
        only ? g.sections[0].hosts : g.hosts,
        only ? [] : g.sections.map(x => ({ title: x.title, icon: safe(x.attrs.icon || 'folder', 'folder'), color: x.attrs.color, hosts: x.hosts })),
        g.attrs.color,
      );
    }
    if (!editable) {
      for (const d of included) {
        block(`included: ${d.file.split('/').slice(-2).join('/')}`, 'references', d.hosts, []);
      }
    }
    return out;
  };

  const pickContainer = async (placeHolder: string, current?: Container): Promise<string | undefined> => {
    const items = [
      { label: '$(circle-slash) (not in a folder)', id: '' },
      ...allContainers(store.doc).map(c => ({
        label: `$(folder) ${containerPath(c)}`,
        id: c.id,
        description: c === current ? 'current' : undefined,
      })),
    ];
    return (await vscode.window.showQuickPick(items, { placeHolder }))?.id;
  };

  const askName = (prompt: string, value = '') =>
    vscode.window.showInputBox({
      prompt,
      value,
      validateInput: v => (v.trim() ? undefined : 'A name is required'),
    });

  // ---- connecting

  const sshCommand = (h: Host): string | undefined => {
    const name = connectName(h);
    if (!name) {
      return undefined;
    }
    const q = (s: string) => (/^[\w.@:%+,/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
    const config = store.sshConfigFile;
    return `ssh ${config ? `-F ${q(config)} ` : ''}${q(name)}`;
  };

  /** Runs a command in a terminal on THIS computer, where the config and keys are. */
  const runLocal = async (name: string, cmd: string) => {
    if (vscode.env.remoteName) {
      // In a window that is itself connected to a remote, a normal terminal would open ON that
      // remote. The config and keys live on this computer, so ask for a local terminal instead.
      const before = new Set(vscode.window.terminals);
      await vscode.commands.executeCommand('workbench.action.terminal.newLocal');
      const local = vscode.window.terminals.find(t => !before.has(t)) ?? vscode.window.activeTerminal;
      local?.show();
      local?.sendText(cmd);
      return;
    }
    const term = vscode.window.createTerminal({ name, iconPath: new vscode.ThemeIcon('remote') });
    term.show();
    term.sendText(cmd);
  };

  const connectTerminal = async (h: Host) => {
    const cmd = sshCommand(h);
    if (!cmd) {
      vscode.window.showInformationMessage(
        h.disabled ? `"${h.alias}" is disabled. Enable it first.` : `"${h.alias}" is a pattern, not a host you can connect to.`,
      );
      return;
    }
    // start in the host's remote folder when it has one
    await runLocal(h.alias, sshInFolder(cmd, h.attrs.folder ?? '', !!option(h, 'RemoteCommand')));
  };

  const connectRemote = async (h: Host, reuseWindow: boolean) => {
    const name = connectName(h);
    if (!name) {
      return;
    }
    // Microsoft's Remote - SSH in VS Code, Cursor's own in Cursor, Open Remote - SSH in VSCodium and others
    if (!findRemoteProvider(vscode.extensions.all)) {
      const wanted = suggestedProvider(vscode.env.appName);
      const install = `Find "${wanted.name}"`;
      const pick = await vscode.window.showWarningMessage(
        `Opening a remote window needs an extension that connects over SSH. In ${vscode.env.appName} that is "${wanted.name}".`,
        install, 'Connect in Terminal',
      );
      if (pick === install) {
        await vscode.commands.executeCommand('workbench.extensions.search', wanted.id);
      } else if (pick) {
        connectTerminal(h);
      }
      return;
    }
    const folder = (h.attrs.folder ?? '').trim();
    if (folder && !folderProblem(folder)) {
      // straight into the host's folder instead of an empty remote window
      const uri = vscode.Uri.from({ scheme: 'vscode-remote', authority: `ssh-remote+${name}`, path: folder });
      await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: !reuseWindow });
      return;
    }
    await vscode.commands.executeCommand('vscode.newWindow', { remoteAuthority: `ssh-remote+${name}`, reuseWindow });
  };

  // ---- commands

  // Run from a menu, a command gets the row it was opened on. Run from a keyboard shortcut (or the
  // Command Palette) it gets nothing, and acts on what is selected in the Hosts list.
  const reg = (id: string, fn: (node?: Node, selected?: Node[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (node?: Node, selected?: Node[]) =>
        node === undefined && view.selection.length ? fn(view.selection[0], [...view.selection]) : fn(node, selected)),
    );
  const regPlain = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('sshManager.refresh', () => store.reload());

  reg('sshManager.filter', () => search.focus());

  reg('sshManager.clearFilter', () => {
    tree.setFilter(emptyFilter());
  });

  reg('sshManager.openConfig', async () => {
    await vscode.window.showTextDocument(vscode.Uri.file(store.configPath));
  });

  // ---- settings page, setup wizard, guide

  regPlain('sshManager.settingsPage', (section?: string) => panels.showSettings(typeof section === 'string' ? section : undefined));
  regPlain('sshManager.settings', () => panels.showSettings());
  regPlain('sshManager.shortcuts', () => panels.showSettings('shortcuts'));
  regPlain('sshManager.wizard', () => panels.showWizard(true));
  regPlain('sshManager.walkthrough', () =>
    vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#sshManager.gettingStarted`, false));

  // ---- Remote-SSH list formatting (headings and gaps in VS Code's own host list)

  regPlain('sshManager.remoteSpacing', async () => {
    // what the file has now (not the default that the next save would apply)
    const on = store.doc.settings['remote-picker'] === 'on' || store.doc.spacers.length > 0;
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(check) Format the Remote-SSH host list', detail: 'A heading for every folder and subfolder, a blank row between folders, favorites on top', on: true },
        { label: '$(close) Leave it as one plain list', detail: 'Removes those rows from the config file again', on: false },
      ],
      { title: 'Remote-SSH host list', placeHolder: on ? 'Formatting is on now' : 'Formatting is off now' },
    );
    if (pick && pick.on !== on) {
      await store.mutate(d => setPickerFormatting(d, pick.on));
    }
  });

  // the one time it is switched on by default, say so and offer the way back
  context.subscriptions.push(
    store.onDidAutoFormat(async () => {
      const pick = await vscode.window.showInformationMessage(
        'Your folders now also show in VS Code’s Remote-SSH host list, as headings with a gap between folders.',
        'Keep', 'Turn Off', 'Settings',
      );
      if (pick === 'Turn Off') {
        await store.mutate(d => setPickerFormatting(d, false));
      } else if (pick === 'Settings') {
        panels.showSettings('picker');
      }
    }),
  );

  // ---- backups: a folder next to the config file

  regPlain('sshManager.backupNow', () => {
    try {
      const file = store.backupNow();
      vscode.window.showInformationMessage(
        !store.exists ? 'There is no config file to back up yet.' : file ? `Backup saved: ${collapseHome(file)}` : 'Nothing changed since the last backup.',
      );
    } catch (e: any) {
      vscode.window.showErrorMessage(`SSH Config Manager: could not save a backup: ${e?.message ?? e}`);
    }
    store.reload();
  });

  regPlain('sshManager.openBackups', async () => {
    fs.mkdirSync(store.backupDir, { recursive: true, mode: 0o700 });
    await vscode.env.openExternal(vscode.Uri.file(store.backupDir));
  });

  regPlain('sshManager.compareBackup', async (file?: string) => {
    const backup = store.backups().find(b => b.file === file);
    if (backup) {
      await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(backup.file), vscode.Uri.file(store.configPath), `Backup from ${ago(backup.date)} ↔ Now`);
    }
  });

  regPlain('sshManager.restoreBackup', async (file?: string) => {
    const backups = store.backups();
    if (!backups.length) {
      vscode.window.showInformationMessage('No backups yet. One is saved automatically before every change.');
      return;
    }
    let backup = typeof file === 'string' ? backups.find(b => b.file === file) : undefined;
    if (!backup) {
      const picked = await vscode.window.showQuickPick(
        backups.map(b => ({
          label: `$(history) ${ago(b.date)}`,
          description: `${b.hosts} host${b.hosts === 1 ? '' : 's'}`,
          detail: b.date.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' }),
          b,
        })),
        { title: 'Restore the SSH config from a backup', placeHolder: 'Pick the version to go back to', matchOnDetail: true },
      );
      backup = picked?.b;
    }
    if (!backup) {
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Restore the config from ${ago(backup.date)}?`,
      { modal: true, detail: `${backup.hosts} host${backup.hosts === 1 ? '' : 's'}, saved ${backup.date.toLocaleString()}.\nThe config as it is now is backed up first, so you can undo this.` },
      'Restore', 'Compare First',
    );
    if (ok === 'Compare First') {
      await vscode.commands.executeCommand('sshManager.compareBackup', backup.file);
      return;
    }
    if (ok !== 'Restore') {
      return;
    }
    try {
      store.replace(fs.readFileSync(backup.file, 'utf8'));
      vscode.window.showInformationMessage(`Config restored from ${ago(backup.date)}.`);
    } catch (e: any) {
      vscode.window.showErrorMessage(`SSH Config Manager: could not restore: ${e?.message ?? e}`);
    }
  });

  // ---- sync between computers, and the keys that sync never carries

  regPlain('sshManager.syncSetup', () => sync.setup());
  regPlain('sshManager.syncNow', () => sync.syncNow(true));
  regPlain('sshManager.syncOff', async () => {
    if (sync.mode === 'off') {
      vscode.window.showInformationMessage('Sync is already off.');
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      'Turn sync off on this computer?',
      { modal: true, detail: 'This computer keeps its own complete copy of the config. The shared file is not deleted, and your other computers are not affected.' },
      'Turn Off',
    );
    if (ok) {
      await sync.turnOff();
    }
  });

  regPlain('sshManager.checkKeys', async () => {
    const missing = missingKeys(store.doc, os.homedir());
    const withKeys = store.doc.hosts.filter(h => !h.disabled && h.options.some(o => o.key.toLowerCase() === 'identityfile')).length;
    if (!missing.length) {
      vscode.window.showInformationMessage(
        withKeys ? `All good: the keys for ${withKeys} host${withKeys === 1 ? '' : 's'} are on this computer.` : 'No host in your config names a key file, so there is nothing to check.',
      );
      return;
    }
    const byHost = new Map<string, { alias: string; keys: string[] }>();
    for (const m of missing) {
      const e = byHost.get(m.hostId) ?? { alias: m.alias, keys: [] };
      e.keys.push(m.key);
      byHost.set(m.hostId, e);
    }
    const picked = await vscode.window.showQuickPick(
      [...byHost].map(([id, e]) => ({ label: `$(warning) ${e.alias}`, description: 'key not on this computer', detail: e.keys.join('   '), id })),
      {
        title: `${byHost.size} host${byHost.size === 1 ? ' uses' : 's use'} an SSH key that is not on this computer`,
        placeHolder: 'Copy the key files here yourself, or pick a host to set up a new key for it',
        matchOnDetail: true,
      },
    );
    const host = picked && store.doc.hosts.find(h => h.id === picked.id);
    if (host) {
      await vscode.commands.executeCommand('sshManager.setupKey', { type: 'host', host });
    }
  });

  reg('sshManager.addHost', node => {
    openHostEditor(store, undefined, node?.type === 'container' ? node.c.id : '');
  });

  reg('sshManager.editHost', async node => {
    const h = await pickHost(node, true);
    if (h && !h.readonly) {
      openHostEditor(store, h.id);
    }
  });

  reg('sshManager.duplicateHost', async node => {
    const h = await pickHost(node, true);
    if (h && !h.readonly) {
      const form = hostToForm(store.doc, h);
      form.alias = `${h.alias}-copy`;
      openHostEditor(store, undefined, form.container, form);
    }
  });

  reg('sshManager.deleteHost', async (node, selected) => {
    const nodes = selected?.length ? selected : node ? [node] : [];
    let hosts = nodes.filter(n => n.type === 'host').map(n => (n as { host: Host }).host).filter(h => !h.readonly);
    if (!hosts.length) {
      const h = await pickHost(undefined, true);
      hosts = h ? [h] : [];
    }
    if (!hosts.length) {
      return;
    }
    const what = hosts.length === 1 ? `"${hosts[0].alias}"` : `${hosts.length} hosts`;
    const ok = await vscode.window.showWarningMessage(
      `Delete ${what} from the SSH config?`,
      { modal: true, detail: 'A backup of the file is kept in the extension storage.' },
      'Delete',
    );
    if (ok) {
      const aliases = hosts.map(h => h.id);
      await store.mutate(doc => {
        let text = doc.lines.join(doc.eol) + doc.eol;
        // delete bottom-up so earlier line numbers stay valid
        for (const h of doc.hosts.filter(x => aliases.includes(x.id)).sort((a, b) => b.start - a.start)) {
          text = deleteHost({ ...doc, lines: text.split(/\r?\n/).slice(0, -1) }, h.id);
        }
        return text;
      });
    }
  });

  reg('sshManager.moveHost', async node => {
    const h = await pickHost(node, true);
    if (!h || h.readonly) {
      return;
    }
    const target = await pickContainer(`Move "${h.alias}" to…`, h.container);
    if (target !== undefined) {
      await store.mutate(d => moveHost(d, h.id, target));
    }
  });

  // Move Up / Move Down: one step among its siblings (hosts in a folder, sub-folders in a
  // project, projects in the file). Also on Alt+Up / Alt+Down while the Hosts view has focus.
  const step = async (node: Node | undefined, dir: -1 | 1) => {
    node ??= view.selection[0];
    if (!node || (node.type !== 'host' && node.type !== 'container')) {
      return;
    }
    if (node.type === 'host' && (node.host.readonly || node.fav)) {
      return;
    }
    if (node.type === 'host' && store.doc.settings.sort === 'name') {
      vscode.window.showInformationMessage('Hosts are sorted by name. Switch "Sort hosts" to "As written in the file" to arrange them by hand.');
      return;
    }
    /** id of the sibling to land in front of; undefined = go last; null = cannot move */
    const target = <T extends { id: string }>(list: T[], id: string): string | undefined | null => {
      const i = list.findIndex(x => x.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) {
        return null;
      }
      return dir < 0 ? list[j].id : list[j + 1]?.id;
    };
    await store.mutate(doc => {
      const same = doc.lines.join(doc.eol) + doc.eol;
      if (node.type === 'host') {
        const h = findHost(doc, node.host.id);
        if (!h) {
          return same;
        }
        const before = target(h.container?.hosts ?? doc.rootHosts, h.id);
        return before === null ? same : moveHost(doc, h.id, h.container?.id ?? '', before);
      }
      const c = findContainer(doc, node.c.id);
      if (!c) {
        return same;
      }
      const before = target(c.parent ? c.parent.sections : doc.groups, c.id);
      if (before === null) {
        return same;
      }
      return c.parent ? moveSection(doc, c.id, c.parent.id, before) : moveGroup(doc, c.id, before);
    });
  };
  reg('sshManager.moveUp', node => step(node, -1));
  reg('sshManager.moveDown', node => step(node, 1));

  reg('sshManager.moveSection', async node => {
    if (node?.type !== 'container' || node.c.kind !== 'section') {
      return;
    }
    const picked = await vscode.window.showQuickPick(
      store.doc.groups.map(g => ({ label: `$(folder) ${g.title}`, description: g === node.c.parent ? 'current' : undefined, id: g.id })),
      { placeHolder: `Move subfolder "${node.c.title}" to folder…` },
    );
    if (picked) {
      await store.mutate(d => moveSection(d, node.c.id, picked.id));
    }
  });

  reg('sshManager.toggleFavorite', async node => {
    const h = await pickHost(node, true);
    if (h && !h.readonly) {
      const starred = !!h.attrs.fav && h.attrs.fav !== '0';
      await store.mutate(d => setHostAttrs(d, h.id, { fav: starred ? undefined : '1' }));
    }
  });

  reg('sshManager.toggleEnabled', async (node, selected) => {
    const nodes = selected?.length && selected.includes(node!) ? selected : node ? [node] : [];
    const targets = nodes.filter(n => (n.type === 'host' && !n.host.readonly) || n.type === 'container');
    if (!targets.length) {
      const h = await pickHost(undefined, true);
      if (h) {
        await store.mutate(d => setHostEnabled(d, h.id, h.disabled));
      }
      return;
    }
    // one direction for the whole selection, decided by the item that was clicked
    const first = targets[0];
    const enable = first.type === 'host' ? first.host.disabled : first.type === 'container' && isDisabled(first.c);
    await store.mutate(doc => {
      let text = doc.lines.join(doc.eol) + doc.eol;
      for (const n of targets) {
        const d = parse(text, doc.file);
        text = n.type === 'host' ? setHostEnabled(d, n.host.id, enable) : n.type === 'container' ? setContainerEnabled(d, n.c.id, enable) : text;
      }
      return text;
    });
  });

  const setLook = async (node: Node | undefined, key: 'icon' | 'color') => {
    if (!node || (node.type !== 'host' && node.type !== 'container')) {
      return;
    }
    const items =
      key === 'icon'
        ? [{ label: '$(discard) Default', value: '' }, ...ICONS.map(i => ({ label: `$(${i}) ${i}`, value: i }))]
        : [{ label: '$(discard) None', value: '' }, ...Object.keys(COLORS).map(c => ({ label: `$(circle-filled) ${c}`, value: c }))];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: `Choose ${key}` });
    if (!picked) {
      return;
    }
    const patch = { [key]: picked.value || undefined };
    await store.mutate(d =>
      node.type === 'host' ? setHostAttrs(d, node.host.id, patch) : setContainerAttrs(d, node.c.id, patch),
    );
  };
  reg('sshManager.setProvider', async (node, selected) => {
    const nodes = selected?.length && node && selected.includes(node) ? selected : node ? [node] : [];
    let hosts = nodes.filter(n => n.type === 'host' && !n.host.readonly).map(n => (n as { host: Host }).host);
    if (!hosts.length) {
      const h = await pickHost(undefined, true);
      hosts = h ? [h] : [];
    }
    if (!hosts.length) {
      return;
    }
    const icon = (kind: string) => (kind === 'lan' ? 'home' : kind === 'vpn' ? 'link' : 'cloud');
    const picked = await vscode.window.showQuickPick(
      [
        { label: '$(wand) Automatic', description: 'detect from the address and folder name', value: '' },
        ...PROVIDERS.map(p => ({ label: `$(${icon(p.kind)}) ${p.label}`, description: undefined, value: p.id })),
        { label: '$(edit) Other…', description: 'type a name', value: '?' },
      ],
      { placeHolder: hosts.length === 1 ? `Provider for ${hosts[0].alias}` : `Provider for ${hosts.length} hosts` },
    );
    if (!picked) {
      return;
    }
    let value: string | undefined = picked.value;
    if (value === '?') {
      value = (await vscode.window.showInputBox({ prompt: 'Provider name' }))?.trim();
      if (!value) {
        return;
      }
    }
    const ids = hosts.map(h => h.id);
    await store.mutate(doc => {
      let text = doc.lines.join(doc.eol) + doc.eol;
      for (const id of ids) {
        text = setHostAttrs(parse(text, doc.file), id, { provider: value || undefined });
      }
      return text;
    });
  });

  reg('sshManager.setIcon', node => setLook(node, 'icon'));
  reg('sshManager.setColor', node => setLook(node, 'color'));

  reg('sshManager.connect', async node => {
    const h = await pickHost(node);
    if (!h) {
      return;
    }
    switch (store.doc.settings.click) {
      case 'window':
        return connectRemote(h, true);
      case 'newWindow':
        return connectRemote(h, false);
      case 'edit':
        return h.readonly ? undefined : openHostEditor(store, h.id);
      default:
        return connectTerminal(h);
    }
  });
  reg('sshManager.quickConnect', () => {
    const actions = [
      { iconPath: new vscode.ThemeIcon('terminal'), tooltip: 'Connect in Terminal', run: (h: Host) => connectTerminal(h) },
      { iconPath: new vscode.ThemeIcon('remote'), tooltip: 'Open in This Window', run: (h: Host) => connectRemote(h, true) },
      { iconPath: new vscode.ThemeIcon('empty-window'), tooltip: 'Open in New Window', run: (h: Host) => connectRemote(h, false) },
    ];
    const click = store.doc.settings.click;
    const primary = click === 'terminal' ? actions[0] : click === 'window' ? actions[1] : actions[2];
    const qp = vscode.window.createQuickPick<HostItem>();
    qp.placeholder = `Select an SSH host — Enter: ${primary.tooltip.toLowerCase()}`;
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.items = hostItems(false, true).map(i => (i.h ? { ...i, buttons: actions } : i));
    qp.onDidTriggerItemButton(e => {
      qp.hide();
      actions.find(a => a.tooltip === e.button.tooltip)?.run(e.item.h!);
    });
    qp.onDidAccept(() => {
      const h = qp.selectedItems[0]?.h;
      if (h) {
        qp.hide();
        primary.run(h);
      }
    });
    // arrow keys step over the empty rows and the project / sub-folder header rows
    let last = 0;
    qp.onDidChangeActive(active => {
      const items = qp.items;
      let idx = active[0] ? items.indexOf(active[0]) : -1;
      if (idx < 0) {
        return;
      }
      if (!active[0].h) {
        const dir = idx >= last ? 1 : -1;
        let j = idx;
        while (items[j] && !items[j].h) {
          j += dir;
        }
        if (!items[j]) {
          j = idx;
          while (items[j] && !items[j].h) {
            j -= dir;
          }
        }
        if (items[j]) {
          idx = j;
          qp.activeItems = [items[j]];
        }
      }
      last = idx;
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  });

  reg('sshManager.connectTerminal', async node => {
    const h = await pickHost(node);
    if (h) {
      connectTerminal(h);
    }
  });
  reg('sshManager.connectWindow', async node => {
    const h = await pickHost(node);
    if (h) {
      await connectRemote(h, true);
    }
  });
  reg('sshManager.connectNewWindow', async node => {
    const h = await pickHost(node);
    if (h) {
      await connectRemote(h, false);
    }
  });

  // ---- SSH keys: make a new key or pick one, put it on the server, and use it for the host

  reg('sshManager.setFolder', async node => {
    const h = await pickHost(node, true);
    if (!h || h.readonly) {
      return;
    }
    const value = await vscode.window.showInputBox({
      title: `Remote folder for ${h.alias}`,
      prompt: 'Opened directly when you connect (window or terminal). Leave empty for none.',
      value: h.attrs.folder ?? '',
      placeHolder: '/var/www/html',
      validateInput: v => folderProblem(v),
    });
    if (value === undefined) {
      return;
    }
    await store.mutate(doc => setHostAttrs(doc, h.id, { folder: value.trim() || undefined }));
  });

  reg('sshManager.setupKey', async node => {
    const h = await pickHost(node);
    const alias = h && connectName(h);
    if (!h || !alias) {
      if (h) {
        vscode.window.showInformationMessage(
          h.disabled ? `"${h.alias}" is disabled. Enable it first.` : `"${h.alias}" is a pattern, not a host you can connect to.`,
        );
      }
      return;
    }
    const sshDir = path.join(os.homedir(), '.ssh');
    const inUse = new Set(optionAll(h, 'IdentityFile').map(p => path.resolve(expandHome(p))));
    type KeyItem = vscode.QuickPickItem & { key?: PublicKey; generate?: boolean };
    const items: KeyItem[] = [
      {
        label: '$(add) Generate a new key',
        detail: `A new ed25519 key in ~/.ssh, copied to ${alias} and added to this host`,
        generate: true,
      },
    ];
    const keys = listPublicKeys(sshDir);
    if (keys.length) {
      items.push({ label: 'Use an existing key', kind: vscode.QuickPickItemKind.Separator });
      for (const key of keys) {
        items.push({
          label: `$(key) ${path.basename(key.priv)}`,
          description: [key.type.replace(/^ssh-/, ''), key.comment, inUse.has(key.priv) ? '· used by this host' : ''].filter(Boolean).join('  '),
          key,
        });
      }
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: `Set Up SSH Key for ${alias}`,
      placeHolder: 'Generate a new key, or pick one you already have',
    });
    if (!picked) {
      return;
    }

    let key = picked.key;
    if (picked.generate) {
      const name = await vscode.window.showInputBox({
        title: `New SSH key for ${alias} (1/2)`,
        prompt: 'File name in ~/.ssh',
        value: keyFileName(alias),
        validateInput: v => {
          if (!/^[A-Za-z0-9._-]+$/.test(v) || v.startsWith('.')) {
            return 'Use letters, digits, dot, dash or underscore';
          }
          return fs.existsSync(path.join(sshDir, v)) || fs.existsSync(path.join(sshDir, v + '.pub'))
            ? 'A key with this name already exists — pick it from the list instead, or choose another name'
            : undefined;
        },
      });
      if (!name) {
        return;
      }
      const passphrase = await vscode.window.showInputBox({
        title: `New SSH key for ${alias} (2/2)`,
        prompt: 'Passphrase to protect the key (optional). Press Enter to leave it empty.',
        password: true,
        placeHolder: 'Leave empty for no passphrase',
      });
      if (passphrase === undefined) {
        return;
      }
      if (passphrase) {
        const again = await vscode.window.showInputBox({ title: `New SSH key for ${alias}`, prompt: 'Type the passphrase again', password: true });
        if (again !== passphrase) {
          vscode.window.showErrorMessage(again === undefined ? 'Cancelled.' : 'The passphrases do not match. Nothing was created.');
          return;
        }
      }
      const file = path.join(sshDir, name);
      try {
        fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
        await new Promise<void>((resolve, reject) =>
          cp.execFile('ssh-keygen', keygenArgs(file, passphrase, `${alias} (SSH Config Manager)`), err => (err ? reject(err) : resolve())),
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(
          e?.code === 'ENOENT'
            ? 'ssh-keygen was not found. Install the OpenSSH client and try again.'
            : `Could not create the key: ${e?.message ?? e}`,
        );
        return;
      }
      key = listPublicKeys(sshDir).find(k => k.priv === file);
      if (!key) {
        vscode.window.showErrorMessage(`The key was not found at ${file} after ssh-keygen ran.`);
        return;
      }
    }
    if (!key) {
      return;
    }

    // use the key for this host from now on (hosts from Include files are read-only)
    if (!h.readonly && !inUse.has(key.priv)) {
      const hostId = h.id;
      const keyPath = collapseHome(key.priv);
      if (!(await store.mutate(doc => addIdentityFile(doc, hostId, keyPath)))) {
        return;
      }
    }

    await runLocal(
      `${alias}: install key`,
      installKeyCommand({
        platform: process.platform,
        alias,
        pub: key.pub,
        configFile: store.sshConfigFile,
      }),
    );
    vscode.window.showInformationMessage(
      `Type the password for ${alias} in the terminal to copy ${path.basename(key.pub)} to the server. After that, ${alias} logs in with the key.`,
    );
  });

  reg('sshManager.copySsh', async node => {
    const h = await pickHost(node);
    const cmd = h && sshCommand(h);
    if (cmd) {
      await vscode.env.clipboard.writeText(cmd);
      vscode.window.setStatusBarMessage(`Copied: ${cmd}`, 2500);
    }
  });

  reg('sshManager.copyHostName', async node => {
    const h = await pickHost(node);
    if (h) {
      const value = option(h, 'HostName') || h.alias;
      await vscode.env.clipboard.writeText(value);
      vscode.window.setStatusBarMessage(`Copied: ${value}`, 2500);
    }
  });

  reg('sshManager.reveal', async node => {
    let file = store.configPath;
    let line = 0;
    if (node?.type === 'host') {
      file = node.host.file || file;
      line = node.host.hostLine;
    } else if (node?.type === 'container') {
      line = node.c.start;
    }
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(file));
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
  });

  reg('sshManager.addGroup', async () => {
    const name = await askName('New folder name');
    if (!name) {
      return;
    }
    if (store.doc.groups.some(g => g.title.trim().toLowerCase() === name.trim().toLowerCase())) {
      vscode.window.showWarningMessage(`A folder named "${name.trim()}" already exists.`);
      return;
    }
    await store.mutate(d => addGroup(d, name));
  });

  reg('sshManager.addSection', async node => {
    if (node?.type !== 'container') {
      return;
    }
    const group = node.c.parent ?? node.c;
    const name = await askName(`New subfolder in "${group.title}"`);
    if (!name) {
      return;
    }
    if (group.sections.some(s => s.title.trim().toLowerCase() === name.trim().toLowerCase())) {
      vscode.window.showWarningMessage(`"${group.title}" already has a subfolder named "${name.trim()}".`);
      return;
    }
    await store.mutate(d => addSection(d, group.id, name));
  });

  reg('sshManager.renameGroup', async node => {
    if (node?.type !== 'container') {
      return;
    }
    const name = await askName('Rename', node.c.title);
    if (name && name.trim() !== node.c.title) {
      await store.mutate(d => renameContainer(d, node.c.id, name));
    }
  });

  reg('sshManager.deleteGroup', async node => {
    if (node?.type !== 'container') {
      return;
    }
    const c = findContainer(store.doc, node.c.id);
    if (!c) {
      return;
    }
    if (c.total > 0 || c.hosts.length > 0) {
      vscode.window.showInformationMessage(`The folder "${c.title}" still has hosts. Move or delete them first (drag them to another folder).`);
      return;
    }
    await store.mutate(d => deleteContainer(d, c.id));
  });

  // first run on this computer: the setup wizard, once (it can be reopened from the ⋯ menu)
  if (!context.globalState.get<boolean>('wizard.shown')) {
    void context.globalState.update('wizard.shown', true);
    setTimeout(() => panels.showWizard(), 800);
  }
}

export function deactivate(): void {
  // nothing: everything is registered in context.subscriptions
}
