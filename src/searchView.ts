import * as vscode from 'vscode';
import { describeFilter, facets, hostMatches } from './search';
import { Store } from './store';
import { HostTree } from './tree';

/**
 * The always-visible "Search" panel above the host tree: a search box that filters as you type
 * and clickable chips for tags, providers and groups.
 */
export class SearchViewProvider implements vscode.WebviewViewProvider {
  static readonly id = 'sshManager.search';
  private view: vscode.WebviewView | undefined;

  constructor(private readonly store: Store, private readonly tree: HostTree) {
    store.onDidChange(() => this.post());
    tree.onDidChangeFilter(() => this.post());
  }

  /** Puts the cursor in the search box (the magnifier button and the Filter command use this). */
  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${SearchViewProvider.id}.focus`);
    this.view?.webview.postMessage({ type: 'focus' });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html(view.webview);
    view.webview.onDidReceiveMessage(msg => {
      const f = this.tree.currentFilter;
      switch (msg?.type) {
        case 'ready':
          this.post();
          break;
        case 'text':
          this.tree.setFilter({ text: String(msg.value ?? '') });
          break;
        case 'toggle': {
          const kind = msg.kind as 'tags' | 'providers' | 'groups';
          if (!['tags', 'providers', 'groups'].includes(kind)) {
            return;
          }
          const value = String(msg.value);
          const list = f[kind].includes(value) ? f[kind].filter(v => v !== value) : [...f[kind], value];
          this.tree.setFilter({ [kind]: list });
          break;
        }
        case 'clear':
          this.tree.setFilter({ text: '', tags: [], providers: [], groups: [] });
          break;
      }
    });
    view.onDidDispose(() => (this.view = undefined));
  }

  private post(): void {
    if (!this.view) {
      return;
    }
    const docs = [this.store.doc, ...this.store.included];
    const hosts = docs.flatMap(d => d.hosts).filter(h => !h.isPattern);
    const filter = this.tree.currentFilter;
    const shown = hosts.filter(h => hostMatches(h, filter)).length;
    this.view.webview.postMessage({ type: 'state', filter, facets: facets(docs), shown, total: hosts.length });
    this.view.description = describeFilter(filter) || undefined;
  }
}

function html(webview: vscode.Webview): string {
  const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { padding: 8px 12px 10px 20px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  .box { position: relative; }
  input { width: 100%; box-sizing: border-box; padding: 4px 24px 4px 6px; font: inherit;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
  input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  input::placeholder { color: var(--vscode-input-placeholderForeground); }
  #x { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); border: 0; background: none; cursor: pointer;
    color: var(--vscode-icon-foreground); font-size: 14px; line-height: 1; padding: 2px 4px; display: none; }
  .meta { display: flex; justify-content: space-between; margin: 4px 0 2px; color: var(--vscode-descriptionForeground); font-size: .9em; }
  .meta a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  .meta a:hover { text-decoration: underline; }
  section { display: flex; gap: 6px; align-items: baseline; margin-top: 6px; }
  h3 { flex: 0 0 62px; margin: 0; font-size: .75em; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); }
  .chips { display: flex; flex-wrap: wrap; gap: 3px 4px; min-width: 0; }
  .chip { border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35)); background: transparent; color: var(--vscode-foreground);
    border-radius: 10px; padding: 0 7px; line-height: 18px; font: inherit; font-size: .9em; cursor: pointer; white-space: nowrap; }
  .chip:hover { background: var(--vscode-list-hoverBackground); }
  .chip span { color: var(--vscode-descriptionForeground); margin-left: 3px; }
  .chip.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
  .chip.on span { color: inherit; opacity: .8; }
  .chip:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  section.empty { display: none; }
</style>
</head>
<body>
  <div class="box">
    <input id="q" type="text" placeholder="Search hosts, options, notes…" aria-label="Search hosts" spellcheck="false">
    <button id="x" title="Clear search" aria-label="Clear search">✕</button>
  </div>
  <div class="meta"><span id="count"></span><a id="clear" role="button" tabindex="0">Clear filters</a></div>
  <section id="sec-tags"><h3>Tags</h3><div class="chips" id="tags"></div></section>
  <section id="sec-providers"><h3>Providers</h3><div class="chips" id="providers"></div></section>
  <section id="sec-groups"><h3>Groups</h3><div class="chips" id="groups"></div></section>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const q = $('q');
  let timer;
  q.addEventListener('input', () => {
    $('x').style.display = q.value ? 'block' : 'none';
    clearTimeout(timer);
    timer = setTimeout(() => vscode.postMessage({ type: 'text', value: q.value }), 120);
  });
  q.addEventListener('keydown', e => { if (e.key === 'Escape') { q.value = ''; q.dispatchEvent(new Event('input')); } });
  $('x').addEventListener('click', () => { q.value = ''; q.dispatchEvent(new Event('input')); q.focus(); });
  const clear = () => { q.value = ''; $('x').style.display = 'none'; vscode.postMessage({ type: 'clear' }); };
  $('clear').addEventListener('click', clear);
  $('clear').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') clear(); });

  function chips(kind, items, on, prefix) {
    const box = $(kind);
    box.replaceChildren();
    $('sec-' + kind).classList.toggle('empty', !items.length);
    for (const it of items) {
      const b = document.createElement('button');
      b.className = 'chip' + (on.includes(it.value) ? ' on' : '');
      b.setAttribute('aria-pressed', on.includes(it.value));
      b.textContent = prefix + it.value;
      const n = document.createElement('span');
      n.textContent = it.count;
      b.appendChild(n);
      b.addEventListener('click', () => vscode.postMessage({ type: 'toggle', kind, value: it.value }));
      box.appendChild(b);
    }
  }

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'focus') { q.focus(); q.select(); return; }
    if (data.type !== 'state') return;
    const f = data.filter;
    if (document.activeElement !== q && q.value !== f.text) q.value = f.text;
    $('x').style.display = q.value ? 'block' : 'none';
    const filtered = f.text.trim() || f.tags.length || f.providers.length || f.groups.length;
    $('count').textContent = filtered ? data.shown + ' of ' + data.total + ' hosts' : data.total + ' hosts';
    $('clear').style.visibility = filtered ? 'visible' : 'hidden';
    chips('tags', data.facets.tags, f.tags, '#');
    chips('providers', data.facets.providers, f.providers, '');
    chips('groups', data.facets.groups, f.groups, '');
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
