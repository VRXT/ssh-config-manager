/**
 * Reading the config file in a way that survives cloud-synced folders, and saying in plain words
 * what went wrong when it cannot be read. Kept free of the vscode API so it can be tested in plain node.
 */
import * as fs from 'fs';

/**
 * Errors that usually go away by themselves a moment later. A file in OneDrive, iCloud Drive or
 * Dropbox is handed out by the sync app: while it is downloading or updating the file, a read can
 * be interrupted (EINTR), refused for now (EAGAIN, EBUSY, EDEADLK) or time out.
 */
const TRANSIENT = new Set(['EINTR', 'EAGAIN', 'EBUSY', 'EDEADLK', 'ETIMEDOUT', 'EIO']);

export function isTransient(code: string | undefined): boolean {
  return !!code && TRANSIENT.has(code);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface ReadOptions {
  read?: (file: string) => string;
  sleep?: (ms: number) => void;
  /** how many times to try in all */
  tries?: number;
}

/**
 * The file's text. An error that is likely to pass is tried again a few times, a little later each
 * time (about half a second in all). The error that is thrown in the end carries `attempts`.
 */
export function readText(file: string, o: ReadOptions = {}): string {
  const read = o.read ?? ((f: string) => fs.readFileSync(f, 'utf8'));
  const sleep = o.sleep ?? sleepSync;
  const tries = Math.max(1, o.tries ?? 5);
  for (let attempt = 1; ; attempt++) {
    try {
      return read(file);
    } catch (e: any) {
      if (attempt >= tries || !isTransient(e?.code)) {
        if (e && typeof e === 'object') {
          e.attempts = attempt;
        }
        throw e;
      }
      sleep(40 * attempt);
    }
  }
}

/** The sync service a path belongs to, going by its folder names. */
export function cloudService(realPath: string): string | undefined {
  const p = realPath.replace(/\\/g, '/');
  if (/\/OneDrive[^/]*\//i.test(p)) return 'OneDrive';
  if (/\/Mobile Documents\/|\/iCloud ?Drive\//i.test(p)) return 'iCloud Drive';
  if (/\/Dropbox[^/]*\//i.test(p)) return 'Dropbox';
  if (/\/Google ?Drive[^/]*\//i.test(p)) return 'Google Drive';
  if (/\/Library\/CloudStorage\//.test(p)) return 'a cloud-synced folder';
  return undefined;
}

export interface ReadProblem {
  /** the path as configured */
  file: string;
  /** where it really is, when it is a link to somewhere else */
  real: string;
  code: string;
  /** the system's own message */
  message: string;
  attempts: number;
  /** one sentence: what happened */
  title: string;
  /** one or two sentences: the likely reason */
  why: string;
  /** what to do about it, most likely first */
  steps: string[];
  /** true when the extension keeps trying by itself */
  retrying: boolean;
}

/** `show`: how the path is shown to the user (`~/.ssh/config`). */
export function explainReadError(e: any, file: string, real: string, show: (p: string) => string = p => p, platform: string = process.platform): ReadProblem {
  const code = String(e?.code ?? '');
  const message = String(e?.message ?? e);
  const attempts = Number(e?.attempts) || 1;
  const cloud = cloudService(real);
  const linked = real !== file;
  const where = linked ? `${show(file)} (a link to ${show(real)})` : show(file);
  const base = { file, real, code, message, attempts };
  const title = `Cannot read ${show(file)}`;

  if (isTransient(code)) {
    const app = cloud && cloud !== 'a cloud-synced folder' ? cloud : 'the sync app';
    return {
      ...base, title, retrying: true,
      why: cloud
        ? `The file is in ${cloud}, and ${app} did not hand it over in time (${code}). This usually passes by itself: the file is being downloaded or updated.`
        : `The system interrupted the read (${code}). This usually passes by itself.`,
      steps: [
        'Nothing to do if it clears up: the extension keeps trying and your hosts come back by themselves.',
        ...(cloud ? [
          `Check that ${app} is running and signed in, and that it has finished syncing.`,
          `Keep the file on this computer: in ${platform === 'darwin' ? 'Finder' : 'the file manager'}, right-click it and choose "Always Keep on This Device" (or "Download Now").`,
        ] : []),
        `Test it in a terminal: cat "${real}"`,
        ...(cloud ? ['If it keeps happening, keep a normal copy in ~/.ssh/config and let the extension sync it for you: Settings → Sync.'] : []),
      ],
    };
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return {
      ...base, title, retrying: false,
      why: `The editor is not allowed to read ${where} (${code}).`,
      steps: [
        `Make the file yours and readable: chmod 600 "${real}"`,
        ...(platform === 'darwin' ? ['On macOS, allow the editor to reach the folder: System Settings → Privacy & Security → Files and Folders (or Full Disk Access).'] : []),
        'Then press Try Again.',
      ],
    };
  }
  if (code === 'EISDIR') {
    return {
      ...base, title, retrying: false,
      why: `${where} is a folder, not a file.`,
      steps: ['Choose the config file itself: Settings → General → Config file → Change…'],
    };
  }
  if (code === 'ELOOP' || code === 'ENOTDIR') {
    return {
      ...base, title, retrying: false,
      why: `The path ${show(file)} does not lead to a file (${code}): a link on the way points to the wrong place.`,
      steps: [`Look at where it points: ls -l "${file}"`, 'Fix the link, or choose another file: Settings → General → Config file → Change…'],
    };
  }
  return {
    ...base, title, retrying: false,
    why: `The system reported: ${message}`,
    steps: [`Test it in a terminal: cat "${real}"`, 'Then press Try Again.'],
  };
}

/** The whole explanation as text, for the log. */
export function problemReport(p: ReadProblem): string[] {
  return [
    p.title,
    `  Why:      ${p.why}`,
    `  File:     ${p.file}`,
    ...(p.real !== p.file ? [`  Links to: ${p.real}`] : []),
    `  System:   ${p.message}${p.attempts > 1 ? ` (tried ${p.attempts} times)` : ''}`,
    '  What to do:',
    ...p.steps.map((s, i) => `    ${i + 1}. ${s}`),
  ];
}
