import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { isLetterId, MAX_META_CHARS, type Letter } from './files.ts';

export const LETTER_LIMITS = {
  subjectChars: 200,
  bodyBytes: 20_000,
  attachments: 5,
  attachmentBytes: 200_000,
  maxAgeMs: 10 * 60_000,
};

// Folder names are checked against every path segment, patterns against the file name.
const SECRET_DIRS = new Set(['.ssh', '.aws', '.git']);
const SECRET_NAMES = [/^\.env/, /\.pem$/, /\.key$/, /^id_/];

export interface Attachment { path: string; sha256: string; bytes: number }
export type Checked = { ok: true; letter: Letter; attachments: Attachment[] } | { ok: false; reason: string };

const refuse = (reason: string): Checked => ({ ok: false, reason });
const isStr = (v: unknown): v is string => typeof v === 'string';
const isSmallObject = (v: unknown): boolean =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && JSON.stringify(v).length <= MAX_META_CHARS;
const errCode = (e: unknown): string => (e as NodeJS.ErrnoException).code ?? 'error';

/** Fleet's full check of an inbox letter. The slot checks almost nothing;
 *  this is the one place a letter is judged. */
export function checkLetter(raw: any, now: number, specialists: string[]): Checked {
  if (raw === null || typeof raw !== 'object') return refuse('letter is not a JSON object');
  const { version, id, from, to, subject, body, attachments = [], re = null, sentAt } = raw;
  if (version !== 1 || !isLetterId(id) || !isStr(to) || !isStr(subject) || !isStr(body) || !isStr(sentAt)
    || (from?.tool !== 'claude' && from?.tool !== 'codex') || !isStr(from?.project) || !isAbsolute(from.project)
    || !Array.isArray(attachments) || !attachments.every(isStr) || (re !== null && !isLetterId(re))
    || (from.pid !== undefined && !(Number.isSafeInteger(from.pid) && from.pid > 0))
    || (from.meta !== undefined && !isSmallObject(from.meta))) {
    return refuse('letter is missing fields or has the wrong types');
  }
  const sent = Date.parse(sentAt);
  if (Number.isNaN(sent)) return refuse('letter has an invalid sentAt');
  if (now - sent > LETTER_LIMITS.maxAgeMs) return refuse('expired: sent more than 10 minutes ago');
  if (!specialists.includes(to)) return refuse(`unknown specialist "${to}"; known: ${specialists.join(', ') || 'none'}`);
  if (subject.length > LETTER_LIMITS.subjectChars) return refuse('subject is over 200 characters');
  if (Buffer.byteLength(body, 'utf8') > LETTER_LIMITS.bodyBytes) return refuse('body is over 20 KB');
  if (attachments.length > LETTER_LIMITS.attachments) return refuse('more than 5 attachments');

  let project: string;
  try {
    project = realpathSync(from.project);
    if (!statSync(project).isDirectory()) return refuse('project is not a folder');
  } catch (e) {
    return refuse(`project folder not found (${errCode(e)})`);
  }
  // The likeliest result of a slot started in the wrong folder.
  if (project === '/' || project === realpathSync(homedir())) {
    return refuse('project is the home folder or the disk root; start the agent in a project folder');
  }

  const checked: Attachment[] = [];
  for (const p of attachments as string[]) {
    let real: string;
    try {
      real = realpathSync(resolve(project, p));
    } catch (e) {
      return refuse(`attachment not found: ${p} (${errCode(e)})`);
    }
    const rel = relative(project, real);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return refuse(`attachment is outside the project ${project}: ${p}`);
    if (rel.split(sep).some(s => SECRET_DIRS.has(s)) || SECRET_NAMES.some(r => r.test(basename(rel)))) {
      return refuse(`attachment looks like a secret: ${p}`);
    }
    let content: Buffer;
    try {
      const st = statSync(real);
      if (!st.isFile()) return refuse(`attachment is not a file: ${p}`);
      if (st.size > LETTER_LIMITS.attachmentBytes) return refuse(`attachment is over 200 KB: ${p}`);
      content = readFileSync(real);
    } catch (e) {
      return refuse(`attachment cannot be read: ${p} (${errCode(e)})`);
    }
    checked.push({ path: rel, sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length });
  }
  return {
    ok: true,
    letter: {
      version: 1, id, to,
      from: { tool: from.tool, project, ...(from.pid !== undefined ? { pid: from.pid } : {}), ...(from.meta !== undefined ? { meta: from.meta } : {}) }, subject, body, attachments: checked.map(a => a.path), re, sentAt },
    attachments: checked,
  };
}
