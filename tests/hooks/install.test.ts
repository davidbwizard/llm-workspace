import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHookFragments, planInstall, applyInstall, uninstall } from '../../src/hooks/install.ts';

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
});
