import type { Letter, LetterStatus, LoopStatus, Sender, Verdict } from './files.ts';
import type { Attachment } from './letter.ts';

export interface LoopRow { id: string; specialist: string; project: string; fromTool: Sender; status: LoopStatus; passes: number }
export interface PassRow { id: string; status: LetterStatus; attachments: Attachment[] }

/** Why a follow-up (a letter with `re`) cannot continue its loop, or null. */
export function followUpProblem(loop: LoopRow | null, latest: PassRow | null, letter: Letter, attachments: Attachment[]): string | null {
  if (!loop || !latest) return 're does not match any loop';
  if (loop.status === 'approved') return 'this loop is already approved; start a new loop for new work';
  if (loop.status === 'limit') return 'this loop reached its pass limit; David has been notified';
  if (loop.status === 'failed') return 'the last pass in this loop failed; start a new loop';
  if (latest.id !== letter.re) return 're must be the latest letter in its loop';
  if (latest.status !== 'replied') return 'the previous pass has no reply yet';
  if (loop.project !== letter.from.project || loop.fromTool !== letter.from.tool || loop.specialist !== letter.to) {
    return 'a follow-up must come from the same project and agent, to the same specialist';
  }
  // No banter: a new pass needs a new or changed file.
  const changed = attachments.some(a => latest.attachments.find(p => p.path === a.path)?.sha256 !== a.sha256);
  return changed ? null : 'nothing changed since the last pass: attach the revised file';
}

export function loopStatusAfter(verdict: Verdict, pass: number, passLimit: number): LoopStatus {
  if (verdict === 'approved') return 'approved';
  return pass >= passLimit ? 'limit' : 'open';
}
