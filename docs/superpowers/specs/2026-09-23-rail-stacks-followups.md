# Follow-ups: rail stacks and categories

Left open when the branch merged, 2026-09-23. The spec and plan are beside
this file. Nothing here blocks the feature; all of it was found, judged and
deliberately deferred rather than missed.

## Decisions parked for David

**`order` grows without a cap.** `groups.ts` appends a key for every folder
ever seen and never drops one, unlike `categories` which caps at 24. Slow
but genuinely unbounded in localStorage. Not fixed because capping it would
silently discard manual row positions -- a user-visible trade, his call. He
has roughly 89 folders, so it is a short string each.

**Cmd+N past slot 9.** The old "Cmd+9 selects the LAST session" special case
was dropped when the chord became slot-based: under slots it would make
Cmd+9 select something other than the card showing "9". Consequence: with
more than nine rows, rows past 9 have no chord at all. Previously Cmd+9
reached the last one.

**A stack is one slot**, so members beyond the first have no direct chord.
Accepted deliberately; the alternative renumbers the whole rail whenever a
stack is opened.

## Known-weak tests, all verified, none load-bearing

- `tests/renderer/StackCard.test.tsx` -- "does not fold or unfold the stack
  when a move button is clicked" **cannot go red**. Nothing outside
  `.stacktoggle` could ever reach `onToggle`, so it guards a hypothetical
  future regression rather than anything shipped.
- `tests/renderer/SessionRail.test.tsx` -- "keeps a junk-cwd card last even
  when it becomes unread" is REAL (the final reviewer ran the mutation and
  it goes red), but its NAME overclaims: the junk tier is observed on the
  first render, and the "even when it becomes unread" half is inert by
  construction. **Rename it**, do not delete it. Three of us reasoned it was
  decorative before anyone actually ran the mutation.
- `tests/renderer/settings.test.ts:117` tests `null` rather than an absent
  key `{}`. `pick` rejects both identically, so no coverage gap.
- Task 4 replaced two `getByRole` queries with
  `container.querySelector('.stacktoggle')`, dropping the implicit
  role/accessible-name check. The name is asserted separately.
- No explicit test for `sessionId === ''` in `resolvePendingCategories`; the
  path is identical to the `null` case.
- `railSections`' section ordering depends on `applyStableOrder`'s stability
  (ES2019-mandated, not a V8 accident) with no test asserting it directly.

## Small cleanups

- `useFleet.ts`'s `orderedSessions` is now dead from `App`'s perspective --
  the hotkeys and the numbers come from `useRailSlots` instead. Left in
  place because its own tests still cover it; removing it is a small,
  separate change.
- `categoryBlockedReason` (`OpenSessionCard.tsx`) checks
  `match === 'ambiguous'` and falls through to the "unknown" wording for
  anything else. Correct today -- `MatchQuality` is exactly
  `'unique' | 'ambiguous' | 'unknown'` and `'unique'` cannot reach that path
  -- but it would mis-word a future fourth member.
- `SettingsModal.tsx`'s `QuickAnswersSwitch` is a fully generic switch
  (`checked`/`disabled`/`labelId`/`onToggle`) now used by three unrelated
  settings. The name has been stale since before this work. A rename to
  `SettingsSwitch` would be correct and trivial.

## Bigger, separate

**The fleet grid has been neglected.** It now receives the rail's ordering so
its numbers agree with the chord, but it does not render stacks at all --
every session in a folder still gets its own card there. Bringing it to
parity is its own job, and David called it out as such.

## What no test can see

`vitest.config.ts` sets no `css` option, so CSS imports are STUBBED and jsdom
computes no layout. Nothing in the suite has ever rendered this feature's
appearance. Five defects reached David by eye that 2918 tests could not see:
the fonts refused in a worktree, the chevron arcing instead of turning, the
deck floating below the card, the gap after a stack, and the missing unread
dot on a folded face.

The plan's own "After the last task: look at it" section carries the full
hand-test list, including the items only a real drag or a real Reduce Motion
setting can confirm.
