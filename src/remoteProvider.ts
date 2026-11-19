/**
 * Which extension opens `ssh-remote+<host>` windows in this editor.
 *
 * Microsoft's "Remote - SSH" only runs in Microsoft's VS Code. Cursor ships its own, and VSCodium,
 * Windsurf and other builds use "Open Remote - SSH" from Open VSX. They all resolve the same
 * `ssh-remote` authority, so connecting works the same way once one of them is installed.
 * Free of the vscode API so it can be tested in plain node.
 */

export interface InstalledExtension {
  id: string;
  packageJSON?: { activationEvents?: unknown };
}

export interface RemoteProvider {
  id: string;
  name: string;
}

/** Providers known by id, in case one does not declare its activation event the usual way. */
export const KNOWN_PROVIDERS: RemoteProvider[] = [
  { id: 'ms-vscode-remote.remote-ssh', name: 'Remote - SSH' },
  { id: 'anysphere.remote-ssh', name: 'Remote - SSH (Cursor)' },
  { id: 'jeanp413.open-remote-ssh', name: 'Open Remote - SSH' },
];

const RESOLVER_EVENT = 'onResolveRemoteAuthority:ssh-remote';

/** The installed extension that can open an ssh-remote window, if any. */
export function findRemoteProvider(installed: readonly InstalledExtension[]): RemoteProvider | undefined {
  for (const known of KNOWN_PROVIDERS) {
    if (installed.some(e => e.id.toLowerCase() === known.id)) {
      return known;
    }
  }
  // anything else that says it resolves ssh-remote (a fork's own build under another id)
  const other = installed.find(e => {
    const events = e.packageJSON?.activationEvents;
    return Array.isArray(events) && events.includes(RESOLVER_EVENT);
  });
  return other ? { id: other.id, name: other.id } : undefined;
}

/** The provider to recommend when none is installed, by the editor's own name (`vscode.env.appName`). */
export function suggestedProvider(appName: string): RemoteProvider {
  const app = appName.toLowerCase();
  if (app.includes('cursor')) {
    return KNOWN_PROVIDERS[1];
  }
  if (app.includes('visual studio code')) {
    return KNOWN_PROVIDERS[0];
  }
  return KNOWN_PROVIDERS[2];
}
