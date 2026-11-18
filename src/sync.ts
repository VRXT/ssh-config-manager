/**
 * Keeping the config the same on several computers through a file in a synced folder
 * (Dropbox, iCloud Drive, OneDrive, …). Three ways, the user picks one:
 *
 *  - copy:    ~/.ssh/config stays a normal local file; changes are copied to the shared file and
 *             changes from other computers are copied back. Works everywhere, also offline.
 *  - link:    ~/.ssh/config becomes a symbolic link to the shared file. One real file.
 *  - include: ~/.ssh/config keeps one `Include "<shared file>"` line; the extension edits the
 *             shared file. Whatever else is in ~/.ssh/config stays local to that computer.
 *
 * SSH keys are never synced by any of them: each computer needs its own copy of the keys.
 * Free of the vscode API so it can be tested in plain node.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type SyncMode = 'off' | 'copy' | 'link' | 'include';

export const SYNC_MODES: { id: Exclude<SyncMode, 'off'>; label: string; summary: string; detail: string }[] = [
  {
    id: 'copy',
    label: 'Copy both ways',
    summary: 'Works on Mac, Windows and Linux, and offline.',
    detail: 'Your config stays a normal file on this computer. Every change is copied to the shared file, and changes made on your other computers are copied back here, with a backup first.',
  },
  {
    id: 'link',
    label: 'Link to the shared file',
    summary: 'One real file. Needs symbolic links (admin rights on Windows).',
    detail: 'Your config becomes a link to the shared file, so there is only one copy. If the synced folder is missing, ssh cannot read the config.',
  },
  {
    id: 'include',
    label: 'Include the shared file',
    summary: 'Shared hosts in one file, this computer’s own settings in another.',
    detail: 'Your config keeps a single Include line that points at the shared file. The extension edits the shared file; anything else in your config stays on this computer only.',
  },
];

export function hashText(text: string): string {
  return crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
}

function read(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Hash of a file's text, or undefined when it does not exist (or cannot be read). */
export function hashFile(file: string): string | undefined {
  const text = read(file);
  return text === undefined ? undefined : hashText(text);
}

export function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

// ---------------------------------------------------------------- copy

export type CopyAction = 'noop' | 'push' | 'pull' | 'conflict';

/**
 * What "copy both ways" has to do, from three hashes: this computer's file, the shared file, and
 * the content both had after the last sync (`base`; undefined before the first one).
 *  - push: only this computer changed (or the shared file does not exist yet)
 *  - pull: only the shared file changed (or this computer has no config yet)
 *  - conflict: both changed, or they differ and were never synced: the user has to choose
 */
export function decideCopy(local: string | undefined, remote: string | undefined, base: string | undefined): CopyAction {
  if (remote === undefined) {
    return local === undefined ? 'noop' : 'push';
  }
  if (local === undefined) {
    return 'pull';
  }
  if (local === remote) {
    return 'noop';
  }
  if (base === undefined) {
    return 'conflict';
  }
  if (local === base) {
    return 'pull';
  }
  if (remote === base) {
    return 'push';
  }
  return 'conflict';
}

/** Copies a file's content without leaving a half-written file behind. */
export function copyContent(from: string, to: string): void {
  const text = fs.readFileSync(from, 'utf8');
  writeContent(to, text);
}

