import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { HostForm, PROVIDERS, addHost, allContainers, containerPath, emptyForm, findHost, hostToForm, providerOf, updateHost } from './sshConfig';
import { folderProblem } from './remote';
import { Store, collapseHome } from './store';
import { COLORS, ICONS } from './tree';

/** Opens the add/edit form. `hostId` undefined = new host. */
export function openHostEditor(store: Store, hostId: string | undefined, containerId = '', template?: HostForm): void {
  const doc = store.doc;
  const host = hostId ? findHost(doc, hostId) : undefined;
  if (hostId && !host) {
    vscode.window.showWarningMessage('That host is no longer in the config file.');
    return;
  }
  const form = template ?? (host ? hostToForm(doc, host) : emptyForm(containerId));
  const title = host ? `SSH: ${host.alias}` : 'SSH: New Host';

  const panel = vscode.window.createWebviewPanel('sshManager.host', title, vscode.ViewColumn.Active, {
    enableScripts: true,
  });

  const groups = [{ id: '', label: '(no group)' }, ...allContainers(doc).map(c => ({ id: c.id, label: containerPath(c) }))];
  panel.webview.html = html(panel.webview, { form, groups, icons: ICONS, colors: Object.keys(COLORS), isNew: !host,
    providers: PROVIDERS.map(p => ({ id: p.id, label: p.label })),
    detected: host ? providerOf({ ...host, attrs: { ...host.attrs, provider: '' } })?.label ?? '' : '',
  });

  panel.webview.onDidReceiveMessage(async msg => {
    if (msg.type === 'cancel') {
      panel.dispose();
    } else if (msg.type === 'browse') {
      const picked = await vscode.window.showOpenDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), '.ssh')),
        canSelectMany: false,
        openLabel: 'Use Key',
        title: 'Select private key',
      });
      if (picked?.[0]) {
        panel.webview.postMessage({ type: 'key', path: collapseHome(picked[0].fsPath) });
      }
    } else if (msg.type === 'save') {
      const f = msg.form as HostForm;
      const alias = f.alias.trim().replace(/\s+/g, ' ');
      const fail = (error: string) => panel.webview.postMessage({ type: 'error', error });
      if (!alias) {
        return fail('Name (Host alias) is required.');
      }
      if (f.port.trim() && !/^\d+$/.test(f.port.trim())) {
        return fail('Port must be a number.');
      }
      const folderError = folderProblem(f.folder ?? '');
      if (folderError) {
        return fail(`Remote folder: ${folderError}.`);
      }
      store.reload();
      if (store.doc.hosts.some(h => h.alias === alias && h.id !== hostId)) {
        return fail(`A host named "${alias}" already exists.`);
      }
      const ok = await store.mutate(d => (hostId ? updateHost(d, hostId, f) : addHost(d, f)));
      if (ok) {
        panel.dispose();
      }
    }
  });
}

