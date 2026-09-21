import { useEffect, useRef, useState } from 'react';
import type { OpenSession } from '../../fleet/state.ts';
import type { KillResult, KillRefusalReason } from '../../main/ipc.ts';
import type { LaunchResult } from '../../main/launch.ts';
import { ProviderMark } from './ProviderMark.tsx';
import { ContextChip } from './ContextChip.tsx';
import { StatusIcon } from './StatusIcon.tsx';
import { useFavourites, addFavourite, removeFavourite, MAX_FAVOURITES } from '../state/favourites.ts';
import './OpenSessionCard.css';

// One card per live process (David: "ALL OPEN SESSIONS should show. And
// the source. So I can close if they are actually dead.") -- the model
// correction that replaced grouping by transcript recency. A genuinely
// different thing from a transcript session -- the card IS a process, not
// a conversation -- so this is its own component rather than a second mode
// on SessionCard: OpenSession has no agents/sharesWorktreeWith/stale/
// confidence, and forcing it through SessionCard's prop contract would
// produce fields with no meaning here. What's genuinely shared with
// SessionCard is reused directly: ProviderMark, the design tokens
// (theme.css, loaded globally) and base card classes (.card/.crow/.prov/
// etc., defined in SessionCard.css and relied on here without a second
// import -- see the note at the top of OpenSessionCard.css), and the same
// interaction/accessibility standard: the accessible name carries the
// card's state, not just its project name.

// A mapped type over the closed HostApp union, not an index signature --
// adding a HostApp member without adding it here is a compile error. Small
// deliberate duplicate of SessionCard's own HOST_LABEL: the two components
// are independent files by design (see the file-level comment above), and
// this map is a handful of lines, not worth a shared module for.
type Host = NonNullable<OpenSession['host']>;

const HOST_LABEL: Record<Host, string> = {
  iterm2:'iTerm2', terminal:'Terminal', vscode:'VS Code',
  'claude-app':'Claude', 'codex-app':'Codex', unknown:'unknown host',
};

/** Same "say nothing rather than guess" rule as below: unknown and null both
 *  mean the same thing to the user. Exported so SessionRail's reply guard
 *  (ReplyPopover's `hostLabel` prop) can reuse this exact map/rule instead
 *  of a third copy -- SessionRail already imports this module for
 *  OpenSessionCard itself, so this costs no new import. */
export function hostLabelFor(host: OpenSession['host']): string | null {
  return host && host !== 'unknown' ? HOST_LABEL[host] : null;
}

type Activity = NonNullable<OpenSession['activity']>;

const ACTIVITY_WORD: Record<Activity, string> = {
  working:'working', waiting_permission:'waiting on you',
  waiting_input:'waiting on you', idle:'idle', error:'error',
};

/* A note for whoever tunes the status row next, because it cost a
   measurement to learn: "waiting on you" is 14 characters where every
   other word here is at most 7, and it is the single widest thing the row
   can contain. It alone sets both breakpoints in SessionRail.css -- with
   it, the token count needs a 313px rail to survive; with the mockup's
   shorter "waiting" it needs 269px, against a 420px maximum.

   Left at the full phrasing deliberately. This map also feeds the FLEET
   view's grid cards, which this redesign is scoped not to change, and
   "waiting on you" is the wording that says the thing worth saying. */

/** Formats a running process's elapsed time for a human ("9d", not
 *  "777600s"). Coarsest unit that keeps at least one significant digit --
 *  a card is a glance, not a stopwatch. Duplicate of SessionCard's own
 *  formatProcessAge -- see the file-level comment above. */
