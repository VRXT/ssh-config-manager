import * as vscode from 'vscode';

/** Shared shell of the settings page, the setup wizard and the home page. Their styles and scripts live in media/ui. */

export const ART = ['welcome', 'folders', 'picker', 'backup', 'sync', 'keys', 'shortcuts', 'settings', 'done', 'start'] as const;
export type Art = (typeof ART)[number];

function nonce(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

/** Webview URIs of the illustrations in media/art. */
export function artUris(webview: vscode.Webview, extensionUri: vscode.Uri): Record<Art, string> {
  const out = {} as Record<Art, string>;
  for (const name of ART) {
    out[name] = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'art', `${name}.jpg`)).toString();
  }
  return out;
}

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] };
}

/**
 * A full HTML document with a strict content policy: styles, scripts and images only from the
 * extension's own media folder. `scripts` are file names in media/ui, loaded in order.
 */
export function page(webview: vscode.Webview, extensionUri: vscode.Uri, o: { title: string; scripts: string[]; styles?: string[]; bodyClass?: string }): string {
  const n = nonce();
  const ui = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'ui', file)).toString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${o.title}</title>
<link rel="stylesheet" href="${ui('ui.css')}">${(o.styles ?? []).map(f => `\n<link rel="stylesheet" href="${ui(f)}">`).join('')}
</head>
<body class="${o.bodyClass ?? ''}">
<div id="app"></div>
${o.scripts.map(f => `<script nonce="${n}" src="${ui(f)}"></script>`).join('\n')}
</body>
</html>`;
}
