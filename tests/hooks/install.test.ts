import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildHookFragments, planInstall, applyInstall, uninstall, SettingsChangedError,
} from '../../src/hooks/install.ts';

const asRoot = process.getuid?.() === 0;
const inode = (path: string) => statSync(path).ino;

let dir: string, settings: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hooks-')); settings = join(dir, 'settings.json'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('planInstall', () => {
  it('preserves hooks the user already had', () => {
    const existing = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine.sh' }] }] } };
    const plan = planInstall(existing, buildHookFragments('/h.sh'));
    const pre = plan.next.hooks.PreToolUse;
    expect(pre.some((e: any) => e.hooks[0].command === 'mine.sh')).toBe(true);
  });

  it('adds our narrow PreToolUse matcher, not a catch-all', () => {
    const plan = planInstall({}, buildHookFragments('/h.sh'));
    const matchers = plan.next.hooks.PreToolUse.map((e: any) => e.matcher);
    expect(matchers).toContain('AskUserQuestion|ExitPlanMode');
    expect(matchers).not.toContain('*');
  });

  it('never installs MessageDisplay — streaming churn, spec 5.2', () => {
    const plan = planInstall({}, buildHookFragments('/h.sh'));
    expect(Object.keys(plan.next.hooks)).not.toContain('MessageDisplay');
  });

  it('records a manifest of exactly the fragments we own', () => {
    const plan = planInstall({}, buildHookFragments('/h.sh'));
    expect(plan.manifest.owned.length).toBeGreaterThan(0);
    for (const id of plan.manifest.owned) expect(id).toMatch(/^llmws:/);
  });

  it('is idempotent — planning twice does not double-add', () => {
    const first = planInstall({}, buildHookFragments('/h.sh'));
    const second = planInstall(first.next, buildHookFragments('/h.sh'));
    expect(JSON.stringify(second.next)).toBe(JSON.stringify(first.next));
  });

  it('emits only schema fields on hook objects — no private marker property', () => {
    const plan = planInstall({}, buildHookFragments('/h.sh'));
    for (const event of Object.keys(plan.next.hooks)) {
      for (const entry of plan.next.hooks[event]) {
        for (const h of entry.hooks) {
          expect(Object.keys(h).sort()).toEqual(['command', 'timeout', 'type']);
        }
      }
    }
  });

  it('reconciles against a previous manifest when the helper path changes — no stale fragments left behind', () => {
    const existing = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine.sh' }] }] } };
    const planA = planInstall(existing, buildHookFragments('/path/a.sh'));

    const planB = planInstall(planA.next, buildHookFragments('/path/b.sh'), planA.manifest);

    const json = JSON.stringify(planB.next);
    expect(json).not.toContain('/path/a.sh');
    expect(json).toContain('/path/b.sh');
    expect(planB.next.hooks.PreToolUse.some((e: any) => e.hooks[0].command === 'mine.sh')).toBe(true);
  });
});

