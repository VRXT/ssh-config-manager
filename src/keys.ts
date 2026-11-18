/**
 * SSH key helpers for "Set Up SSH Key…", kept free of the vscode API so they can be tested in plain node.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Doc, findHost, hostToForm, updateHost } from './sshConfig';

export interface PublicKey {
  /** full path of the .pub file */
  pub: string;
  /** full path of the private key next to it */
  priv: string;
  /** e.g. ssh-ed25519 */
  type: string;
  comment: string;
}

/** Key pairs in a folder: every `*.pub` that has its private key next to it. */
export function listPublicKeys(dir: string): PublicKey[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: PublicKey[] = [];
  for (const name of names.filter(n => n.endsWith('.pub')).sort()) {
    const pub = path.join(dir, name);
    const priv = pub.slice(0, -4);
    if (!fs.existsSync(priv)) {
      continue;
    }
    let first = '';
    try {
      first = fs.readFileSync(pub, 'utf8').split(/\r?\n/)[0].trim();
    } catch {
      continue;
    }
    const [type = '', , ...rest] = first.split(/\s+/);
    if (!type.startsWith('ssh-') && !type.startsWith('ecdsa-') && !type.startsWith('sk-')) {
      continue;
    }
    out.push({ pub, priv, type, comment: rest.join(' ') });
  }
  return out;
}

/** Default file name for a new key made for one host: `id_ed25519_<alias>`, safe for any file system. */
export function keyFileName(alias: string): string {
  const safe = alias.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '') || 'host';
  return `id_ed25519_${safe}`;
}

/** Arguments for a non-interactive `ssh-keygen` that makes an ed25519 key pair. */
export function keygenArgs(file: string, passphrase: string, comment: string): string[] {
  return ['-t', 'ed25519', '-a', '100', '-f', file, '-N', passphrase, '-C', comment];
}

/**
 * Shell command that appends a public key to the server's ~/.ssh/authorized_keys, run in a terminal
 * so the user can type the server password. It goes through `ssh <alias>`, so everything in the
 * config (User, Port, ProxyJump, …) applies. The remote part avoids `$` and nested quotes so it
 * passes unchanged through sh/zsh/bash on macOS and Linux, and cmd/PowerShell on Windows.
 */
export function installKeyCommand(o: { platform: string; alias: string; pub: string; configFile?: string }): string {
  if (o.platform === 'win32') {
    const dq = (s: string) => `"${s.replace(/"/g, '')}"`;
    const remote = 'umask 077; mkdir -p ~/.ssh; echo >> ~/.ssh/authorized_keys; tr -d \\\\015 >> ~/.ssh/authorized_keys';
    return `type ${dq(o.pub)} | ssh ${o.configFile ? `-F ${dq(o.configFile)} ` : ''}${dq(o.alias)} "${remote}"`;
  }
  const sq = (s: string) => (/^[\w.@:%+,/=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  const remote = `'umask 077; mkdir -p ~/.ssh; echo >> ~/.ssh/authorized_keys; tr -d \\\\015 >> ~/.ssh/authorized_keys'`;
  return `ssh ${o.configFile ? `-F ${sq(o.configFile)} ` : ''}${sq(o.alias)} ${remote} < ${sq(o.pub)}`;
}

/** Adds an IdentityFile line to a host (no change when it is already there). Returns the new file text. */
export function addIdentityFile(doc: Doc, hostId: string, keyPath: string): string {
  const host = findHost(doc, hostId);
  if (!host) {
    throw new Error('The host is no longer in the config file.');
  }
  const form = hostToForm(doc, host);
  if (!form.identityFiles.includes(keyPath)) {
    form.identityFiles = [...form.identityFiles.filter(Boolean), keyPath];
  }
  return updateHost(doc, hostId, form);
}

export interface MissingKey {
  hostId: string;
  alias: string;
  /** the IdentityFile value as written in the config */
  key: string;
  /** where that is on this computer */
  file: string;
}

/**
 * Hosts whose SSH key is not on this computer: every IdentityFile they list is missing (ssh tries
 * each one that exists, so a host with at least one present is fine). Keys are never part of the
 * config or of any sync, so after moving to another computer this is what still has to be copied
 * over by hand. Paths with ssh tokens such as %h cannot be checked and count as present.
 */
export function missingKeys(doc: Doc, home: string): MissingKey[] {
  const out: MissingKey[] = [];
  for (const h of doc.hosts) {
    if (h.disabled) {
      continue;
    }
    const keys = h.options.filter(o => o.key.toLowerCase() === 'identityfile' && o.value && o.value.toLowerCase() !== 'none');
    if (!keys.length) {
      continue;
    }
    const resolved = keys.map(o => ({
      key: o.value,
      file: path.resolve(home, '.ssh', o.value === '~' || o.value.startsWith('~/') ? path.join(home, o.value.slice(1)) : o.value),
    }));
    if (resolved.some(k => k.key.includes('%') || fs.existsSync(k.file))) {
      continue;
    }
    out.push(...resolved.map(k => ({ hostId: h.id, alias: h.alias, key: k.key, file: k.file })));
  }
  return out;
}
