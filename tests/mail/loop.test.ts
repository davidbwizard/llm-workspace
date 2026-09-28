import { describe, it, expect } from 'vitest';
import { followUpProblem, loopStatusAfter, type LoopRow, type PassRow } from '../../src/mail/loop.ts';
import type { Letter } from '../../src/mail/files.ts';

const loop: LoopRow = { id: 'l'.repeat(32), specialist: 'codex-reviewer', project: '/p', fromTool: 'claude', status: 'open', passes: 1 };
const latest: PassRow = { id: 'a'.repeat(32), status: 'replied', attachments: [{ path: 'spec.md', sha256: 'old', bytes: 1 }] };
const letter: Letter = {
  version: 1, id: 'b'.repeat(32), from: { tool: 'claude', project: '/p' }, to: 'codex-reviewer',
  subject: 's', body: 'b', attachments: ['spec.md'], re: 'a'.repeat(32), sentAt: '',
};
const changed = [{ path: 'spec.md', sha256: 'new', bytes: 1 }];
const NOTHING = 'nothing changed since the last pass: attach the revised file';

describe('followUpProblem', () => {
  it('accepts the next pass when a file changed', () => {
    expect(followUpProblem(loop, latest, letter, changed)).toBeNull();
    expect(followUpProblem(loop, latest, letter, [...latest.attachments, { path: 'plan.md', sha256: 'x', bytes: 1 }])).toBeNull();
  });

  it('refuses a pass with nothing changed', () => {
    expect(followUpProblem(loop, latest, letter, latest.attachments)).toBe(NOTHING);
    expect(followUpProblem(loop, latest, letter, [])).toBe(NOTHING);
  });

  it('refuses closed, busy or mismatched loops', () => {
    expect(followUpProblem(null, null, letter, changed)).toBe('re does not match any loop');
    expect(followUpProblem({ ...loop, status: 'approved' }, latest, letter, changed)).toMatch(/already approved/);
    expect(followUpProblem({ ...loop, status: 'limit' }, latest, letter, changed)).toMatch(/pass limit/);
    expect(followUpProblem({ ...loop, status: 'failed' }, latest, letter, changed)).toMatch(/failed/);
    expect(followUpProblem(loop, { ...latest, id: 'c'.repeat(32) }, letter, changed)).toBe('re must be the latest letter in its loop');
    expect(followUpProblem(loop, { ...latest, status: 'running' }, letter, changed)).toBe('the previous pass has no reply yet');
    expect(followUpProblem(loop, latest, { ...letter, to: 'claude-reviewer' }, changed)).toMatch(/same project and agent/);
    expect(followUpProblem(loop, latest, { ...letter, from: { tool: 'codex', project: '/p' } }, changed)).toMatch(/same project and agent/);
  });
});

describe('loopStatusAfter', () => {
  it('closes on approval or at the limit', () => {
    expect(loopStatusAfter('approved', 1, 4)).toBe('approved');
    expect(loopStatusAfter('changes_requested', 3, 4)).toBe('open');
    expect(loopStatusAfter('changes_requested', 4, 4)).toBe('limit');
    expect(loopStatusAfter('changes_requested', 5, 4)).toBe('limit');
  });
});