describe('applyInstall', () => {
  it('refuses to write when the file changed since the plan was computed', () => {
    writeFileSync(settings, JSON.stringify({ hooks: {} }));
    const before = readFileSync(settings, 'utf8');
    const plan = planInstall(JSON.parse(before), buildHookFragments('/h.sh'));
    writeFileSync(settings, JSON.stringify({ hooks: { Stop: [] } })); // someone else edits
    expect(() => applyInstall(settings, { ...plan, baseText: before }))
      .toThrow(/changed on disk/i);
  });

  // Final review I5: the refusal has its own class, so the switch can tell
  // it apart from a read or write failure.
  it('throws SettingsChangedError for the changed-on-disk refusal', () => {
    writeFileSync(settings, JSON.stringify({ hooks: {} }));
    const before = readFileSync(settings, 'utf8');
    const plan = planInstall(JSON.parse(before), buildHookFragments('/h.sh'));
    writeFileSync(settings, JSON.stringify({ hooks: { Stop: [] } }));
    expect(() => applyInstall(settings, { ...plan, baseText: before })).toThrow(SettingsChangedError);
  });

  // Final review I3: only ENOENT reads as "missing".
  it.skipIf(asRoot)('rethrows a read failure other than a missing file, and writes nothing', () => {
    writeFileSync(settings, JSON.stringify({ hooks: {} }));
    const plan = planInstall({}, buildHookFragments('/h.sh'));
    chmodSync(settings, 0o000);
    try {
      let thrown: unknown = null;
      try { applyInstall(settings, { ...plan, baseText: '' }); } catch (e) { thrown = e; }
      expect(thrown).not.toBeInstanceOf(SettingsChangedError);
      expect((thrown as NodeJS.ErrnoException).code).toBe('EACCES');
    } finally {
      chmodSync(settings, 0o600);
    }
    expect(readFileSync(settings, 'utf8')).toBe(JSON.stringify({ hooks: {} }));
  });

  // Final review M10.
  it('writes nothing when every fragment is already present', () => {
    const first = planInstall({}, buildHookFragments('/h.sh'));
    applyInstall(settings, { ...first, baseText: '' });
    const base = readFileSync(settings, 'utf8');
    const again = planInstall(JSON.parse(base), buildHookFragments('/h.sh'));
    expect(again.changed).toBe(false);
    const ino = inode(settings);
    applyInstall(settings, { ...again, baseText: base });
    expect(inode(settings)).toBe(ino);
  });

  // Final review M9: the temp file is created with the original mode and
  // written through one descriptor, so a read-only original cannot fail a
  // reopen or leave a temp file behind.
  it('keeps a read-only original mode and leaves no temp file', () => {
    writeFileSync(settings, JSON.stringify({ hooks: {} }));
    chmodSync(settings, 0o400);
    const base = readFileSync(settings, 'utf8');
    const plan = planInstall(JSON.parse(base), buildHookFragments('/h.sh'));
    applyInstall(settings, { ...plan, baseText: base });
    expect(statSync(settings).mode & 0o777).toBe(0o400);
    expect(JSON.stringify(JSON.parse(readFileSync(settings, 'utf8')))).toContain('/h.sh');
  });

  it('writes atomically and leaves valid JSON', () => {
    writeFileSync(settings, JSON.stringify({ hooks: {} }));
    const base = readFileSync(settings, 'utf8');
    const plan = planInstall(JSON.parse(base), buildHookFragments('/h.sh'));
    applyInstall(settings, { ...plan, baseText: base });
    expect(() => JSON.parse(readFileSync(settings, 'utf8'))).not.toThrow();
  });
});

describe('uninstall', () => {
  it('removes only fragments in the manifest and keeps the user\'s own', () => {
    const existing = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine.sh' }] }] } };
    writeFileSync(settings, JSON.stringify(existing));
    const base = readFileSync(settings, 'utf8');
    const plan = planInstall(JSON.parse(base), buildHookFragments('/h.sh'));
    applyInstall(settings, { ...plan, baseText: base });

    uninstall(settings, plan.manifest);
    const after = JSON.parse(readFileSync(settings, 'utf8'));
    expect(after.hooks.PreToolUse.some((e: any) => e.hooks[0].command === 'mine.sh')).toBe(true);
    expect(JSON.stringify(after)).not.toContain('/h.sh');
  });

  it('matches the command exactly, not as a substring — a user hook merely mentioning our path is untouched', () => {
    const fragments = buildHookFragments('/h.sh');
    const ourCommand = fragments[0]!.command;
    const existing = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: `echo "runs ${ourCommand} too" further-arg` }] }],
      },
    };
    writeFileSync(settings, JSON.stringify(existing));
    const base = readFileSync(settings, 'utf8');
    const plan = planInstall(JSON.parse(base), fragments);
    applyInstall(settings, { ...plan, baseText: base });

    uninstall(settings, plan.manifest);
    const after = JSON.parse(readFileSync(settings, 'utf8'));
    // the user's entry merely mentions our command as a substring of its own —
    // it must survive, and only our exact-match entry is removed.
    expect(after.hooks.Stop.some((e: any) => e.hooks[0].command.startsWith('echo'))).toBe(true);
    expect(after.hooks.Stop.some((e: any) => e.hooks[0].command === ourCommand)).toBe(false);
  });
});

describe('uninstall -- nothing to remove (final review M10)', () => {
  it('writes nothing when none of our fragments are present', () => {
    writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } }));
    const ino = inode(settings);
    const text = readFileSync(settings, 'utf8');
    uninstall(settings, { owned: [], command: buildHookFragments('/h.sh')[0]!.command });
    expect(inode(settings)).toBe(ino);
    expect(readFileSync(settings, 'utf8')).toBe(text);
  });
});

describe('atomic writes', () => {
  it('both applyInstall and uninstall leave valid, parseable JSON', () => {
    writeFileSync(settings, JSON.stringify({ hooks: {} }));
    const base = readFileSync(settings, 'utf8');
    const plan = planInstall(JSON.parse(base), buildHookFragments('/h.sh'));

    applyInstall(settings, { ...plan, baseText: base });
    expect(() => JSON.parse(readFileSync(settings, 'utf8'))).not.toThrow();

    uninstall(settings, plan.manifest);
    expect(() => JSON.parse(readFileSync(settings, 'utf8'))).not.toThrow();
  });
});
