// Runs inside a real VS Code extension host: Code --extensionDevelopmentPath=. --extensionTestsPath=test/smoke.js
// Points the extension at a throw-away config file and drives it through its commands.
const assert = require('assert');
const fs = require('fs');
const vscode = require('vscode');

exports.run = async function run() {
  const file = process.env.SSH_MANAGER_TEST_CONFIG;
  assert.ok(file && fs.existsSync(file), 'SSH_MANAGER_TEST_CONFIG must point to a scratch config');
  const read = () => fs.readFileSync(file, 'utf8');
  const before = read();

  await vscode.workspace.getConfiguration('sshManager').update('configFile', file, vscode.ConfigurationTarget.Global);
  const ext = vscode.extensions.getExtension('vrxt.ssh-config-manager');
  assert.ok(ext, 'extension is installed in the dev host');
  const api = await ext.activate();
  // starting up must stay cheap: the extension loads in every window
  console.log('ACTIVATION_MS ' + api.activationMs);
  assert.ok(api.activationMs < 400, `activation took ${api.activationMs} ms`);

  const all = await vscode.commands.getCommands(true);
  for (const c of ext.packageJSON.contributes.commands) {
    assert.ok(all.includes(c.command), `command registered: ${c.command}`);
  }

  await vscode.commands.executeCommand('sshManager.hosts.focus');
  await vscode.commands.executeCommand('sshManager.refresh');
  assert.strictEqual(read(), before, 'loading and refreshing never writes');

  // the form opens for a new host (webview creation must not throw)
  await vscode.commands.executeCommand('sshManager.addHost');
  await new Promise(r => setTimeout(r, 1500));
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  // the home page opens, its settings section opens, and neither writes to the config
  await vscode.commands.executeCommand('sshManager.home');
  await new Promise(r => setTimeout(r, 1500));
  await vscode.commands.executeCommand('sshManager.settingsPage', 'home');
  await new Promise(r => setTimeout(r, 1200));
  await vscode.commands.executeCommand('sshManager.clearRecentHosts');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  assert.strictEqual(read(), before, 'opening the home page and its settings never writes');

  console.log('SMOKE OK');
};
