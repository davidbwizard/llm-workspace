import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionCard } from '../../src/renderer/components/SessionCard.tsx';
import type { SessionState } from '../../src/fleet/state.ts';

const base: SessionState = {
  sessionId:'s1', runId:'r1', provider:'claude', cwd:'/Users/me/trellome',
  project:'trellome', lifecycle:'active', activity:'working', stale:false,
  confidence:'guess', source:'transcript', lastProse:'Reused the JWT helper.',
  lastActivityAt:'2026-09-10T12:00:00Z', agents:44, liveAgents:2, events:9129,
  blocker:null, match:'unique', candidates:[123], host:'iterm2', sharesWorktreeWith:[],
};

describe('SessionCard', () => {
  it('shows the project, the last thing said, and the counts', () => {
    render(<SessionCard state={base} onOpen={() => {}} />);
    expect(screen.getByText('trellome')).toBeTruthy();
    expect(screen.getByText(/Reused the JWT helper/)).toBeTruthy();
    expect(screen.getByText(/2\/44/)).toBeTruthy();
  });

  it('is operable by keyboard and mouse', () => {
    const onOpen = vi.fn();
    render(<SessionCard state={base} onOpen={onOpen} />);
    const card = screen.getByRole('button', { name: /trellome/i });
    fireEvent.click(card);
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('states a blocker in words, not by colour alone', () => {
    render(<SessionCard onOpen={() => {}} state={{ ...base, activity:'waiting_permission',
      blocker:{ sessionId:'s1', kind:'PermissionRequest', toolUseId:'t1', promptId:null,
                occurredAt:'2026-09-10T11:58:00Z', text:'Permission: Bash npm run dist:mac' } }} />);
    expect(screen.getByText(/Permission: Bash npm run dist:mac/)).toBeTruthy();
    expect(screen.getByText(/waiting/i)).toBeTruthy();
  });

  it('marks a disconnected session stale rather than dropping its activity', () => {
    render(<SessionCard onOpen={() => {}} state={{ ...base, lifecycle:'disconnected', stale:true }} />);
    expect(screen.getByText(/stale/i)).toBeTruthy();
  });

  it('warns when another session shares the working directory', () => {
    render(<SessionCard onOpen={() => {}} state={{ ...base, sharesWorktreeWith:['s2'] }} />);
    expect(screen.getByText(/shares this directory/i)).toBeTruthy();
  });

  it('renders provider text as text, never as markup', () => {
    render(<SessionCard onOpen={() => {}} state={{ ...base, lastProse:'<img src=x onerror=alert(1)>' }} />);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeTruthy();
  });

  // role="button" replaces this element's content with its accessible name
  // for assistive tech -- so a blocked card has to say it is blocked in the
  // name itself, not only in text a screen reader will never reach. Built
  // from the same `state.blocker.text` the visible ".said" paragraph shows,
  // so the two cannot drift apart.
  it('names the blocked state in the accessible name, not just the project', () => {
    render(<SessionCard onOpen={() => {}} state={{ ...base, activity:'waiting_permission',
      blocker:{ sessionId:'s1', kind:'PermissionRequest', toolUseId:'t1', promptId:null,
                occurredAt:'2026-09-10T11:58:00Z', text:'Permission: Bash npm run dist:mac' } }} />);
    const card = screen.getByRole('button', { name: /trellome/i });
    const label = card.getAttribute('aria-label') ?? '';
    expect(label).toMatch(/waiting on you/i);
    expect(label).toMatch(/Permission: Bash npm run dist:mac/);
  });

  // The badge is a bare "1" with no context; once the accessible name
  // carries the blocked state, the badge would only be duplicated,
  // unlabelled noise for a screen reader.
  it('hides the badge count from assistive tech, since the label already carries it', () => {
    const { container } = render(<SessionCard onOpen={() => {}} state={{ ...base, activity:'waiting_permission',
      blocker:{ sessionId:'s1', kind:'PermissionRequest', toolUseId:'t1', promptId:null,
                occurredAt:'2026-09-10T11:58:00Z', text:'Permission: Bash npm run dist:mac' } }} />);
    expect(container.querySelector('.badge')?.getAttribute('aria-hidden')).toBe('true');
  });

  // The project name is the most prominent type on the card; without the
  // "display" class it renders Fraunces at its default axes instead of the
  // soft, wonky SOFT/WONK cut the design was chosen for (theme.css's
  // h1, h2, h3, .display rule, pinned by tests/renderer/theme.test.ts).
  it('renders the project name in the display type cut', () => {
    const { container } = render(<SessionCard state={base} onOpen={() => {}} />);
    expect(container.querySelector('.proj')?.classList.contains('display')).toBe(true);
  });

  // HOST_LABEL is now typed Record<Host, string>, a mapped type over the
  // same closed union `state.host` draws from -- TS itself can prove this
  // lookup never misses. The fallback still matters at runtime: nothing
  // stops a value that never went through classifyHost() (a stale
  // persisted state, an `as any`, a future bug elsewhere) from reaching
  // this lookup, so the test bypasses the type system the same way to
  // prove the belt-and-braces fallback still holds.
  it('falls back to a labelled placeholder instead of a blank field for an unrecognised host', () => {
    render(<SessionCard onOpen={() => {}} state={{ ...base, host: 'ssh-remote' as any }} />);
    expect(screen.getByText('unknown host')).toBeTruthy();
  });

  // Asserted on the accessible name, not on page text: the visible ".state"
  // span reads from the same `stateWord` value, so a regression that
  // dropped the stale marker from the label alone -- leaving the visible
  // span correct -- would still pass a getByText(/stale/i) assertion. Only
  // a screen reader user would lose it.
  it('names the stale condition in the accessible name, not just the visible state word', () => {
    render(<SessionCard onOpen={() => {}} state={{ ...base, lifecycle:'disconnected', stale:true }} />);
    const card = screen.getByRole('button', { name: /trellome/i });
    expect(card.getAttribute('aria-label') ?? '').toMatch(/stale/i);
  });

  // Same reasoning as the stale case above, for the shared-directory
  // warning: asserted on the accessible name so a label regression can't
  // hide behind the visible ".shared" paragraph still being correct.
  it('names the shared-directory warning in the accessible name, not just the visible paragraph', () => {
    render(<SessionCard onOpen={() => {}} state={{ ...base, sharesWorktreeWith:['s2'] }} />);
    const card = screen.getByRole('button', { name: /trellome/i });
    expect(card.getAttribute('aria-label') ?? '').toMatch(/shares this directory/i);
  });

  // This app exists because David could not tell what his agents were
  // doing -- the card's job is surfacing the last meaningful thing an
  // agent said. The old label was `[Open project, stateWord, blocker?.text,
  // sharedText]`: for every non-blocked session (the common case) nothing
  // from lastProse reached assistive tech at all. Asserted on the
  // accessible name, not page text, for the same reason the stale and
  // shared-directory tests above are: the visible ".said" paragraph could
  // stay correct while the label silently dropped it.
  it('names the last thing said in the accessible name, not just the state word', () => {
    render(<SessionCard onOpen={() => {}} state={base} />);
    const card = screen.getByRole('button', { name: /trellome/i });
    expect(card.getAttribute('aria-label') ?? '').toMatch(/Reused the JWT helper/);
  });

  // SessionState carries match/candidates/sharesWorktreeWith precisely
  // because two sessions -- from different providers -- can share a
  // project name. Without the provider in the label, a Claude and a Codex
  // session both named "trellome", both working, with no blocker,
  // announce identically. Scoped to each render's own .container (rather
  // than the global `screen`) since two cards are mounted in this test.
  it('includes the provider in the accessible name so two same-named sessions do not announce identically', () => {
    const claude = render(<SessionCard onOpen={() => {}} state={{ ...base, provider: 'claude' }} />);
    const codex = render(<SessionCard onOpen={() => {}} state={{ ...base, provider: 'codex' }} />);
    const claudeLabel = claude.container.querySelector('[role="button"]')?.getAttribute('aria-label');
    const codexLabel = codex.container.querySelector('[role="button"]')?.getAttribute('aria-label');
    expect(claudeLabel).not.toBe(codexLabel);
  });

  // Enter and click were already covered; Space is the one that silently
  // scrolls the page instead of opening the card if preventDefault is ever
  // dropped from that branch.
  it('is operable by the space key too', () => {
    const onOpen = vi.fn();
    render(<SessionCard state={base} onOpen={onOpen} />);
    const card = screen.getByRole('button', { name: /trellome/i });
    fireEvent.keyDown(card, { key: ' ' });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