export function writeContent(to: string, text: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  let target = to;
  try {
    target = fs.realpathSync(to); // write through a link instead of replacing it
  } catch {
    // new file
  }
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

// ---------------------------------------------------------------- link

export function isLinkTo(local: string, shared: string): boolean {
  try {
    return fs.lstatSync(local).isSymbolicLink() && samePath(local, shared);
  } catch {
    return false;
  }
}

/** Replaces `local` with a symbolic link to `shared` (which must exist). Back up `local` first. */
export function makeLink(local: string, shared: string): void {
  if (!fs.existsSync(shared)) {
    throw new Error(`The shared file does not exist: ${shared}`);
  }
  fs.mkdirSync(path.dirname(local), { recursive: true, mode: 0o700 });
  const tmp = `${local}.tmp-link-${process.pid}`;
  try {
    fs.unlinkSync(tmp);
  } catch {
    // not there
  }
  fs.symlinkSync(shared, tmp);
  fs.renameSync(tmp, local);
}

/** Turns a linked config back into a normal file with the same content. */
export function unlinkToCopy(local: string): void {
  if (!fs.lstatSync(local).isSymbolicLink()) {
    return;
  }
  const text = fs.readFileSync(local, 'utf8');
  const tmp = `${local}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, local);
}

// ---------------------------------------------------------------- include

const expand = (p: string) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);
const slashes = (p: string) => p.replace(/\\/g, '/');

/** The line written into ~/.ssh/config. Quoted, so paths with spaces work; forward slashes also on Windows. */
export function includeLine(shared: string): string {
  return `Include "${slashes(shared)}"`;
}

function includeTargets(line: string): string[] {
  const m = /^\s*Include[\s=]+(.*)$/i.exec(line);
  if (!m) {
    return [];
  }
  return (m[1].match(/"[^"]*"|\S+/g) ?? []).map(t => t.replace(/^"|"$/g, ''));
}

const pointsAt = (target: string, shared: string, sshDir: string) =>
  slashes(path.resolve(sshDir, expand(target))) === slashes(path.resolve(shared));

/** Whether a config already includes the shared file (relative Include paths are relative to ~/.ssh). */
export function hasInclude(text: string, shared: string, sshDir = path.join(os.homedir(), '.ssh')): boolean {
  return text.split(/\r?\n/).some(l => includeTargets(l).some(t => pointsAt(t, shared, sshDir)));
}

/** Adds the Include line at the very top, where it applies to every host. No change when it is there already. */
export function addInclude(text: string, shared: string, sshDir?: string): string {
  if (hasInclude(text, shared, sshDir)) {
    return text;
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const rest = text.replace(/^(\r?\n)+/, '');
  return includeLine(shared) + eol + (rest ? eol + rest : '');
}

/** Removes Include lines that point at the shared file (other Include lines are kept). */
export function removeInclude(text: string, shared: string, sshDir = path.join(os.homedir(), '.ssh')): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const l of lines) {
    const targets = includeTargets(l);
    if (!targets.length || !targets.some(t => pointsAt(t, shared, sshDir))) {
      out.push(l);
      continue;
    }
    const others = targets.filter(t => !pointsAt(t, shared, sshDir));
    if (others.length) {
      out.push('Include ' + others.map(t => (/\s/.test(t) ? `"${t}"` : t)).join(' '));
    }
  }
  return out.join(eol).replace(/^(\r?\n)+/, '');
}

// ---------------------------------------------------------------- where the cloud folders are

/** Synced folders found on this computer, to offer as starting points in the file picker. */
export function cloudFolders(home = os.homedir()): { label: string; dir: string }[] {
  const found: { label: string; dir: string }[] = [];
  const add = (label: string, dir: string) => {
    try {
      if (fs.statSync(dir).isDirectory() && !found.some(f => f.dir === dir)) {
        found.push({ label, dir });
      }
    } catch {
      // not on this computer
    }
  };
  add('iCloud Drive', path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));
  add('Dropbox', path.join(home, 'Dropbox'));
  add('OneDrive', path.join(home, 'OneDrive'));
  add('Google Drive', path.join(home, 'Google Drive'));
  try {
    for (const name of fs.readdirSync(path.join(home, 'Library', 'CloudStorage'))) {
      const label = name.startsWith('OneDrive') ? 'OneDrive' : name.startsWith('Dropbox') ? 'Dropbox' : name.startsWith('GoogleDrive') ? 'Google Drive' : name;
      add(label, path.join(home, 'Library', 'CloudStorage', name));
    }
  } catch {
    // not macOS, or none
  }
  if (process.env.OneDrive) {
    add('OneDrive', process.env.OneDrive);
  }
  return found;
}
