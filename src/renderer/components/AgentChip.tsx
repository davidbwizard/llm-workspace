import './AgentChip.css';

/** The sub-agent count, in the composer foot beside the mode chip.
 *  Approved design: "Naming the sub-agent count", 2026-09-22.
 *
 *  The open-session cards print the same pair as a terse `1/2` because
 *  that row has no width to spare -- measured, it has overflowed its card
 *  three times. This row does have room, and David's complaint was exactly
 *  that `1/2` there says nothing about WHAT is being counted. So the cards
 *  keep the ratio and this spells it out; same numbers, same source, two
 *  budgets.
 *
 *  Renders NOTHING in two different cases that must not be conflated:
 *  `agents === 0` is "this session spawned none", and `null` is "this pid
 *  is not uniquely matched, so nothing may be attributed to it". Both draw
 *  no chip -- but only one of them would be a lie as "0 of 0 agents", so
 *  neither is allowed to become the other on the way here (the same
 *  three-way the fleet layer keeps; see OpenSession's own note). */
export function AgentChip({ agents, liveAgents }: {
  /** Sub-agents this session has ever spawned, or null when unknown. */
  agents: number | null;
  /** How many of those were last seen recently enough to call running, or
   *  null when unknown. Both halves have to be known for the pair to mean
   *  anything, so either being null draws no chip. */
  liveAgents: number | null;
}) {
  if (agents == null || liveAgents == null || agents === 0) return null;

  // The noun follows the TOTAL, the number it is "of" -- "0 of 1 agent",
  // not "0 of 1 agents". Pluralising off the running count is the usual
  // way this goes wrong.
  const noun = agents === 1 ? 'agent' : 'agents';
  // "Still working", never "active": nothing in this app writes an
  // agent.ended event, so liveAgents is a recency judgement over each
  // agent's own last event, not a recorded fact (src/fleet/state.ts's note
  // on the heuristic). The wording must not claim more precision than the
  // number has.
  const name = `${liveAgents} of ${agents} sub-${noun} still working`;

  return (
    <span className="agentchip" title={name}>
      {/* The app icon's own language -- a centre with satellites -- which
          is why David picked it over a branch or a tree: it says "this
          session and the things it is running" in a shape the app already
          uses of itself. */}
      <svg className="agentchip-ic" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.2" opacity=".5" />
        <circle cx="8" cy="8" r="2" fill="currentColor" />
        <circle cx="13.2" cy="8" r="1.7" fill="currentColor" />
        <circle cx="4.4" cy="3.6" r="1.4" fill="currentColor" opacity=".55" />
      </svg>
      {/* Decoration once the phrase below exists: read out together they
          would announce the same count twice. */}
      {/* Real spaces, not a flex gap: a gap looks the same but leaves the
          text as "1of2agents" to anything reading the DOM -- a copy-paste,
          a test, a future caller. */}
      <span className="agentchip-digits" aria-hidden="true">
        <b>{liveAgents}</b>{' '}<span className="agentchip-of">of</span>{' '}
        <b>{agents}</b>{' '}<span className="agentchip-of">{noun}</span>
      </span>
      {/* The accessible name, and the same words the title carries -- so
          it is not hover-only. Visually hidden, never display:none, which
          would take it out of the accessibility tree as well as the page. */}
      <span className="agentchip-name">{name}</span>
    </span>
  );
}
