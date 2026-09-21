import type { Provider } from './types.ts';

/** Shared permission-mode vocabulary. Spec: docs/superpowers/specs/
 *  2026-09-21-mode-switcher-design.md §3 and §7.
 *
 *  Lives in src/core/** (no node import, like prompt.ts) so main and the
 *  renderer share ONE list of modes and ONE menu definition. The menu is
 *  built per provider and the two providers never share a list (§3.2's
 *  final paragraph) -- that is expressed here, once, rather than duplicated
 *  in the chip and in main's validation. */

/** Every mode name this app knows, across both providers. `plan` is the one
 *  name both providers use, and it means the same thing in both (read and
 *  plan, change nothing), so it is deliberately ONE value rather than two --
 *  which is also what lets the chip's colour mapping stay a single table.
 *  Membership is still per provider: see modesFor below. */
export type Mode = 'auto' | 'manual' | 'acceptEdits' | 'plan' | 'default';

/** Claude Code's cycle, IN CYCLE ORDER -- measured 2026-09-21 against a live
 *  throwaway pane, Claude Code v2.1.278 (§3.1, re-measured for this branch):
 *  auto -> manual -> accept edits -> plan -> auto. The order is load-bearing
 *  only as documentation: the press loop re-reads the pane after each press
 *  and never counts on where a press lands. */
export const CLAUDE_MODES = ['auto', 'manual', 'acceptEdits', 'plan'] as const;

/** Codex's toggle -- measured 2026-09-21 against a live pane, codex-cli
 *  0.154.0 (§3.2). Shift+Tab there is a TWO-STATE TOGGLE, not a cycle
 *  through the permission presets: one press is always enough. The presets
 *  live behind `/permissions`, which this app never types. */
export const CODEX_MODES = ['default', 'plan'] as const;

export function modesFor(provider: Provider): readonly Mode[] {
  return provider === 'claude' ? CLAUDE_MODES : CODEX_MODES;
}

/** Whether `v` (untrusted -- it arrives over IPC from the renderer) is a
 *  mode THIS provider has. A Claude mode name sent for a Codex session is
 *  refused here, not quietly coerced: there is no Shift+Tab sequence that
 *  would reach it, so pressing anything at all would be a guess. */
export function isModeFor(provider: Provider, v: unknown): v is Mode {
  return typeof v === 'string' && (modesFor(provider) as readonly string[]).includes(v);
}

/** The four colour slots §2 defines, named as the mockup's own `data-mode`
 *  values so the ported CSS keeps working unchanged: neutral `--muted` for
 *  the ask-first mode, `--accent` for edits, `--ag-purple` for plan, and
 *  `--critical` for the unrestricted one. */
export type ModeTone = 'manual' | 'edits' | 'plan' | 'auto';

/** Codex's `default` takes the SAME neutral tone as Claude's `manual`: both
 *  are the ask-first mode of their provider, which is what the colour is
 *  saying. It is not the unrestricted one -- §3.2 measured that Shift+Tab in
 *  Codex never reaches Full Access at all. */
const TONE: Record<Mode, ModeTone> = {
  auto: 'auto', manual: 'manual', acceptEdits: 'edits', plan: 'plan', default: 'manual',
};

export function toneFor(mode: Mode): ModeTone {
  return TONE[mode];
}

/** One row of the open menu. `permissions` is NOT a mode and never presses a
 *  key: it only opens the session in the terminal, for the person to run
 *  `/permissions` themselves (§3.2, decision B -- the app does not type that
 *  command and does not drive that menu). */
export type ModeMenuItem =
  | { kind: 'mode'; mode: Mode; label: string; description: string }
  | { kind: 'permissions'; label: string; description: string };

/** The menu for one provider. Built per provider, never shared: Claude has
 *  four modes, Codex two plus a link out (§3.2).
 *
 *  Codex's Plan entry states, in words, that the switch also lowers the
 *  model's reasoning effort -- measured 2026-09-21: every switch into Plan
 *  printed "Model changed to gpt-5.6-sol medium for Plan mode" and every
 *  switch back restored xhigh. A person who is never told only notices it in
 *  the bill or in weaker output (§3.2). */
export function modeMenuFor(provider: Provider): ModeMenuItem[] {
  if (provider === 'claude') {
    return [
      { kind: 'mode', mode: 'manual', label: 'Manual', description: 'Ask before each command or edit.' },
      { kind: 'mode', mode: 'acceptEdits', label: 'Accept edits', description: 'File edits go through; commands still ask.' },
      { kind: 'mode', mode: 'plan', label: 'Plan', description: 'Read and plan only. Nothing changes.' },
      { kind: 'mode', mode: 'auto', label: 'Auto', description: 'Everything runs unasked, with no prompt.' },
    ];
  }
  return [
    { kind: 'mode', mode: 'default', label: 'Default', description: 'Ask before acting outside the sandbox.' },
    {
      kind: 'mode',
      mode: 'plan',
      label: 'Plan',
      description: 'Read and plan only. Also lowers the model’s reasoning effort, from xhigh to medium.',
    },
    { kind: 'permissions', label: 'Permissions…', description: 'Opens the terminal. Run /permissions there yourself.' },
  ];
}

/** The chip's own label for a mode -- the menu's label for it, so the closed
 *  chip and the open menu can never disagree about what a mode is called. */
export function labelFor(provider: Provider, mode: Mode): string {
  for (const item of modeMenuFor(provider)) {
    if (item.kind === 'mode' && item.mode === mode) return item.label;
  }
  return mode;
}
