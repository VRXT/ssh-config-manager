/** Free of the vscode API so it can be tested in plain node. */
import { Doc } from './sshConfig';

const DECORATION = /^[⠀ㅤ ​-‍﻿]/;
const INVISIBLE = /[⠀ㅤ​-‍﻿]/g;

/** What the stock Remote-SSH list shows for this file: one row per `Host` name, in file order. */
export function remoteListPreview(doc: Doc, max = 16): { rows: { k: 'head' | 'host' | 'blank'; text: string }[]; more: number } {
  const rows: { k: 'head' | 'host' | 'blank'; text: string }[] = [];
  for (const line of doc.lines) {
    const m = /^[ \t]*Host[ \t]+(.+?)[ \t]*$/i.exec(line);
    if (!m) {
      continue;
    }
    const name = m[1].replace(/^"|"$/g, '');
    // (a non-breaking space is part of a name, so only real spaces and tabs split names)
    if (/[*?!]/.test(name) || /[ \t]/.test(name)) {
      continue; // patterns and multi-name entries are not offered by Remote-SSH
    }
    const text = name.replace(INVISIBLE, '').replace(/ /g, ' ').trim();
    if (!text) {
      rows.push({ k: 'blank', text: '' });
    } else if (DECORATION.test(name) || /^[-=_*~#+.]{2,}.*[-=_*~#+.]{2,}$/.test(text)) {
      rows.push({ k: 'head', text });
    } else {
      rows.push({ k: 'host', text });
    }
  }
  return { rows: rows.slice(0, max), more: Math.max(0, rows.length - max) };
}
