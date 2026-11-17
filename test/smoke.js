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
  await ext.activate();

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

  console.log('SMOKE OK');
};
