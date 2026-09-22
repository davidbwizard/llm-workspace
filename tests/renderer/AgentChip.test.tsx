import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { AgentChip } from '../../src/renderer/components/AgentChip.tsx';

/** The sub-agent count in the composer foot. The cards keep the terse
 *  `1/2` because that row has no width to spare; this row does, and a bare
 *  pair of digits there does not say what it counts. */
describe('AgentChip', () => {
  const chip = (liveAgents: number | null, agents: number | null) =>
    render(<AgentChip agents={agents} liveAgents={liveAgents} />).container;

  it('spells the count out rather than printing a bare ratio', () => {
    expect(chip(1, 2).querySelector('.agentchip')!.textContent).toContain('1 of 2 agents');
  });

  // The common bug this exists to not have.
  it('says "agent", singular, when the session spawned exactly one', () => {
    const text = chip(1, 1).querySelector('.agentchip')!.textContent!;
    expect(text).toContain('1 of 1 agent');
    expect(text).not.toContain('1 agents');
  });

  it('agrees with the total, not the running count', () => {
    // "0 of 1 sub-agent" -- the noun follows the 1 it is "of".
    expect(chip(0, 1).querySelector('.agentchip')!.textContent).toContain('0 of 1 agent');
    expect(chip(0, 4).querySelector('.agentchip')!.textContent).toContain('0 of 4 agents');
  });

  describe('when there is nothing to claim', () => {
    it('draws no chip for a session that spawned none', () => {
      expect(chip(0, 0).querySelector('.agentchip')).toBeNull();
    });

    // null is "this pid is not uniquely matched", which is a different
    // claim from "it has none" -- the distinction the fleet layer keeps
    // (see tests/fleet/state.test.ts) has to survive all the way here.
    it('draws no chip when the count is not known', () => {
      expect(chip(null, null).querySelector('.agentchip')).toBeNull();
    });

    it('draws no chip when only half the pair is known', () => {
      expect(chip(null, 2).querySelector('.agentchip')).toBeNull();
      expect(chip(1, null).querySelector('.agentchip')).toBeNull();
    });

    it('never renders a zero-of-zero, whichever way the count is missing', () => {
      for (const c of [chip(0, 0), chip(null, null), chip(null, 0), chip(0, null)]) {
        expect(c.textContent).not.toContain('0 of 0');
      }
    });
  });

  describe('what it says on hover and to a screen reader', () => {
    it('names what the digits count, in both places', () => {
      const el = chip(1, 2).querySelector('.agentchip')!;
      expect(el.getAttribute('title')).toBe('1 of 2 sub-agents still working');
      expect(el.textContent).toContain('1 of 2 sub-agents still working');
    });

    it('pluralises the spoken name too', () => {
      expect(chip(1, 1).querySelector('.agentchip')!.getAttribute('title'))
        .toBe('1 of 1 sub-agent still working');
    });

    // "Still working" is a recency judgement, not a recorded fact: nothing
    // writes an agent.ended event, so the app infers it from when each
    // agent was last seen (src/fleet/state.ts's own note). "Active" would
    // claim more precision than the data has.
    it('says "still working", never "active"', () => {
      const el = chip(1, 2).querySelector('.agentchip')!;
      expect(el.getAttribute('title')).toContain('still working');
      expect(el.getAttribute('title')!.toLowerCase()).not.toContain('active');
      expect(el.textContent!.toLowerCase()).not.toContain('active');
    });

    // The digits are decoration once the full phrase is there; read out
    // together they would say the count twice.
    it('leaves the naming to the phrase, not the digits', () => {
      const el = chip(1, 2).querySelector('.agentchip')!;
      expect(el.querySelector('.agentchip-digits')!.getAttribute('aria-hidden')).toBe('true');
      expect(el.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    });
  });
});
