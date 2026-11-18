/**
 * Backups of the config file, kept in a folder next to it so they are easy to find, travel with
 * the file, and can be restored by hand even without the extension.
 * Free of the vscode API so it can be tested in plain node.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parse } from './sshConfig';

export const BACKUP_FOLDER = 'ssh-config-backups';

export interface Backup {
  file: string;
  name: string;
  /** when it was taken, read from the file name (falls back to the file's own date) */
  date: Date;
  size: number;
  /** number of `Host` blocks, a quick way to tell backups apart */
  hosts: number;
}

/** The backups folder that belongs to a config file. */
export function backupDir(configFile: string): string {
  return path.join(path.dirname(configFile), BACKUP_FOLDER);
}

/** `config-2026-11-18_21-05-33.bak` */
export function backupName(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `config-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}.bak`;
}

function dateFromName(name: string): Date | undefined {
  const m = /^config-(\d{4})-(\d{2})-(\d{2})[_T](\d{2})-(\d{2})-(\d{2})/.exec(name);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : undefined;
}

/** Newest first. Unreadable entries are skipped. */
export function listBackups(dir: string): Backup[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: Backup[] = [];
  for (const name of names.filter(n => n.endsWith('.bak'))) {
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      const text = fs.readFileSync(file, 'utf8');
      // real hosts only: patterns such as `Host *` and the Remote-SSH formatting rows do not count
      const hosts = parse(text).hosts.filter(h => !h.isPattern).length;
      out.push({ file, name, date: dateFromName(name) ?? stat.mtime, size: stat.size, hosts });
    } catch {
      // skip
    }
  }
  return out.sort((a, b) => b.date.getTime() - a.date.getTime() || b.name.localeCompare(a.name));
}

/**
 * Saves `text` as a new backup and deletes the oldest ones beyond `keep`.
 * Nothing is written when the newest backup already has the same content.
 * Returns the new file, or undefined when it was skipped.
 */
export function writeBackup(dir: string, text: string, keep = 30, now = new Date()): string | undefined {
  if (!text) {
    return undefined;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = listBackups(dir);
  if (existing.length) {
    try {
      if (fs.readFileSync(existing[0].file, 'utf8') === text) {
        return undefined;
      }
    } catch {
      // unreadable: take a new one
    }
  }
  let file = path.join(dir, backupName(now));
  for (let i = 2; fs.existsSync(file); i++) {
    file = path.join(dir, backupName(now).replace(/\.bak$/, `-${i}.bak`));
  }
  fs.writeFileSync(file, text, { mode: 0o600 });
  for (const old of listBackups(dir).slice(Math.max(1, keep))) {
    try {
      fs.unlinkSync(old.file);
    } catch {
      // leave it
    }
  }
  return file;
}

/** "2 minutes ago", "yesterday", "12 Nov 2026" */
export function ago(date: Date, now = new Date()): string {
  const s = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (s < 60) {
    return 'just now';
  }
  const m = Math.round(s / 60);
  if (m < 60) {
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  const h = Math.round(m / 60);
  if (h < 24) {
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const d = Math.round(h / 24);
  if (d === 1) {
    return 'yesterday';
  }
  if (d < 30) {
    return `${d} days ago`;
  }
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
