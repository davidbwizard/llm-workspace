/** Usage and context (usage design, 2026-09-18): the shared types and the
 *  pure maths. No node imports -- the renderer may import the types from
 *  here (never from src/main/**). */

/** One rate-limit window. `usedPct` is 0-100 as the provider reports it;
 *  `resetsAt` is epoch MILLISECONDS (both providers report seconds; main
 *  converts once, here at the boundary). */
export interface RateWindow { usedPct: number; resetsAt: number | null }

/** Codex windows carry their own length (10080 = weekly, 300 = 5-hour), so
 *  the renderer labels them from the data, not from a guess about which slot
 *  is which. */
export interface CodexRateWindow extends RateWindow { windowMinutes: number | null }

/** `updatedAt` is epoch ms: when the numbers were recorded (the snapshot
 *  file's mtime for Claude, the token_count event's timestamp for Codex). */
export interface ClaudeUsage { fiveHour?: RateWindow; sevenDay?: RateWindow; updatedAt: number }
export interface CodexUsage { primary?: CodexRateWindow; secondary?: CodexRateWindow; planType?: string; updatedAt: number }

/** usage:get's reply. null means "no current data" for that provider. */
export interface UsagePayload { claude: ClaudeUsage | null; codex: CodexUsage | null }

/** Per-session context on the session payloads. `leftPct` is the percent
 *  left before the estimated compaction point, not before the hard window
 *  end. */
export interface SessionContext { usedTokens: number; windowTokens: number; leftPct: number }

/** The auto-compact point is not documented (the CLI only takes
 *  `--autocompact <auto|100k-1M>`), so it is a setting, "Compacts at", with
 *  this default and range. */
export const COMPACTS_AT_DEFAULT = 83;
export const COMPACTS_AT_MIN = 50;
export const COMPACTS_AT_MAX = 100;

/** A finite number, rounded and clamped to 50-100; anything else is null
 *  (the caller refuses it, or falls back to the default). */
export function clampCompactsAt(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.min(COMPACTS_AT_MAX, Math.max(COMPACTS_AT_MIN, Math.round(raw)));
}

/** Documented context windows (checked 2026-09-18). Anything else is null:
 *  a wrong window would show a confident, wrong "% left". */
const DOCUMENTED_WINDOWS: ReadonlyArray<readonly [string, number]> = [
  ['claude-opus-5', 1_000_000],
  ['claude-sonnet-5', 1_000_000],
  ['claude-fable-5-1', 1_000_000],
  ['claude-haiku-4-5', 200_000],
];

/** Matches the model id itself or a dated/suffixed form of it
 *  (`claude-haiku-4-5-20251001`), never a look-alike (`claude-opus-50`). */
export function contextWindowFor(modelId: string | null | undefined): number | null {
  if (typeof modelId !== 'string' || modelId === '') return null;
  for (const [id, window] of DOCUMENTED_WINDOWS) {
    if (modelId === id || modelId.startsWith(`${id}-`) || modelId.startsWith(`${id}[`)) return window;
  }
  return null;
}

/** max(0, round(100 * (1 - used / (window * compactsAt/100)))). */
export function leftPct(usedTokens: number, windowTokens: number, compactsAt: number): number {
  const compactPoint = windowTokens * compactsAt / 100;
  return Math.max(0, Math.round(100 * (1 - usedTokens / compactPoint)));
}

export function buildContext(usedTokens: number, windowTokens: number | null, compactsAt: number): SessionContext | null {
  if (!Number.isFinite(usedTokens) || usedTokens < 0) return null;
  if (windowTokens === null || !Number.isFinite(windowTokens) || windowTokens <= 0) return null;
  return { usedTokens, windowTokens, leftPct: leftPct(usedTokens, windowTokens, compactsAt) };
}

/** The two places context use can come from for one Claude session. */
export interface ContextSources {
  /** The status line snapshot (src/providers/claude/statusLine.ts):
   *  `usedTokens` is null before the first reply and right after /compact. */
  snapshot: { usedTokens: number | null; windowTokens: number | null; modelId: string | null; mtimeMs: number } | null;
  /** The session's latest main-thread turn.completed with tokens. */
  turn: { usedTokens: number; modelId: string | null; tsMs: number } | null;
}

/** The newer source wins. A snapshot at least as new as the latest turn is
 *  the truth even when it has no usage (just after /compact the old turn's
 *  count is the pre-compact size, which would be wrong); an older snapshot
 *  (the switch was turned off, so it stopped updating) loses to the turn.
 *  The window comes from the snapshot's own size when it has one, else the
 *  documented window for the model. */
export function sessionContext(src: ContextSources, compactsAt: number): SessionContext | null {
  const { snapshot, turn } = src;
  if (snapshot && (!turn || snapshot.mtimeMs >= turn.tsMs)) {
    if (snapshot.usedTokens === null) return null;
    return buildContext(snapshot.usedTokens, snapshot.windowTokens ?? contextWindowFor(snapshot.modelId), compactsAt);
  }
  if (turn) return buildContext(turn.usedTokens, contextWindowFor(turn.modelId), compactsAt);
  return null;
}

/** Claude Code drops a window once its reset time passes; so does this, so
 *  a stale snapshot never shows a used% for a window that has already
 *  reset. */
export function currentWindow<T extends RateWindow>(w: T | null, now: number): T | null {
  if (!w) return null;
  return w.resetsAt !== null && w.resetsAt <= now ? null : w;
}
