import { useEffect, useState } from 'react';
// Type-only, from src/core/**, not src/main/** -- the same rule this file's
// own doc comment below states does not apply to a type-only import from
// core (types.d.ts's own `Answer`/`AnswerResult` imports follow the same
// pattern).
import type { PromptView } from '../../core/prompt.ts';
// Type-only, from src/core/** -- same rule and same reasoning as the
// PromptView import above (src/core/** carries no node import, unlike
// src/main/**, so a type-only pull from it is safe here).
import type { SessionContext } from '../../core/usage.ts';
// Type-only, from src/core/** -- same rule and same reasoning as the two
// imports above.
import type { Mode, ModeTone } from '../../core/mode.ts';
import type { Provider } from '../../core/types.ts';

/** One session's live state for the conversation pane -- mirrors
 *  src/main/sessionLive.ts's SessionLivePayload, minus the pid/sessionId/
 *  version fields this hook already knows (it asked for this exact pid).
 *  Redeclared here rather than imported: src/renderer/** must never import
 *  from src/main/** (ConversationView.tsx's own MAX_REPLY_CHARS carries the
 *  full reasoning -- an import that reaches a VALUE blanks the whole window
 *  at runtime with no error any test would catch, and this file keeps types
 *  declared alongside that same rule rather than special-casing them). */
export type SessionLive = {
  activity: 'working' | 'idle' | 'waiting' | null;
  since: number | null;
  events: number;
  /** The prompt Claude is waiting on (Task 5, quick-answers design §6),
   *  straight off the payload -- PromptCard.tsx renders it, WaitingCard.tsx
   *  is the fallback when this is null. */
  prompt: PromptView | null;
  /** Context window use for the conversation header (usage design, Part A/
   *  B) -- the same { usedTokens, windowTokens, leftPct } shape as
   *  OpenSession.context, or null (no session, or no count yet). This is
   *  the freshest source: main recomputes it on every push, ahead of the
   *  5s fleet sweep that keeps OpenSession.context. */
  context: SessionContext | null;
  /** The permission-mode chip's state (mode-switcher design §2), or null
   *  when there is nothing to draw a chip from at all -- a pid whose
   *  provider main cannot tell. A session this app did not launch DOES get
   *  a state: mode null, blocked 'not_tmux', so the chip can say why it is
   *  disabled. Redeclared here for the same reason as the
   *  rest of this type: src/renderer/** must never import from src/main/**. */
  mode: SessionMode | null;
};

export type SessionMode = {
  provider: Provider;
  /** null means there is no mode to name -- no pane, a dead session, or a
   *  screen the reader could not identify. The chip never NAMES a mode it
   *  does not know (§5); it shows a disabled control carrying `blocked` as
   *  its reason instead. */
  mode: Mode | null;
  /** Why the chip cannot be clicked right now, or null when it can. */
  blocked: 'not_tmux' | 'session_gone' | 'prompt_open' | 'unreadable' | null;
};

/** Re-exported so the chip can take its colour from the shared table
 *  without a second import path for it. */
export type { Mode, ModeTone };

/** Subscribes the open conversation pane to one pid's live push (Task 6:
 *  src/main/sessionLive.ts's watchSessionFor/notifySessionChanged), which
 *  lands within ~250ms of a real change instead of waiting on the 5s fleet
 *  sweep. Returns null until the first payload for THIS pid arrives --
 *  including right after `pid` changes, when whatever the previous pid last
 *  reported would otherwise read as the new session's own state.
 *
 *  Keyed on `pid`: main's own watch is a single module-level slot, not one
 *  per pid (see watchState's own doc comment in sessionLive.ts), so
 *  switching sessions must tear the old watch down before starting the new
 *  one rather than layering a second one on top. `pid: null` still calls
 *  watchSession(null) -- the same explicit "stop watching" main documents --
 *  covering both "no session is open" on mount and the ordinary cleanup on
 *  unmount, so no watch is ever left running for a pane that is no longer
 *  open.
 *
 *  Guards on the bridge methods actually being present, not just on
 *  `window.fleet` itself -- the same defensive shape ConversationView.tsx's
 *  own LinkedImage/UserText already use for window.fleet.image/attachments.
 *  A missing preload and a caller that only stubs part of the bridge (every
 *  existing ConversationView test that predates this task, none of which
 *  mock watchSession/onSessionLive) both mean "cannot reach main for this",
 *  and both must leave the pane on its 5s-sweep backstop rather than throw. */
export function useSessionLive(pid: number | null): SessionLive | null {
  const [state, setState] = useState<SessionLive | null>(null);

  // Reset on every pid change, not just on the first mount: whatever the
  // PREVIOUS pid last reported must not keep reading as this session's
  // state while the new watch's first payload is still in flight. Done
  // here, in the render body -- React's own "adjust state when a prop
  // changes" idiom -- rather than in the effect below: an effect only runs
  // AFTER this render has already committed and painted, so for one frame
  // the previous pid's state would still be on screen. Comparing against a
  // tracked `prevPid` and calling setState synchronously during render
  // makes React discard that stale render before it ever paints (and the
  // ternary below covers the one render where the two setState calls have
  // been made but `state`/`prevPid` themselves have not yet updated).
  const [prevPid, setPrevPid] = useState(pid);
  if (pid !== prevPid) {
    setPrevPid(pid);
    setState(null);
  }
  const current = pid !== prevPid ? null : state;

  useEffect(() => {
    const api = window.fleet;
    if (!api?.watchSession || !api.onSessionLive) return;

    // Two-argument .then, not a bare .then/chained .catch -- same reasoning
    // useFleet.ts's own mount fetch gives: ipcRenderer.invoke rejects,
    // rather than hanging, when main has no handler for the channel, and a
    // rejection with no reject handler here becomes an unhandled promise
    // rejection instead of a logged one.
    void api.watchSession(pid).then(
      () => {},
      err => console.error('session:watch failed:', err),
    );

    const unsub = api.onSessionLive(payload => {
      // A push can arrive after `pid` has already changed again -- this
      // effect's own teardown below is not synchronous with main actually
      // releasing the old watch -- so a payload for the pid THIS instance
      // was built for, not whatever pid is current by the time it lands, is
      // dropped rather than shown as if it belonged to the session now on
      // screen.
      if (payload.pid !== pid) return;
      setState({
        activity: payload.activity, since: payload.since, events: payload.events,
        prompt: payload.prompt ?? null, context: payload.context ?? null,
        mode: payload.mode ?? null,
      });
    });

    return () => {
      unsub();
      void api.watchSession(null).then(
        () => {},
        err => console.error('session:watch failed:', err),
      );
    };
  }, [pid]);

  return current;
}
