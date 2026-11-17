/**
 * The per-host "remote folder": opened by Remote-SSH on connect, and the starting folder of a
 * terminal session. Kept free of the vscode API so it can be tested in plain node.
 */

/**
 * Why a folder cannot be used, or undefined when it is fine. It must be an absolute path on the
 * server (Remote-SSH cannot expand `~`), and characters that would need shell escaping are refused
 * so the terminal command stays the same in sh, zsh, bash and PowerShell.
 */
export function folderProblem(folder: string): string | undefined {
  const f = folder.trim();
  if (!f) {
    return undefined;
  }
  if (!f.startsWith('/')) {
    return 'Use an absolute path on the server, starting with / (for example /var/www/html)';
  }
  if (/['"`$\\\r\n]/.test(f)) {
    return 'The path cannot contain quotes, $, ` or backslashes';
  }
  return undefined;
}

/**
 * `ssh` command that starts the login shell in a folder. Single quotes keep it literal in POSIX
 * shells and in PowerShell; the server's shell then runs `cd "<folder>" && exec $SHELL -l`.
 * Without a folder, or when the host has its own RemoteCommand (ssh refuses both), the plain
 * command is returned unchanged.
 */
export function sshInFolder(base: string, folder: string, hasRemoteCommand: boolean): string {
  const f = folder.trim();
  if (!f || hasRemoteCommand || folderProblem(f)) {
    return base;
  }
  return base.replace(/^ssh /, 'ssh -t ') + ` 'cd "${f}" && exec $SHELL -l'`;
}
