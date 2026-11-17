import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { PublicKey, addIdentityFile, installKeyCommand, keyFileName, keygenArgs, listPublicKeys } from './keys';
import {
  Container, Host, addGroup, addSection, allContainers, connectName, containerPath, deleteContainer, deleteHost,
  PROVIDERS, findContainer, findHost, hostTags, hostToForm, optionAll, isDisabled, moveGroup, moveHost, moveSection, option, parse, renameContainer, setContainerAttrs, setContainerEnabled, setHostAttrs, setHostEnabled, setSettings, setSpacers,
} from './sshConfig';
import { openHostEditor } from './hostEditor';
import { describeFilter, emptyFilter } from './search';
import { SearchViewProvider } from './searchView';
import { Store, collapseHome, expandHome } from './store';
import { COLORS, HostTree, ICONS, Node, autoIcon, hostDetail, hostSummary, isFav } from './tree';

const SETTINGS: { key: string; label: string; detail: string; values: { value: string; label: string }[] }[] = [
  {
    key: 'sort', label: 'Sort hosts', detail: 'Order of hosts inside each group',
    values: [{ value: 'file', label: 'As written in the file' }, { value: 'name', label: 'By name' }],
  },
  {
    key: 'click', label: 'Click action', detail: 'What a single click on a host does',
    values: [
      { value: 'none', label: 'Nothing (just select)' },
      { value: 'terminal', label: 'Connect in terminal' },
      { value: 'window', label: 'Open in this window (Remote-SSH)' },
      { value: 'newWindow', label: 'Open in new window (Remote-SSH)' },
      { value: 'edit', label: 'Open the edit form' },
    ],
  },
  {
    key: 'favorites', label: 'Favorites section', detail: 'Show starred hosts pinned at the top',
    values: [{ value: 'on', label: 'Show' }, { value: 'off', label: 'Hide' }],
  },
  {
    key: 'autoicon', label: 'Automatic icons', detail: 'Guess an icon from the address (LAN, Tailscale, public) when none is set',
    values: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }],
  },
  {
    key: 'remote-subfolders', label: 'Sub-folder rows in the Remote-SSH picker',
    detail: 'How sub-folders are shown there (needs "Remote-SSH Picker Spacing" to be added)',
    values: [
      { value: 'dashes', label: '--- NAME ---' },
      { value: 'arrow', label: '▾ NAME' },
      { value: 'off', label: 'No sub-folder rows' },
    ],
  },
  {
    key: 'remote-favorites', label: 'Favorites in the Remote-SSH picker',
    detail: 'Copies starred hosts into a generated "-----FAVORITES-----" block at the top of the config file, as ★name',
    values: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }],
  },
];

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
    const row = (h: Host, depth: number): HostItem => {
      const icon = h.attrs.icon || (doc.settings.autoicon === 'off' ? 'server' : autoIcon(h));
      const tags = hostTags(h).map(t => '#' + t).join(' ');
      return {
        label: `${indent(depth)}$(${safe(icon, 'server')}) ${h.alias}`,
        description: [hostSummary(h), tags].filter(Boolean).join('  '),
        detail: h.attrs.note ? indent(depth) + h.attrs.note : undefined,
        h,
      };
    };
    const header = (title: string, icon: string, depth: number, count: number): HostItem => ({
      label: `${indent(depth)}$(${icon}) ${title}`,
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
    const block = (title: string, icon: string, direct: Host[], sections: { title: string; icon: string; hosts: Host[] }[]) => {
      const own = direct.filter(usable);
      const subs = sections.map(s => ({ ...s, hosts: s.hosts.filter(usable) })).filter(s => s.hosts.length);
      const total = own.length + subs.reduce((n, s) => n + s.hosts.length, 0);
      if (!total) {
        return;
      }
      gap();
      out.push(header(title, icon, 0, total), ...own.map(h => row(h, 1)));
      for (const s of subs) {
        out.push(header(s.title, s.icon, 1, s.hosts.length), ...s.hosts.map(h => row(h, 2)));
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
      const only = g.sections.length === 1 && !g.hosts.length; // one sub-folder holding everything: skip that level
      block(
        g.title,
        safe(g.attrs.icon || 'folder-library', 'folder-library'),
        only ? g.sections[0].hosts : g.hosts,
        only ? [] : g.sections.map(x => ({ title: x.title, icon: safe(x.attrs.icon || 'folder', 'folder'), hosts: x.hosts })),
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
      { label: '$(circle-slash) (no group)', id: '' },
      ...allContainers(store.doc).map(c => ({
        label: `${c.kind === 'group' ? '$(folder-library)' : '$(folder)'} ${containerPath(c)}`,
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
    return `ssh ${store.isDefaultPath ? '' : `-F ${q(store.configPath)} `}${q(name)}`;
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
    await runLocal(h.alias, cmd);
  };

  const connectRemote = async (h: Host, reuseWindow: boolean) => {
    const name = connectName(h);
    if (!name) {
      return;
    }
    if (!vscode.extensions.getExtension('ms-vscode-remote.remote-ssh')) {
      const pick = await vscode.window.showWarningMessage(
        'Opening a remote window needs the "Remote - SSH" extension.',
        'Connect in Terminal',
      );
      if (pick) {
        connectTerminal(h);
      }
      return;
    }
    await vscode.commands.executeCommand('vscode.newWindow', { remoteAuthority: `ssh-remote+${name}`, reuseWindow });
  };

  // ---- commands

  const reg = (id: string, fn: (node?: Node, selected?: Node[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('sshManager.refresh', () => store.reload());

  reg('sshManager.filter', () => search.focus());

  reg('sshManager.clearFilter', () => {
    tree.setFilter(emptyFilter());
  });

  reg('sshManager.openConfig', async () => {
    await vscode.window.showTextDocument(vscode.Uri.file(store.configPath));
  });

  reg('sshManager.settings', async () => {
    const current = store.doc.settings;
    const setting = await vscode.window.showQuickPick(
      SETTINGS.map(s => {
        const value = current[s.key] ?? s.values[0].value;
        return { label: s.label, description: s.values.find(v => v.value === value)?.label ?? value, detail: s.detail, s };
      }),
      { placeHolder: 'Settings are saved as a "#@ssh-manager" comment in the config file' },
    );
    if (!setting) {
      return;
    }
    const value = await vscode.window.showQuickPick(
      setting.s.values.map(v => ({ label: v.label, value: v.value })),
      { placeHolder: setting.s.label },
    );
    if (value) {
      await store.mutate(d => setSettings(d, { [setting.s.key]: value.value }));
    }
  });

  reg('sshManager.remoteSpacing', async () => {
    const count = store.doc.spacers.length;
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: '$(add) Add empty rows between projects',
          detail: 'Writes one "Host <invisible name>" line above each "Host -----NAME-----" separator in the config file',
          on: true,
        },
        { label: '$(remove) Remove the empty rows', detail: `Deletes those lines again (${count} in the file now)`, on: false },
      ],
      { placeHolder: 'Spacing in the Remote-SSH "Select configured SSH host" picker' },
    );
    if (pick && (await store.mutate(d => setSpacers(d, pick.on)))) {
      vscode.window.showInformationMessage(
        pick.on
          ? `Added ${store.doc.spacers.length} empty rows. Open the Remote-SSH host picker to see them.`
          : 'Removed the empty rows.',
      );
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
      store.doc.groups.map(g => ({ label: `$(folder-library) ${g.title}`, description: g === node.c.parent ? 'current' : undefined, id: g.id })),
      { placeHolder: `Move sub-folder "${node.c.title}" to project…` },
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
        configFile: store.isDefaultPath ? undefined : store.configPath,
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
    const name = await askName('New group name');
    if (name) {
      await store.mutate(d => addGroup(d, name));
    }
  });

  reg('sshManager.addSection', async node => {
    if (node?.type !== 'container') {
      return;
    }
    const name = await askName(`New sub-group in "${node.c.title}"`);
    if (name) {
      await store.mutate(d => addSection(d, (node.c.parent ?? node.c).id, name));
    }
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
      vscode.window.showInformationMessage(`"${c.title}" still has hosts. Move or delete them first.`);
      return;
    }
    await store.mutate(d => deleteContainer(d, c.id));
  });
}

export function deactivate(): void {
  // nothing: everything is registered in context.subscriptions
}