function formatProcessAge(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Formats resident memory for a human ("206 MB"). rssBytes is already
 *  normalized to bytes by src/discovery/parse.ts's parseRss. Duplicate of
 *  SessionCard's own formatProcessMemory -- see the file-level comment
 *  above. */
function formatProcessMemory(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1000) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

// One message per KillRefusalReason, so this is a compile error -- not a
// silent `undefined` -- if main ever adds a reason and this map is not
// updated to match. Reasons are internal safety-guard codes (see
// src/main/ipc.ts's doc comment on KillRefusalReason), not something a
// person should have to parse; realistically the only one reachable from
// this button is 'not_discovered' (the process exited between the card
// rendering and the click landing) -- own_process/protected_ancestor/
// invalid_pid would all mean this card was showing a pid main should never
// have handed the renderer in the first place, which is a bug elsewhere,
// not a normal outcome of clicking Close.
const KILL_REFUSAL_TEXT: Record<KillRefusalReason, string> = {
  invalid_pid: 'Could not end this session.',
  own_process: 'Could not end this session.',
  protected_ancestor: 'Could not end this session.',
  not_discovered: 'This session is no longer running.',
  signal_failed: 'Could not end this session.',
};

// How long the post-kill status message ("Signal sent."/"Already gone.")
// stays up before the card quietly returns to normal. Longer than
// src/main/index.ts's 5s discovery interval, so a real fleet:update --
// removing this card because the process is actually gone -- has time to
// arrive and pre-empt this timer under ordinary conditions. If the process
// ignored SIGTERM and is still alive, this timer is what returns the card
// to its normal, re-closeable state rather than leaving it stuck reporting
// a signal that did not, in the end, do anything -- "the card stays and
// the user can decide" (the brief this button was built from).
const KILL_SETTLE_MS = 5_500;

// A live terminal only exists once TerminalView actually mounts, and it
// resizes tmux for real the moment it does (TerminalView's own onResize) --
// same reasoning, and the same numbers, as LaunchBar's own defaults. This
// only has to be a reasonable starting size, not an exact one.
const REATTACH_COLS = 120;
const REATTACH_ROWS = 40;

export function OpenSessionCard({ state, onOpen, onKill, onReveal, onReattach, onResume, unread, compact = false, cmdIndex }: {
  state: OpenSession; onOpen: (pid: number) => void;
  /** Sends session:kill for this card's pid. Always resolves to a
   *  KillResult (src/main/ipc.ts), never throws by contract -- but this
   *  component still handles a rejection (a dead IPC channel, say) rather
   *  than assuming that contract holds forever. */
  onKill: (pid: number) => Promise<KillResult>;
  /** Absent when the host cannot be brought forward -- the label then stays
   *  plain text rather than pretending to be a button. */
  onReveal?: (pid: number) => Promise<unknown>;
  /** Ends this pid and relaunches it under `claude --resume`, as one call
   *  (src/main/launch.ts's reattachSession). Only ever offered for a Claude
   *  session that is not already tmux-backed (`!state.tmux`) -- see the
   *  eligibility check below. */
  onReattach: (pid: number, cols: number, rows: number) => Promise<LaunchResult>;
  /** The recovery path for a 'killed_not_relaunched' result: relaunches
   *  from a session id and cwd alone, no pid. Only ever reachable from the
   *  'stranded' phase below, which is what supplies those two values. */
  onResume: (sessionId: string, cwd: string, cols: number, rows: number) => Promise<LaunchResult>;
  /** True when this session has produced output since the caller last
   *  considered it "seen" -- SessionRail is the only caller that tracks
   *  that today (comparing state.events against a per-pid baseline it
   *  updates on selection), so the grid (FleetView) never passes this and
   *  gets none of the treatment below. Optional, not defaulted to `false`
   *  in a destructure: `undefined` and `false` mean the same thing here
   *  (see `showUnread` below), so there's nothing a default would add. */
  unread?: boolean;
  /** The tidier card David chose as the default (spec §3.6): provider,
   *  project, status, host, the unread dot, a `...` menu, and -- per David,
   *  looking at the real, running window -- up to three lines of the last
   *  message. Which places use it is one setting with four values
   *  (src/renderer/state/settings.ts), read by SessionRail and FleetView,
   *  never here: this component renders what it is told to, so a single
   *  card can still be exercised either way in a test.
   *
   *  Optional and defaulted to false rather than required, so every
   *  existing call site keeps rendering exactly what it rendered before. */
  compact?: boolean;
  /** Cmd+1..9 (App.tsx's own window keydown listener): 1-9 shows a small
   *  muted hotkey number in the corner, titled with the actual chord.
   *  Supplied by the caller (FleetView/SessionRail), keyed to that same
   *  session's RANK in the canonical sessions/openSessions order -- not
   *  wherever this card currently sits on screen, which for SessionRail can
   *  differ from that rank once its own unread promotion reorders the
   *  rendered list (see SessionRail.tsx's own doc comment on why). Decorative
   *  (aria-hidden) like the badge/unread-dot above: the card's own
   *  accessible name already carries everything about it that matters to a
   *  screen reader, and this is a purely visual hint for a sighted,
   *  keyboard-driven user. Omitted (no number shown) for anything past the
   *  ninth card, and for any caller that doesn't track this at all. */
  cmdIndex?: number;
}) {
  const hostLabel = hostLabelFor(state.host) ?? undefined;
  // Age and memory are NEVER gated on match quality here: the card IS the
  // process, so its own age/memory are always attributable, even when no
  // transcript session can be matched to it at all (see src/fleet/state.ts's
  // OpenSession doc comment on ageSeconds/rssBytes).
  const procMeta = [
    state.ageSeconds != null ? formatProcessAge(state.ageSeconds) : null,
    state.rssBytes != null ? formatProcessMemory(state.rssBytes) : null,
  ].filter((part): part is string => part !== null).join(' · ') || null;
  // provider is NOT gated on match quality either -- it comes straight
  // from the process (discovery already knows which pgrep found it), so
  // it is always known and never null (OpenSession.provider: Provider, no
  // union with null). lastProse/events/activity ARE match-gated
  // enrichment -- see openSessions' doc comment in src/fleet/state.ts.
  const providerLabel = state.provider === 'claude' ? 'Claude' : 'Codex';
  const blocked = state.activity === 'waiting_permission' || state.activity === 'waiting_input';
  const activityWord = state.activity ? ACTIVITY_WORD[state.activity] : null;
  // A blocked card already shows its own badge (below) and its own
  // "waiting on you" wording -- a stronger, more specific signal than
  // "something happened" that would otherwise collide with it in the same
  // corner of the card. Unread is the quieter signal for everything else:
  // working/idle/error sessions that produced output while you were
  // looking elsewhere.
  const showUnread = unread === true && !blocked;

  // What the confirmation names -- project, source, age (David: "so I can
  // close if they are actually dead" only works if it's obvious WHICH one
  // is about to end). Built once and reused in both the visible confirm
  // text and every kill-row button's aria-label, so the two never drift
  // apart from each other.
  const ageText = state.ageSeconds != null ? formatProcessAge(state.ageSeconds) : null;
  const killTarget = [
    `the ${providerLabel} session in ${state.project}`,
    hostLabel ? `running in ${hostLabel}` : null,
    ageText ? `open for ${ageText}` : null,
  ].filter((part): part is string => Boolean(part)).join(', ');

  // idle -> confirming -> pending -> settled (auto-reverts to idle) or
  // error (stays until dismissed). No path from idle straight to pending:
  // the confirming step is the whole point -- a misclick on Close alone
  // must never send a signal (see doKill below, which is reachable only
  // from the confirming branch's own button).
  const [phase, setPhase] = useState<'idle' | 'confirming' | 'pending' | 'settled' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  // Guards the setState calls after the `await onKill` below: if this
  // card has already unmounted by the time that resolves (its pid dropped
  // out of a fleet:update that arrived in the meantime), there is nothing
  // left to update.
  //
  // The setup function sets this back to true, not just the useRef
  // initializer -- React 18 StrictMode (src/renderer/main.tsx wraps <App>
  // in it) double-invokes a mount in development: setup, then immediately
  // its own cleanup, then setup again, simulating an unmount+remount. A
  // useRef initializer only ever runs once, on the true first mount, so an
  // effect that ONLY assigns false in its cleanup -- as this one did --
  // comes out of that dance permanently false, even though the component
  // is genuinely mounted: the simulated cleanup sets it false and nothing
  // ever sets it back to true. Every kill on every card was silently
  // dropping its post-signal update as a result -- the card stuck
  // forever on "Ending session...", never reaching "Signal sent.",
  // "Already gone.", or a refusal message, in exactly the dev/StrictMode
  // configuration this app is normally run in. Setting it in the setup
  // function too closes that gap: StrictMode's extra setup call restores
  // true, the same as a genuine remount would leave it.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (phase !== 'settled') return;
    const t = setTimeout(() => setPhase('idle'), KILL_SETTLE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  async function doKill(): Promise<void> {
    setPhase('pending');
    setMessage(null);
    try {
      const result = await onKill(state.pid);
      if (!mountedRef.current) return;
      if (result.status === 'killed') { setMessage('Signal sent.'); setPhase('settled'); }
      else if (result.status === 'already_gone') { setMessage('Already gone.'); setPhase('settled'); }
      else { setMessage(KILL_REFUSAL_TEXT[result.reason]); setPhase('error'); }
    } catch {
      if (!mountedRef.current) return;
      setMessage('Could not reach the app to end this session.');
      setPhase('error');
    }
  }

  // Only ever offered for a Claude session not already tmux-backed
  // (fix-wave item 1): a Codex card gets a plain explanation instead of the
  // button ("say why in the UI rather than hiding it silently or failing
  // obscurely" -- attempting an unprobed Codex resume would be exactly that
  // obscure failure); an already-interactive session gets neither, since
  // there is nothing wrong with it to explain.
  const reattachEligible = state.provider === 'claude' && !state.tmux;

  // Favourite folders: the SAME shared store LaunchBar's own star and
  // MainPane's header star read and write (state/favourites.ts) --
  // favouriting a session's folder from this card's own menu shows up as a
  // chip under the launch bar with no reload. Disabled with no cwd at all
  // (nothing to favourite), or once MAX_FAVOURITES is reached and this
  // folder isn't already one of them (removing at the cap must still work).
  const favourites = useFavourites();
  const isFav = state.cwd !== null && favourites.includes(state.cwd);
  const favouritesAtCap = !isFav && favourites.length >= MAX_FAVOURITES;

  // idle -> confirming -> pending -> (launched, handled by navigating away
  // and resetting) | 'failed' (dismissable, retryable from idle) |
  // 'stranded' (the old process is confirmed gone and the new one did not
  // start -- distinct from 'failed' on purpose, per LaunchResult's own
  // 'killed_not_relaunched': "nothing happened" would be false here).
  // strandedRetry carries exactly what a retry needs (resumeSession takes
  // no pid), captured once, at the moment reattach itself reports it --
  // never re-derived, since the pid this card was showing is already gone.
  const [reattachPhase, setReattachPhase] =
    useState<'idle' | 'confirming' | 'pending' | 'failed' | 'stranded'>('idle');
  const [reattachMessage, setReattachMessage] = useState<string | null>(null);
  const [strandedRetry, setStrandedRetry] = useState<{ sessionId: string; cwd: string } | null>(null);

  // The `...` menu, compact cards only. A plain popover keyed to this one
  // card -- Escape, a click anywhere else, or choosing an item closes it.
  // Every item routes into a flow this card already has rather than a
  // second implementation of it: Close opens the same confirm panel the
  // full card shows, naming the same session in the same words.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    // mousedown, not click: a click listener registered during the very
    // click that opened this menu fires again as that same event finishes
    // bubbling to the window, closing the menu before it is ever seen.
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [menuOpen]);

  // In compact mode the two idle buttons live in the menu instead -- but
  // every NON-idle state (both confirm panels, the status lines, the
  // stranded alert) renders exactly as it does on a full card.
  const showActions = !compact || phase !== 'idle' || reattachPhase !== 'idle';

  async function doReattach(): Promise<void> {
    setReattachPhase('pending');
    setReattachMessage(null);
    try {
      const result = await onReattach(state.pid, REATTACH_COLS, REATTACH_ROWS);
      if (!mountedRef.current) return;
      if (result.status === 'launched') { setReattachPhase('idle'); onOpen(result.pid); return; }
      if (result.status === 'killed_not_relaunched') {
        setStrandedRetry({ sessionId: result.sessionId, cwd: result.cwd });
        setReattachMessage(result.reason);
        setReattachPhase('stranded');
        return;
      }
      setReattachMessage(result.reason);
      setReattachPhase('failed');
    } catch {
      if (!mountedRef.current) return;
      setReattachMessage('Could not reach the app to reattach this session.');
      setReattachPhase('failed');
    }
  }

  // The recovery path: relaunches from the sessionId/cwd a PRIOR reattach
  // already resolved (strandedRetry), never from this card's own pid --
  // that pid is confirmed gone by the time 'stranded' is reachable at all.
  // A retry that itself fails stays in 'stranded' with the retry info
  // intact, rather than degrading to a dead-end 'failed': the whole point
  // of this state is that it must remain recoverable.
  async function doResume(retry: { sessionId: string; cwd: string }): Promise<void> {
    setReattachPhase('pending');
    try {
      const result = await onResume(retry.sessionId, retry.cwd, REATTACH_COLS, REATTACH_ROWS);
      if (!mountedRef.current) return;
      if (result.status === 'launched') { setReattachPhase('idle'); onOpen(result.pid); return; }
      // resumeSession never actually returns 'killed_not_relaunched' (no
      // kill step to have partly succeeded), but LaunchResult's type
      // allows it -- `reason` is present on both non-launched variants, so
      // this handles either uniformly, and staying in 'stranded' either
      // way is the correct, recoverable answer.
      setStrandedRetry(retry);
      setReattachMessage(result.reason);
      setReattachPhase('stranded');
    } catch {
      if (!mountedRef.current) return;
      setStrandedRetry(retry);
      setReattachMessage('Could not reach the app to try again.');
      setReattachPhase('stranded');
    }
  }

  // Same reasoning as SessionCard's label: role="button" replaces this
  // element's content with its accessible name, so every signal rendered
  // below has to be carried in the name too.
  //
  // The pid is NOT here any more (spec §2: no pid on any card). It was
  // never a signal a person acts on -- it was bookkeeping for the close
  // action, which the code performs from `state.pid` regardless. The
  // NESTED controls (Close, Reattach, the compact menu) do keep it, and
  // must: those are otherwise-identical buttons repeated once per card,
  // and two open sessions can share a project name.
  const label = [
    `Open ${state.project} (${providerLabel})`,
    activityWord,
    // Placed right after activityWord, before lastProse -- "there is new
    // output" is a fact about the session's state, the same category as
    // activityWord, not part of what it actually said.
    showUnread ? 'New output since you last looked' : null,
    state.lastProse,
    hostLabel ? `Running in ${hostLabel}` : null,
  ].filter((part): part is string => Boolean(part)).join('. ');

  return (
    <article
      className={`card${compact ? ' compact' : ''} ${blocked ? 'attn' : showUnread ? 'unread' : state.activity === 'working' ? 'live' : ''}${menuOpen ? ' menu-open' : ''}`}
      tabIndex={0}
      role="button"
      aria-label={label}
      onClick={() => onOpen(state.pid)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(state.pid); } }}
    >
      {blocked && <span className="badge" aria-hidden="true">1</span>}
      {showUnread && <span className="unread-dot" aria-hidden="true" />}

      <div className={`crow${blocked ? ' hasbadge' : ''}`}>
        <span className={`prov ${state.provider}`}>
          <ProviderMark provider={state.provider} size={11} />
          {providerLabel}
        </span>
        {(hostLabel || (!compact && procMeta)) && (
          <span className="crow-meta">
            {hostLabel && (onReveal
              ? <button type="button" className="host host-btn"
                  aria-label={`Show this session in ${hostLabel}`}
                  onClick={(e) => { e.stopPropagation(); void onReveal(state.pid); }}>
                  {hostLabel}
                </button>
              : <span className="host">{hostLabel}</span>)}
            {!compact && procMeta && <span className="procmeta">{procMeta}</span>}
          </span>
        )}
      </div>

      <div>
        {/* title: the native hover tooltip for the full name when it's
            truncated -- only actually needed in the rail's narrow width
            (SessionRail.css's `.rail .proj` ellipsis rule), but harmless
            and unused when this card is wide enough to show the whole
            name anyway (the grid), so it's set unconditionally rather
            than threading a second "am I in the rail" prop through just
            for this. */}
        <p className="proj display" title={state.project}>{state.project}</p>
        {!compact && <p className="path">{state.cwd ?? 'no working directory'}</p>}
      </div>

      {/* No fallback text (unlike SessionCard's "No output yet"): a blank
          last-message is honest on an ambiguous or unmatched card, where
          there is no session to say anything came from. The compact card
          keeps this too -- David, looking at the real window, mid-task:
          "compact cards must still show some of the message text, clamped
          to three lines max" -- but through this card's OWN .compact-said
          rule (OpenSessionCard.css), never SessionCard.css's .said. That
          class carries a two-line clamp built for the History card: the
          conversation pane once reused it for exactly this purpose and
          silently cut off every reply past two lines in the real window
          while jsdom -- which computes no layout -- passed every test. A
          card this component doesn't own is not where this clamp lives. */}
      {!compact && state.lastProse && (
        <p className={`said ${blocked ? 'wait' : ''}`}>{state.lastProse}</p>
      )}
      {compact && state.lastProse && (
        <p className={`compact-said ${blocked ? 'wait' : ''}`}>{state.lastProse}</p>
      )}

      <div className="metrics">
        {!compact && state.events != null && <span>{state.events.toLocaleString()}</span>}
        {/* Usage design, Part B: shown on both the full and compact card
            (unlike events/procMeta above, which are full-card only) --
            hidden entirely when there is no count yet (ContextChip's own
            null check). */}
        <ContextChip context={state.context} />
        {/* Status row, variant A: the icon carries the state once the rail
            is too narrow for the word, so both are rendered at every width
            and CSS decides which is SEEN. The word is never removed from
            the DOM and never `display:none` -- SessionRail.css hides it
            with the same clip-path technique ConversationView.css's
            .wholabel uses, which leaves it in the accessibility tree. An
            icon with no name would make the state unreadable to a screen
            reader exactly where it is already unreadable without colour
            vision. .dot stays for the fleet view's grid cards, which this
            redesign is deliberately not changing (see SessionRail.css). */}
        {activityWord && state.activity && (
          <span className={`state ${state.activity}`}>
            <span className="dot" aria-hidden="true" />
            <StatusIcon activity={state.activity} />
            <span className="state-word">{activityWord}</span>
          </span>
        )}
        {/* Un-gated from `compact` (David's addition): a full card gets this
            menu too now, for the one item it doesn't already offer as an
            inline pill button -- favouriting the session's folder. The
            three PRE-EXISTING items stay compact-only below, exactly as
            before: a full card still shows Close/Reattach as its own
            visible pills (.actionsrow), not hidden behind this menu. */}
        <div
          className="cardmenu"
          ref={menuRef}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="cardmenu-btn"
            aria-haspopup="true"
            aria-expanded={menuOpen}
            // Named with the pid for the same reason the Close button is:
            // with several cards in the rail, a bare "Session actions"
            // would put indistinguishable buttons in the accessibility
            // tree, which is the one thing the rail exists to prevent.
            aria-label={`Session actions, pid ${state.pid}`}
            onClick={() => setMenuOpen(o => !o)}
          >
            <span aria-hidden="true">…</span>
          </button>
          {/* Plain buttons, not role="menu"/"menuitem": that ARIA pattern
              promises arrow-key roving focus and Home/End navigation this
              popover doesn't implement (only Escape and click-outside,
              same as the rest of this app's few popovers -- ReplyPopover
              included). A half-implemented menu role is worse for
              assistive tech than a plain button list, so each item keeps
              its ordinary, fully-supported button semantics. */}
          {menuOpen && (
            <div className="cardmenu-list">
              {compact && hostLabel && onReveal && (
                <button type="button" className="cardmenu-item"
                  onClick={() => { setMenuOpen(false); void onReveal(state.pid); }}>
                  Show in {hostLabel}
                </button>
              )}
              {compact && reattachEligible && (
                <button type="button" className="cardmenu-item"
                  onClick={() => { setMenuOpen(false); setReattachPhase('confirming'); }}>
                  Reattach in app
                </button>
              )}
              <button type="button" className="cardmenu-item"
                disabled={state.cwd === null || favouritesAtCap}
                title={favouritesAtCap ? `You can save up to ${MAX_FAVOURITES} favourites.` : undefined}
                onClick={() => {
                  setMenuOpen(false);
                  if (state.cwd === null) return;
                  if (isFav) removeFavourite(state.cwd); else addFavourite(state.cwd);
                }}>
                {isFav ? 'Remove folder from favourites' : 'Add folder to favourites'}
              </button>
              {compact && (
                <button type="button" className="cardmenu-item cardmenu-danger"
                  onClick={() => { setMenuOpen(false); setPhase('confirming'); }}>
                  Close session
                </button>
              )}
            </div>
          )}
        </div>
        {/* Cmd+1..9's own hotkey number (David: to the right of the "…"
            menu button, same row -- not the corner badge this used to be).
            A plain flex sibling of .cardmenu, not absolutely positioned: it
            rides along after .cardmenu's own margin-left:auto rather than
            needing position math of its own, and .metrics never wraps
            (SessionCard.css's own .metrics has no flex-wrap), so it can
            never push the menu button out of place or onto its own line. */}
        {cmdIndex != null && cmdIndex >= 1 && cmdIndex <= 9 && (
          <span className="cmdnum" aria-hidden="true" title={`Cmd+${cmdIndex}`}>{cmdIndex}</span>
        )}
      </div>

      {/* Close and Reattach share one row (.actionsrow) so two idle, single-
          line pill buttons sit side by side instead of stacking into extra
          card height for no reason -- David's own complaint. Each control
          is still a genuine interactive element nested inside this card's
          own role="button" wrapper above, and each row below still stops
          its own click/keydown from bubbling (that's what stops pressing
          Close, Cancel, End session, Reattach, etc. from ALSO firing the
          card's onClick/onKeyDown) -- .actionsrow itself is a plain layout
          box, nothing more. `wide` (added per-row, from this component's
          own phase state) makes a row claim the FULL row's width the
          moment it grows past a single button -- a confirm panel or a
          status line reads properly at the card's own width regardless of
          what its sibling is doing, and flex-wrap is what lets the other
          row drop to its own line to make room, rather than the two being
          squeezed to half-width side by side. */}
      {showActions && <div className="actionsrow">
        {/* This is the first destructive action the app can take, so it gets
            its own row rather than a corner icon: a real, visible button and
            (once pressed) a real, visible confirmation, not something a
            misclick over a crowded corner can trigger by accident.

            Every control here is a genuine interactive element nested inside
            this card's own role="button" wrapper above -- stopping
            propagation on this row's click/keydown is what stops pressing
            Close (or Cancel, or End session) from ALSO firing the card's own
            onClick/onKeyDown and opening the session. */}
        <div
          className={`killrow${phase !== 'idle' ? ' wide' : ''}`}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {phase === 'idle' && !compact && (
            // Deliberately NOT labelled with project/host/age (unlike the
            // confirmation below) -- this card's own role="button" wrapper
            // already carries all of that in ITS accessible name, and giving
            // this button the same text would make any name-based lookup for
            // this card (by a screen reader's rotor, or by a test) match two
            // elements at once. pid alone still disambiguates this button
            // from the identical "Close" button on every other open card.
            <button type="button" className="kill-btn" aria-label={`Close, pid ${state.pid}`}
              onClick={() => setPhase('confirming')}>
              Close
            </button>
          )}

          {phase === 'confirming' && (
            // The group's accessible name IS the confirm text itself
            // (aria-labelledby, not a separate aria-label) -- a screen reader
            // landing on either button below announces that text as the
            // button's description (aria-describedby, same id), so "which
            // session" is heard regardless of whether the AT announces group
            // entry. Button names stay short and literal ("Cancel"/"End
            // session") rather than repeating the whole description into
            // each one.
            <div className="kill-confirm" role="group" aria-labelledby={`killconfirm-${state.pid}`}>
              <p className="kill-confirm-text" id={`killconfirm-${state.pid}`}>End {killTarget}?</p>
              <div className="kill-confirm-actions">
                {/* Cancel takes focus by default, not End session -- so an
                    accidental second Enter/Space after the Close click above
                    lands on the safe choice, not the destructive one. */}
                <button type="button" className="kill-cancel" autoFocus
                  aria-describedby={`killconfirm-${state.pid}`}
                  onClick={() => setPhase('idle')}>
                  Cancel
                </button>
                <button type="button" className="kill-confirm-btn"
                  aria-describedby={`killconfirm-${state.pid}`}
                  onClick={() => { void doKill(); }}>
                  End session
                </button>
              </div>
            </div>
          )}

          {/* aria-live, not a focus move -- the person just clicked "End
              session" and their focus should stay put; the status change is
              announced to them instead. */}
          {phase === 'pending' && (
            <p className="kill-status" aria-live="polite">Ending session…</p>
          )}

          {(phase === 'settled' || phase === 'error') && (
            <p className={`kill-status${phase === 'error' ? ' error' : ''}`} aria-live="polite">
              {message}{' '}
              <button type="button" onClick={() => setPhase('idle')}>Dismiss</button>
            </p>
          )}
        </div>

        {/* The reattach affordance -- the payoff of removing AppleScript
            keystroke injection (spec §5): this, not a typed reply, is how the
            twelve sessions already running in plain iTerm become answerable
            at all. Same nested-interactive-row treatment as killrow above. */}
        {reattachEligible && (
          <div
            className={`reattachrow${reattachPhase !== 'idle' ? ' wide' : ''}`}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {reattachPhase === 'idle' && !compact && (
              <button type="button" className="reattach-btn" aria-label={`Reattach in app, pid ${state.pid}`}
                onClick={() => setReattachPhase('confirming')}>
                Reattach in app
              </button>
            )}

            {reattachPhase === 'confirming' && (
              <div className="reattach-confirm" role="group" aria-labelledby={`reattachconfirm-${state.pid}`}>
                <p className="reattach-confirm-text" id={`reattachconfirm-${state.pid}`}>
                  Reattach {killTarget}? The conversation is kept -- anything in flight is lost, and the
                  current process ends.
                </p>
                <div className="reattach-confirm-actions">
                  <button type="button" className="reattach-cancel" autoFocus
                    aria-describedby={`reattachconfirm-${state.pid}`}
                    onClick={() => setReattachPhase('idle')}>
                    Cancel
                  </button>
                  <button type="button" className="reattach-confirm-btn"
                    aria-describedby={`reattachconfirm-${state.pid}`}
                    onClick={() => { void doReattach(); }}>
                    Reattach
                  </button>
                </div>
              </div>
            )}

            {reattachPhase === 'pending' && (
              <p className="reattach-status" aria-live="polite">Reattaching…</p>
            )}

            {reattachPhase === 'failed' && (
              <p className="reattach-status error" aria-live="polite">
                {reattachMessage}{' '}
                <button type="button" onClick={() => setReattachPhase('idle')}>Dismiss</button>
              </p>
            )}

            {/* role="alert" (not aria-live="polite" like the states above):
                this is the one state where the old process is confirmed gone
                and nothing has replaced it yet -- worth interrupting for,
                not just announcing at the next pause. */}
            {reattachPhase === 'stranded' && strandedRetry && (
              <div className="reattach-stranded" role="alert">
                <p className="reattach-stranded-text">
                  The old session ended, but the new one did not start: {reattachMessage}
                </p>
                <button type="button" className="reattach-retry"
                  onClick={() => { void doResume(strandedRetry); }}>
                  Try again
                </button>
              </div>
            )}
          </div>
        )}
      </div>}

      {/* Say why rather than hiding the whole affordance silently or, worse,
          offering the same button and failing obscurely once pressed --
          Codex resume is unprobed on this machine (spec §3). */}
      {!compact && state.provider === 'codex' && (
        <p className="reattach-na">Reattach in app isn't available for Codex sessions yet.</p>
      )}
    </article>
  );
}
