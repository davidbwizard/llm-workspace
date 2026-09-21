import type { SessionContext } from '../../core/usage.ts';
import { formatContextShort, contextTone } from '../usageFormat.ts';
import './ContextChip.css';

/** The context-window chip (usage design, Part B): "462k · 44% left" on an
 *  open session card (full and compact) and in the conversation header
 *  (MainPane.tsx's panehead) -- the two places `OpenSession.context` and
 *  the resolved conversation-header context land. A shared, self-contained
 *  component (owns its own stylesheet) rather than duplicated markup, since
 *  both call sites render exactly the same thing from exactly the same
 *  shape.
 *
 *  Renders nothing at all when context is null -- hidden, not a dash or a
 *  "--": null means no source has a count for this session yet (switch
 *  off, no snapshot, no match), never that usage is genuinely zero. */
export function ContextChip({ context }: { context: SessionContext | null }) {
  // == null, not === null: several call sites hand this a value read off a
  // loosely-typed test fixture (a real OpenSession/SessionContext is never
  // undefined, only null), and undefined must be just as hidden as null --
  // same convention as OpenSessionCard.tsx's own `!= null` guards.
  if (context == null) return null;
  const tone = contextTone(context.leftPct);
  // Three spans rather than one text node, so the rail's container query
  // can drop the token count on its own as the rail narrows (status row,
  // variant A) -- CSS cannot address half of a text node. The percent is
  // the half that never drops at any width, per David.
  //
  // The separator carries its own spaces and belongs to the COUNT, not the
  // percent: hiding .ctxchip-tok alone would leave the row opening on a
  // stray "·". Read as text this is still exactly "462k · 44% left",
  // character for character -- the split is structural, and every caller
  // that reads the chip's text rather than its elements is untouched.
  return (
    <span className={`ctxchip${tone ? ` ctxchip-${tone}` : ''}`}>
      <span className="ctxchip-tok">{formatContextShort(context.usedTokens)}</span>
      <span className="ctxchip-sep"> · </span>
      <span className="ctxchip-pct">{context.leftPct}% left</span>
    </span>
  );
}