function html(webview: vscode.Webview, data: unknown): string {
  const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { padding: 0 24px 32px; max-width: 760px; margin: 0 auto; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  h1 { font-size: 1.5em; font-weight: 600; margin: 24px 0 4px; }
  p.sub { margin: 0 0 20px; color: var(--vscode-descriptionForeground); }
  h2 { font-size: 0.8em; text-transform: uppercase; letter-spacing: .08em; color: var(--vscode-descriptionForeground);
       margin: 28px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.3)); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; }
  .full { grid-column: 1 / -1; }
  @media (max-width: 520px) { .grid { grid-template-columns: 1fr; } }
  label { display: block; font-size: .9em; margin-bottom: 4px; }
  label small, .hint { color: var(--vscode-descriptionForeground); font-size: .85em; font-weight: normal; }
  input[type=text], select, textarea {
    width: 100%; box-sizing: border-box; padding: 6px 8px; font-family: inherit; font-size: inherit;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent)); border-radius: 3px;
  }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); }
  textarea { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); resize: vertical; }
  input:focus, select:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .row { display: flex; gap: 8px; align-items: flex-start; }
  .row > :first-child { flex: 1; }
  button { padding: 6px 14px; border: none; border-radius: 3px; cursor: pointer; font-family: inherit; font-size: inherit;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .colors { display: flex; gap: 8px; flex-wrap: wrap; }
  .colors label { margin: 0; cursor: pointer; }
  .colors input { position: absolute; opacity: 0; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 12px;
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.4)); font-size: .9em; }
  .chip i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; background: var(--vscode-descriptionForeground); }
  .colors input:checked + .chip { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .colors input:focus-visible + .chip { outline: 1px solid var(--vscode-focusBorder); }
  .check { display: flex; align-items: center; gap: 8px; margin-top: 22px; }
  .check input { margin: 0; }
  .check label { margin: 0; }
  .actions { display: flex; gap: 8px; margin-top: 28px; }
  #error { display: none; margin-top: 16px; padding: 8px 12px; border-radius: 3px;
    background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
</style>
</head>
<body>
  <h1 id="title"></h1>
  <p class="sub">Saved straight into your SSH config. Look &amp; organization fields are written as a <code>#@host</code> comment above the entry.</p>

  <form id="f">
    <h2>Connection</h2>
    <div class="grid">
      <div><label for="alias">Name <small>(Host alias)</small></label><input type="text" id="alias" spellcheck="false" autocomplete="off"></div>
      <div><label for="hostName">HostName <small>(IP or DNS)</small></label><input type="text" id="hostName" spellcheck="false" autocomplete="off"></div>
      <div><label for="user">User</label><input type="text" id="user" spellcheck="false" autocomplete="off"></div>
      <div><label for="port">Port</label><input type="text" id="port" placeholder="22" inputmode="numeric" autocomplete="off"></div>
      <div class="full">
        <label for="identityFiles">Identity files <small>(one per line — ssh tries each that exists)</small></label>
        <div class="row">
          <textarea id="identityFiles" rows="2" spellcheck="false"></textarea>
          <button type="button" class="secondary" id="browse">Browse…</button>
        </div>
      </div>
      <div><label for="identitiesOnly">IdentitiesOnly</label>
        <select id="identitiesOnly"><option value="">(default)</option><option>yes</option><option>no</option></select></div>
      <div><label for="forwardAgent">ForwardAgent</label>
        <select id="forwardAgent"><option value="">(default)</option><option>yes</option><option>no</option></select></div>
      <div class="full"><label for="proxyJump">ProxyJump <small>(jump host alias)</small></label><input type="text" id="proxyJump" spellcheck="false" autocomplete="off"></div>
      <div class="full"><label for="folder">Remote folder <small>(opened directly when you connect, e.g. /var/www/html)</small></label><input type="text" id="folder" spellcheck="false" autocomplete="off" placeholder="/home/user/project"></div>
      <div class="full">
        <label for="extra">Other options <small>(raw ssh_config lines, e.g. <code>LocalForward 8080 localhost:80</code>; <code>#</code> comments are kept)</small></label>
        <textarea id="extra" rows="4" spellcheck="false"></textarea>
      </div>
    </div>

    <h2>Look &amp; organization</h2>
    <div class="grid">
      <div><label for="container">Group</label><select id="container"></select></div>
      <div><label for="provider">Provider <small>(where it runs)</small></label><select id="provider"></select></div>
      <div><label for="icon">Icon</label><select id="icon"></select></div>
      <div></div>
      <div class="full"><label>Color</label><div class="colors" id="colors"></div></div>
      <div><label for="tags">Tags <small>(comma separated)</small></label><input type="text" id="tags" spellcheck="false" autocomplete="off"></div>
      <div class="check"><input type="checkbox" id="fav"><label for="fav">Favorite — pin to the top of the list</label></div>
      <div class="full"><label for="note">Note</label><input type="text" id="note" autocomplete="off"></div>
    </div>

    <div id="error" role="alert"></div>
    <div class="actions">
      <button type="submit" id="save">Save</button>
      <button type="button" class="secondary" id="cancel">Cancel</button>
    </div>
  </form>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const data = ${json};
  const $ = id => document.getElementById(id);
  const f = data.form;

  $('title').textContent = data.isNew ? 'New SSH host' : 'Edit ' + f.alias;
  for (const g of data.groups) $('container').add(new Option(g.label, g.id));
  $('provider').add(new Option(data.detected ? 'Automatic — ' + data.detected : 'Automatic', ''));
  for (const p of data.providers) $('provider').add(new Option(p.label, p.id));
  if (f.provider && !data.providers.some(p => p.id === f.provider)) $('provider').add(new Option(f.provider, f.provider));
  $('icon').add(new Option('(automatic)', ''));
  for (const i of data.icons) $('icon').add(new Option(i, i));
  if (f.icon && !data.icons.includes(f.icon)) $('icon').add(new Option(f.icon, f.icon));

  const colorVar = { red: 'charts-red', orange: 'charts-orange', yellow: 'charts-yellow', green: 'charts-green', blue: 'charts-blue', purple: 'charts-purple' };
  for (const c of ['', ...data.colors]) {
    const label = document.createElement('label');
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'color', value: c });
    const chip = document.createElement('span');
    chip.className = 'chip';
    const dot = document.createElement('i');
    if (c) dot.style.background = 'var(--vscode-' + colorVar[c] + ')';
    chip.append(dot, c || 'none');
    label.append(input, chip);
    $('colors').append(label);
  }

  for (const k of ['alias', 'hostName', 'user', 'port', 'proxyJump', 'extra', 'tags', 'note', 'folder', 'container', 'icon', 'provider', 'identitiesOnly', 'forwardAgent']) $(k).value = f[k] ?? '';
  $('identityFiles').value = f.identityFiles.join('\\n');
  $('fav').checked = !!f.fav;
  (document.querySelector('input[name=color][value="' + (data.colors.includes(f.color) ? f.color : '') + '"]')).checked = true;
  const lines = () => $('identityFiles').value.split('\\n').map(s => s.trim()).filter(Boolean);
  const fit = () => { $('identityFiles').rows = Math.max(2, lines().length + 1); };
  fit();
  $('identityFiles').addEventListener('input', fit);
  $('alias').focus();

  $('browse').addEventListener('click', () => vscode.postMessage({ type: 'browse' }));
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  $('f').addEventListener('submit', e => {
    e.preventDefault();
    $('error').style.display = 'none';
    const form = { identityFiles: lines(), fav: $('fav').checked, color: document.querySelector('input[name=color]:checked').value };
    for (const k of ['alias', 'hostName', 'user', 'port', 'proxyJump', 'extra', 'tags', 'note', 'folder', 'container', 'icon', 'provider', 'identitiesOnly', 'forwardAgent']) form[k] = $(k).value;
    vscode.postMessage({ type: 'save', form });
  });
  window.addEventListener('message', e => {
    if (e.data.type === 'key') {
      $('identityFiles').value = [...lines(), e.data.path].join('\\n');
      fit();
    } else if (e.data.type === 'error') {
      $('error').textContent = e.data.error;
      $('error').style.display = 'block';
    }
  });
</script>
</body>
</html>`;
}
