import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { OpenSessionCard } from '../../src/renderer/components/OpenSessionCard.tsx';
import type { OpenSession } from '../../src/fleet/state.ts';
import type { KillResult } from '../../src/main/ipc.ts';
import type { LaunchResult } from '../../src/main/launch.ts';
import { getFavourites, addFavourite, reloadFavourites } from '../../src/renderer/state/favourites.ts';
import {
  reloadGroups, categoryNames, categoryOfSession, assignCategory, pruneAssignments,
} from '../../src/renderer/state/groups.ts';

// favourites.ts is a module-scoped singleton store (settings.ts's own
// shape) -- clearing localStorage alone leaves the in-memory value
// untouched, so every test also reloads it.
beforeEach(() => {
  localStorage.clear();
  reloadFavourites();
});

// The model correction: one card per live process, "ALL OPEN SESSIONS
// should show. And the source." Unmatched by default -- most tests below
// override only what they're testing, so the base fixture pins the common
// outcome on a real, shared-cwd workspace: no unique transcript match, but
// provider (and pid/host/cwd/age/memory) still fully known, since those
// come from the process itself, never from a match.
const base: OpenSession = {
  pid: 4242, provider: 'claude', host: 'iterm2', cwd: '/Users/me/trellome', project: 'trellome',
  ageSeconds: 9 * 86_400, rssBytes: 206 * 1024 * 1024, match: 'unknown',
  sessionId: null, lastProse: null, events: null, agents: null, liveAgents: null,
  activity: null, tmux: true, junk: false, context: null, name: null,
};

// Every test below that isn't specifically about the kill flow needs SOME
// onKill (it's a required prop -- FleetView always has a real
// window.fleet.killSession by the time it renders a card), but must never
// have it actually called: a vi.fn() left uncalled is exactly what proves
// that, and asserting it wasn't called is cheap insurance against a future
// regression that fires it too early.
function neverKill() {
  return vi.fn<(pid: number) => Promise<KillResult>>();
}

// Same reasoning as neverKill above, for the two reattach channels: `base`
// fixture below is tmux:true (already interactive, ineligible), so none of
// the tests that aren't specifically about reattaching ever have a reason
// to call either -- these exist purely to satisfy the required-prop
// contract without silently permitting an early call.
function neverReattach() {
  return vi.fn<(pid: number, cols: number, rows: number) => Promise<LaunchResult>>();
}
function neverResume() {
  return vi.fn<(sessionId: string, cwd: string, cols: number, rows: number) => Promise<LaunchResult>>();
}

describe('OpenSessionCard', () => {
  it('shows provider, project, cwd, host, age and memory even with no transcript match at all', () => {
    render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={base} />);
    expect(screen.getByText('trellome')).toBeTruthy();
    expect(screen.getByText('/Users/me/trellome')).toBeTruthy();
    expect(screen.getByText('Claude')).toBeTruthy();
    expect(screen.getByText('iTerm2')).toBeTruthy();
    expect(screen.getByText(/9d/)).toBeTruthy();
    expect(screen.getByText(/206 MB/)).toBeTruthy();
    // Gone from every card (spec §2). It was bookkeeping, and the app
    // already knows which process a card is without printing it.
    expect(screen.queryByText(/pid 4242/)).toBeNull();
  });

  it('is operable by keyboard and mouse, passing pid to onOpen every time', () => {
    const onOpen = vi.fn();
    render(<OpenSessionCard onReattach={neverReattach()} onResume={neverResume()} state={base} onOpen={onOpen} onKill={neverKill()} />);
    const card = screen.getByRole('button', { name: /trellome/i });
    fireEvent.click(card);
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    // Checked call by call, not with toHaveBeenCalledWith (an "any call
    // matches" check) -- that would stay green even if only the click
    // handler, say, passed the wrong pid while the two keyboard paths were
    // still correct.
    expect(onOpen.mock.calls).toEqual([[4242], [4242], [4242]]);
  });

  // provider is not enrichment: it comes straight from the process
  // (LiveProcess.provider, set at discovery time -- see src/fleet/state.ts's
  // openSessions doc comment), so it shows even when this card has no
  // transcript match at all -- unlike lastProse/activity below, which
  // genuinely are match-gated.
  it('shows the provider badge even when the process could not be matched to any session', () => {
    render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={base} />);
    expect(screen.getByText('Claude')).toBeTruthy();
  });

  it('shows a Codex provider badge for a codex process', () => {
    const { container } = render(
      <OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={{ ...base, provider: 'codex' }} />,
    );
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(container.querySelector('.prov.codex')).not.toBeNull();
  });

  // Cmd+1..9: a small muted hotkey number on the first nine open-session
  // cards. cmdIndex is supplied by the caller (FleetView/SessionRail) --
  // this component just renders whatever it's given, 1..9, decorative
  // (aria-hidden -- the card's own accessible name already carries its
  // identity) with a native title tooltip spelling out the actual chord.
  describe('the Cmd+N hotkey number', () => {
    it('shows the given number, aria-hidden, titled with the actual chord', () => {
      const { container } = render(
        <OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={base} cmdIndex={3} />,
      );
      const num = container.querySelector('.cmdnum');
      expect(num?.textContent).toBe('3');
      expect(num?.getAttribute('title')).toBe('Cmd+3');
      expect(num?.getAttribute('aria-hidden')).toBe('true');
    });

    it('shows nothing when no cmdIndex is given', () => {
      const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={base} />);
      expect(container.querySelector('.cmdnum')).toBeNull();
    });

    it('shows the same number on a compact card', () => {
      const { container } = render(
        <OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={base} compact cmdIndex={9} />,
      );
      expect(container.querySelector('.cmdnum')?.textContent).toBe('9');
    });

    // David, looking at the real, running window: move it to the right of
    // the "…" menu button, same row, bottom-right corner -- not the
    // top-left corner badge this used to be.
    it('sits in the metrics row, immediately after the "…" menu button', () => {
      const { container } = render(
        <OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={base} cmdIndex={3} />,
      );
      const metrics = container.querySelector('.metrics')!;
      const num = metrics.querySelector('.cmdnum');
      const menu = metrics.querySelector('.cardmenu');
      expect(num).not.toBeNull();
      expect(menu).not.toBeNull();
      // nodeType 4 (DOCUMENT_POSITION_FOLLOWING) -- num comes after menu.
      expect(menu!.compareDocumentPosition(num!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  it('renders no last-message text when unmatched -- blank is honest, not a placeholder', () => {
    const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={base} />);
    expect(container.querySelector('.said')).toBeNull();
  });

  it('renders no working/waiting state word when unmatched', () => {
    const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={base} />);
    expect(container.querySelector('.state')).toBeNull();
    expect(container.querySelector('.badge')).toBeNull();
  });

  it('renders no host text when host is classifyHost\'s own "unknown"', () => {
    const { container } = render(
      <OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={{ ...base, host: 'unknown' }} />,
    );
    expect(container.querySelector('.host')).toBeNull();
  });

  // Usage design, Part B: the context chip (ContextChip.tsx). `base` above
  // is context: null, so every test that doesn't override it already
  // covers "hidden when null" -- this covers the shown case, on both the
  // full and the compact card (unlike lastProse/events, this is NOT
  // full-card only).
  describe('the context chip', () => {
    const withContext: OpenSession = {
      ...base, context: { usedTokens: 462_400, windowTokens: 1_000_000, leftPct: 44 },
    };

    it('is absent from the full card when context is null', () => {
      const { container } = render(
        <OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={base} />,
      );
      expect(container.querySelector('.ctxchip')).toBeNull();
    });

    // textContent, not getByText -- the chip is three spans now so the
    // rail can drop the token count alone. Rendered text is unchanged.
    it('shows the short form and percent left on the full card', () => {
      const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={withContext} />);
      expect(container.querySelector('.ctxchip')!.textContent).toBe('462k · 44% left');
    });

    it('also shows on the compact card', () => {
      const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} compact state={withContext} />);
      expect(container.querySelector('.ctxchip')!.textContent).toBe('462k · 44% left');
    });
  });

  // Enrichment (lastProse/events/activity) appears only on a unique
  // transcript match -- src/fleet/state.ts's openSessions doc comment.
  // provider is deliberately NOT part of this fixture's point: it is set
  // on `base` too, unconditionally -- see the tests above.
  describe('enrichment on a unique match', () => {
    const enriched: OpenSession = {
      ...base, match: 'unique', sessionId: 's1',
      lastProse: 'Reused the JWT helper.', events: 9129, activity: 'working',
    };

    it('shows last prose, events and the working state', () => {
      render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={enriched} />);
      expect(screen.getByText(/Reused the JWT helper/)).toBeTruthy();
      expect(screen.getByText('9,129')).toBeTruthy();
      expect(screen.getByText('working')).toBeTruthy();
    });

    // The visible row says "waiting" (it is the widest word in the row and
    // was setting both of the rail's breakpoints on its own); the card's
    // accessible NAME still says "waiting on you". Both halves asserted,
    // because dropping either would be the regression.
    it('shows the blocked badge and wording when the matched session is waiting on the user', () => {
      const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()}
        onReattach={neverReattach()} onResume={neverResume()} state={{ ...enriched, activity: 'waiting_permission' }} />);
      expect(container.querySelector('.badge')).not.toBeNull();
      expect(container.querySelector('.state-word')!.textContent).toBe('waiting');
      expect(container.querySelector('.card')!.getAttribute('aria-label')).toContain('waiting on you');
    });

    it('includes project, provider, activity and last prose in the accessible name, and no pid', () => {
      render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={enriched} />);
      const card = screen.getByRole('button', { name: /trellome/i });
      const label = card.getAttribute('aria-label') ?? '';
      expect(label).toMatch(/Claude/);
      expect(label).toMatch(/working/);
      expect(label).toMatch(/Reused the JWT helper/);
      expect(label).not.toMatch(/pid/i);
    });

    // The nested controls keep it, and must: with two cards open, "Close"
    // and "Close" are indistinguishable in a screen reader's rotor or a
    // test's own lookup, and two sessions can share a project name. This
    // is a different string from the card's own name, on a different
    // element, and it is the only thing telling those buttons apart.
    it('keeps the pid on the nested controls, which have nothing else to tell them apart', () => {
      render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={enriched} />);
      expect(screen.getByRole('button', { name: 'Close, pid 4242' })).toBeTruthy();
    });
  });

  // The rail's own bug report: a long project name rendered past the
  // card's border in the rail's narrow width. The truncation itself is
  // SessionRail.css's job (a rail-scoped CSS rule, asserted against
  // directly in tests/renderer/SessionRail.css.test.ts, since jsdom does
  // not compute real layout) -- this only proves the card gives the
  // browser a native tooltip to fall back on once that truncation hides
  // part of the name, regardless of which container (rail or grid) ends
  // up rendering it.
  it('sets the full project name as a native title, so a truncated name is still readable on hover', () => {
    const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={base} />);
    expect(container.querySelector('.proj')!.getAttribute('title')).toBe('trellome');
  });

  // The session's own name (session-names design). OpenSession.name is
  // already filtered to names a PERSON chose -- fleet/state.ts drops a
  // derived one -- so this component's whole job is: show it when it is
  // there, show the folder when it is not.
  describe('a session the person named', () => {
    const named = { ...base, name: 'FLEET STUFF' };

    it('shows the chosen name as the card title, in place of the folder name', () => {
      render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={named} />);
      expect(screen.getByText('FLEET STUFF')).toBeTruthy();
      expect(screen.queryByText('trellome')).toBeNull();
    });

    it('still shows the working directory, so the folder is never actually lost', () => {
      render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={named} />);
      expect(screen.getByText('/Users/me/trellome')).toBeTruthy();
    });

    // role="button" replaces the element's content with its accessible
    // name, so a name only rendered visually would be invisible to a
    // screen reader -- the standard this card already holds itself to.
    it('carries the chosen name in the accessible name too, not only on screen', () => {
      render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={named} />);
      expect(screen.getByRole('button', { name: /FLEET STUFF/ })).toBeTruthy();
    });

    it('falls back to the folder name when there is no chosen name', () => {
      render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={base} />);
      expect(screen.getByText('trellome')).toBeTruthy();
    });

    // Same hover fallback as the project name above, for the same reason:
    // whichever label the card ends up showing is the one a truncation
    // would cut off.
    it('puts the chosen name in the native title, so a truncated one is readable on hover', () => {
      const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={named} />);
      expect(container.querySelector('.proj')!.getAttribute('title')).toBe('FLEET STUFF');
    });

    // The compact (rail) card drops the cwd line, so the name is all it has
    // -- which is exactly the case where showing the chosen name matters
    // most, and exactly the width the rail's truncation rule covers.
    it('shows the chosen name on the compact rail card as well', () => {
      render(<OpenSessionCard compact onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={named} />);
      expect(screen.getByText('FLEET STUFF')).toBeTruthy();
    });

    // The metrics row has overflowed three times this week. Nothing new is
    // added to it here, and this pins that: the name reuses the existing
    // .proj title element rather than becoming another chip to budget
    // width for.
    it('adds no new element to the card, so the metrics row is unchanged', () => {
      const plain = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={base} />);
      const before = plain.container.querySelector('.metrics')!.childElementCount;
      plain.unmount();
      const withName = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={named} />);
      expect(withName.container.querySelector('.metrics')!.childElementCount).toBe(before);
    });
  });

  // The unread indicator (SessionRail computes `unread`; this component
  // only renders it). Undefined -- the grid's own usage, FleetView.tsx,
  // never passes this prop -- must render exactly like `false`, not throw
  // and not show the dot: a card that has never opted into this tracking
  // must not appear to have "new output" it never actually measured.
  describe('the unread indicator (unread prop)', () => {
    const working: OpenSession = { ...base, match: 'unique', sessionId: 's1', activity: 'working', events: 12 };

    it('shows nothing when unread is omitted', () => {
      const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={working} />);
      expect(container.querySelector('.unread-dot')).toBeNull();
    });

    it('shows the dot, and names it in the accessible name, when unread is true', () => {
      const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={working} unread />);
      expect(container.querySelector('.unread-dot')).not.toBeNull();
      expect(screen.getByRole('button', { name: /trellome/i }).getAttribute('aria-label')).toMatch(/new output/i);
    });

    it('shows nothing when unread is explicitly false', () => {
      const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={working} unread={false} />);
      expect(container.querySelector('.unread-dot')).toBeNull();
    });

    // The two indicators must stay visually and semantically distinct
    // (the brief's own words) -- a blocked card already says "waiting on
    // you" via its badge, so unread=true must never also draw its dot or
    // add a second, redundant announcement on top of that.
    it('never shows the unread dot on a card that is already blocked, even if unread is true', () => {
      const blockedState: OpenSession = { ...working, activity: 'waiting_permission' };
      const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={blockedState} unread />);
      expect(container.querySelector('.unread-dot')).toBeNull();
      expect(container.querySelector('.badge')).not.toBeNull();
      const label = screen.getByRole('button', { name: /trellome/i }).getAttribute('aria-label') ?? '';
      expect(label).not.toMatch(/new output/i);
    });

    // David: "maybe the box color should be different until I click on
    // it" -- the whole card, not just the corner dot. .card.unread carries
    // that (OpenSessionCard.css), styled with theme.css tokens only.
    describe('the unread card treatment (whole-card, not just the dot)', () => {
      it('gives the card its own unread class when unread and not blocked', () => {
        const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={working} unread />);
        const card = container.querySelector('.card')!;
        expect(card.classList.contains('unread')).toBe(true);
        expect(card.classList.contains('attn')).toBe(false);
      });

      it('carries no unread class when unread is false or omitted', () => {
        const { container: withoutProp } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={working} />);
        expect(withoutProp.querySelector('.card')!.classList.contains('unread')).toBe(false);

        const { container: explicitFalse } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={working} unread={false} />);
        expect(explicitFalse.querySelector('.card')!.classList.contains('unread')).toBe(false);
      });

      // Blocked must stay the stronger signal: a blocked+unread card reads
      // as blocked (.attn), never as a third, mixed style -- mirrors the
      // dot's own suppression above, at the whole-card level.
      it('reads as blocked, not as a mixed state, when a card is both blocked and unread', () => {
        const blockedState: OpenSession = { ...working, activity: 'waiting_permission' };
        const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={blockedState} unread />);
        const card = container.querySelector('.card')!;
        expect(card.classList.contains('attn')).toBe(true);
        expect(card.classList.contains('unread')).toBe(false);
      });

      it('does not carry the working "live" class while showing the unread treatment', () => {
        const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={working} unread />);
        // `working` fixture's own activity is 'working', which would
        // otherwise earn .live -- unread must take precedence so the two
        // signals never combine into a class list a screen reader or a
        // colourblind user has no way to disambiguate visually.
        expect(container.querySelector('.card')!.classList.contains('live')).toBe(false);
      });
    });
  });

  // The app's first destructive action. These prove: the signal is never
  // sent without an explicit confirmation step; every control is a real,
  // keyboard-operable <button>, not a div with a click handler; pressing
  // any of them never also opens the session (the card underneath is
  // itself a role="button"); and the confirmation names what is about to
  // end (project, source, age), per the brief this was built from.
  describe('closing a session', () => {
    const withProcMeta: OpenSession = { ...base }; // host: iterm2, age: 9d, memory: 206 MB

    // Deliberately NOT labelled with project/source/age here -- that
    // belongs on the confirmation (next test), not this button. This
    // button's name is short and pid-qualified precisely so it never
    // collides, in a name-based lookup, with the card's own role="button"
    // wrapper (whose accessible name DOES carry project/pid) -- see the
    // "never opens the session" test below for what that collision would
    // otherwise cause.
    it('shows a Close button that does not itself end anything', () => {
      const onKill = neverKill();
      render(<OpenSessionCard onOpen={() => {}} onKill={onKill} onReattach={neverReattach()} onResume={neverResume()} state={withProcMeta} />);
      const closeBtn = screen.getByRole('button', { name: /^Close, pid 4242/ });
      expect(closeBtn.tagName).toBe('BUTTON');
      fireEvent.click(closeBtn);
      expect(onKill).not.toHaveBeenCalled();
    });

    it('requires a second, explicit confirmation before sending any signal', () => {
      const onKill = neverKill();
      render(<OpenSessionCard onOpen={() => {}} onKill={onKill} onReattach={neverReattach()} onResume={neverResume()} state={withProcMeta} />);
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      // The confirmation is now showing -- but onKill still has not fired.
      expect(screen.getByRole('group')).toBeTruthy();
      expect(onKill).not.toHaveBeenCalled();
    });

    it('names project, source and age in the confirmation, so it is obvious which session is about to end', () => {
      const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={withProcMeta} />);
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      // Scoped to the confirm text specifically -- the card's own .proj
      // ("trellome") and .path ("/Users/me/trellome") already contain
      // some of these words unrelated to the confirmation, so a
      // page-wide text search would pass even if the confirmation itself
      // said nothing at all.
      const confirmText = container.querySelector('.kill-confirm-text')?.textContent ?? '';
      expect(confirmText).toMatch(/trellome/);
      expect(confirmText).toMatch(/iTerm2/);
      expect(confirmText).toMatch(/9d/);
    });

    it('cancels back to the Close button without ever calling onKill', () => {
      const onKill = neverKill();
      render(<OpenSessionCard onOpen={() => {}} onKill={onKill} onReattach={neverReattach()} onResume={neverResume()} state={withProcMeta} />);
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      fireEvent.click(screen.getByRole('button', { name: /^Cancel/ }));
      expect(screen.getByRole('button', { name: /^Close/ })).toBeTruthy();
      expect(onKill).not.toHaveBeenCalled();
    });

    // The safe default: an accidental second Enter/Space after the Close
    // press lands on Cancel, not on the destructive action.
    it('focuses Cancel, not End session, when the confirmation appears', () => {
      render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={withProcMeta} />);
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Cancel/ }));
    });

    it('sends the signal only once "End session" is pressed, with this card\'s pid', async () => {
      const onKill = vi.fn<(pid: number) => Promise<KillResult>>().mockResolvedValue({ status: 'killed' });
      render(<OpenSessionCard onOpen={() => {}} onKill={onKill} onReattach={neverReattach()} onResume={neverResume()} state={withProcMeta} />);
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      fireEvent.click(screen.getByRole('button', { name: /^End session/ }));
      await waitFor(() => expect(onKill).toHaveBeenCalledTimes(1));
      expect(onKill).toHaveBeenCalledWith(4242);
    });

    it('announces "Ending session…" via an aria-live region while the call is in flight', async () => {
      let resolveKill!: (r: KillResult) => void;
      const onKill = vi.fn<(pid: number) => Promise<KillResult>>()
        .mockReturnValue(new Promise(res => { resolveKill = res; }));
      render(<OpenSessionCard onOpen={() => {}} onKill={onKill} onReattach={neverReattach()} onResume={neverResume()} state={withProcMeta} />);
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      fireEvent.click(screen.getByRole('button', { name: /^End session/ }));
      const status = await screen.findByText(/Ending session/);
      expect(status.getAttribute('aria-live')).toBe('polite');
      // Resolved and drained before the test ends -- otherwise this
      // promise's continuation (doKill's post-await setState calls)
      // fires after the test has already moved on, outside any act()
      // wrapper.
      resolveKill({ status: 'killed' });
      await waitFor(() => expect(screen.getByText(/Signal sent/)).toBeTruthy());
    });

    it('shows a settled status after a successful kill, then returns to the Close button on its own', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const onKill = vi.fn<(pid: number) => Promise<KillResult>>().mockResolvedValue({ status: 'killed' });
        render(<OpenSessionCard onOpen={() => {}} onKill={onKill} onReattach={neverReattach()} onResume={neverResume()} state={withProcMeta} />);
        fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
        fireEvent.click(screen.getByRole('button', { name: /^End session/ }));
        await waitFor(() => expect(screen.getByText(/Signal sent/)).toBeTruthy());
        await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
        expect(screen.getByRole('button', { name: /^Close/ })).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    it('shows a refusal message and a Dismiss control when main refuses the kill, without throwing', async () => {
      const onKill = vi.fn<(pid: number) => Promise<KillResult>>()
        .mockResolvedValue({ status: 'refused', reason: 'not_discovered' });
      render(<OpenSessionCard onOpen={() => {}} onKill={onKill} onReattach={neverReattach()} onResume={neverResume()} state={withProcMeta} />);
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      fireEvent.click(screen.getByRole('button', { name: /^End session/ }));
      const status = await screen.findByText(/no longer running/i);
      expect(status.getAttribute('aria-live')).toBe('polite');
      fireEvent.click(screen.getByRole('button', { name: /^Dismiss/ }));
      expect(screen.getByRole('button', { name: /^Close/ })).toBeTruthy();
    });

    it('shows a generic error, not a crash, when the kill call itself rejects', async () => {
      const onKill = vi.fn<(pid: number) => Promise<KillResult>>().mockRejectedValue(new Error('IPC gone'));
      render(<OpenSessionCard onOpen={() => {}} onKill={onKill} onReattach={neverReattach()} onResume={neverResume()} state={withProcMeta} />);
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      fireEvent.click(screen.getByRole('button', { name: /^End session/ }));
      expect(await screen.findByText(/Could not reach the app/i)).toBeTruthy();
    });

    // The regression this whole kill row has to avoid: it lives inside the
    // card's own role="button" wrapper (clicking the CARD opens the
    // session), so every click here must stop there, not bubble up.
    it('never opens the session when Close, Cancel or End session is clicked', () => {
      const onOpen = vi.fn();
      const onKill = vi.fn<(pid: number) => Promise<KillResult>>()
        .mockReturnValue(new Promise(() => {})); // never resolves -- only the call matters here
      render(<OpenSessionCard onOpen={onOpen} onKill={onKill} onReattach={neverReattach()} onResume={neverResume()} state={withProcMeta} />);
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      fireEvent.click(screen.getByRole('button', { name: /^Cancel/ }));
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      fireEvent.click(screen.getByRole('button', { name: /^End session/ }));
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('never opens the session on Enter/Space at the Close button either', () => {
      const onOpen = vi.fn();
      render(<OpenSessionCard onOpen={onOpen} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={withProcMeta} />);
      const closeBtn = screen.getByRole('button', { name: /^Close/ });
      fireEvent.keyDown(closeBtn, { key: 'Enter' });
      expect(onOpen).not.toHaveBeenCalled();
    });

    // Regression: src/renderer/main.tsx wraps <App> in <React.StrictMode>,
    // which is what the app actually runs under (electron-vite dev serves
    // the development React build, where StrictMode's extra mount/unmount/
    // remount simulation is active; it is a no-op in a production build).
    // mountedRef's guarding effect used to assign `false` only in its
    // cleanup, never resetting it in its own setup -- StrictMode's
    // simulated cleanup-then-remount left it permanently false on every
    // card, so doKill's post-`await onKill` update was silently dropped by
    // its own `if (!mountedRef.current) return` guard. The card never
    // reached "Signal sent."/"Already gone."/a refusal message; it stayed
    // on "Ending session..." forever, indistinguishable from the call
    // still being in flight. Not wrapped in an isolated test file: this is
    // the exact rendering configuration production actually uses, so the
    // regression test needs to match it, not a bare `render()`.
    it('settles to a real outcome after a successful kill even under React.StrictMode', async () => {
      const onKill = vi.fn<(pid: number) => Promise<KillResult>>().mockResolvedValue({ status: 'killed' });
      render(
        <React.StrictMode>
          <OpenSessionCard onOpen={() => {}} onKill={onKill} onReattach={neverReattach()} onResume={neverResume()} state={withProcMeta} />
        </React.StrictMode>,
      );
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      fireEvent.click(screen.getByRole('button', { name: /^End session/ }));
      await waitFor(() => expect(onKill).toHaveBeenCalled());
      expect(await screen.findByText(/Signal sent/)).toBeTruthy();
    });
  });

  // Fix-wave item 1: the payoff of removing AppleScript keystroke injection
  // -- this is the only way the twelve real sessions running in plain
  // iTerm2 become answerable at all. Same discipline as "closing a
  // session" above: confirm before acting, real buttons, never opens the
  // session underneath.
  describe('reattaching a session', () => {
    // provider claude, tmux false -- the one state where this is offered.
    const reattachable: OpenSession = { ...base, tmux: false };

    it('offers Reattach in app only for a Claude session that is not already tmux-backed', () => {
      const { rerender } = render(
        <OpenSessionCard onOpen={() => {}} onKill={neverKill()}
          onReattach={neverReattach()} onResume={neverResume()} state={reattachable} />,
      );
      expect(screen.getByRole('button', { name: /reattach in app/i })).toBeTruthy();

      // Already tmux-backed: nothing wrong to explain, so nothing renders.
      rerender(
        <OpenSessionCard onOpen={() => {}} onKill={neverKill()}
          onReattach={neverReattach()} onResume={neverResume()} state={{ ...reattachable, tmux: true }} />,
      );
      expect(screen.queryByRole('button', { name: /reattach in app/i })).toBeNull();
      expect(screen.queryByText(/codex/i)).toBeNull();
    });

    it('explains why, rather than hiding silently or offering a button that would fail obscurely, for a codex session', () => {
      render(
        <OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()}
          onResume={neverResume()} state={{ ...reattachable, provider: 'codex' }} />,
      );
      expect(screen.queryByRole('button', { name: /reattach in app/i })).toBeNull();
      expect(screen.getByText(/codex sessions/i)).toBeTruthy();
    });

    it('requires a second, explicit confirmation before reattaching', () => {
      const onReattach = neverReattach();
      render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()}
        onReattach={onReattach} onResume={neverResume()} state={reattachable} />);
      fireEvent.click(screen.getByRole('button', { name: /reattach in app/i }));
      expect(screen.getByRole('group')).toBeTruthy();
      expect(onReattach).not.toHaveBeenCalled();
    });

    // Brief's own wording: the conversation is preserved, anything in
    // flight is lost, and the current process ends.
    it('states the real cost in the confirmation', () => {
      const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()}
        onReattach={neverReattach()} onResume={neverResume()} state={reattachable} />);
      fireEvent.click(screen.getByRole('button', { name: /reattach in app/i }));
      const confirmText = container.querySelector('.reattach-confirm-text')?.textContent ?? '';
      expect(confirmText).toMatch(/conversation is kept/i);
      expect(confirmText).toMatch(/anything in flight is lost/i);
      expect(confirmText).toMatch(/process ends/i);
    });

    it('cancels back without ever calling onReattach', () => {
      const onReattach = neverReattach();
      render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()}
        onReattach={onReattach} onResume={neverResume()} state={reattachable} />);
      fireEvent.click(screen.getByRole('button', { name: /reattach in app/i }));
      fireEvent.click(screen.getByRole('button', { name: /^Cancel/ }));
      expect(screen.getByRole('button', { name: /reattach in app/i })).toBeTruthy();
      expect(onReattach).not.toHaveBeenCalled();
    });

    it('calls onReattach with this pid and a real size only once confirmed, and opens the new pid on success', async () => {
      const onOpen = vi.fn();
      const onReattach = vi.fn<(pid: number, cols: number, rows: number) => Promise<LaunchResult>>()
        .mockResolvedValue({ status: 'launched', pid: 9001 });
      render(<OpenSessionCard onOpen={onOpen} onKill={neverKill()}
        onReattach={onReattach} onResume={neverResume()} state={reattachable} />);
      fireEvent.click(screen.getByRole('button', { name: /reattach in app/i }));
      expect(onReattach).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: /^Reattach$/ }));
      await waitFor(() => expect(onOpen).toHaveBeenCalledWith(9001));
      expect(onReattach).toHaveBeenCalledWith(4242, expect.any(Number), expect.any(Number));
    });

    it('shows the failure reason and a Dismiss control on an ordinary failure', async () => {
      const onReattach = vi.fn<(pid: number, cols: number, rows: number) => Promise<LaunchResult>>()
        .mockResolvedValue({ status: 'failed', reason: 'tmux: no server running' });
      render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()}
        onReattach={onReattach} onResume={neverResume()} state={reattachable} />);
      fireEvent.click(screen.getByRole('button', { name: /reattach in app/i }));
      fireEvent.click(screen.getByRole('button', { name: /^Reattach$/ }));
      expect(await screen.findByText(/no server running/i)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /^Dismiss/ }));
      expect(screen.getByRole('button', { name: /reattach in app/i })).toBeTruthy();
    });

    // The distinct, unrecoverable-looking state fix-wave item 5 introduced:
    // must read differently from an ordinary failure (the old process is
    // actually gone) and must offer a way forward, not just a Dismiss.
    it('reports the old-session-ended-new-one-did-not-start state distinctly, with a way to retry', async () => {
      const onReattach = vi.fn<(pid: number, cols: number, rows: number) => Promise<LaunchResult>>()
        .mockResolvedValue({
          status: 'killed_not_relaunched', reason: 'tmux: server exited', sessionId: 'abc-123', cwd: '/a/proj',
        });
      render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()}
        onReattach={onReattach} onResume={neverResume()} state={reattachable} />);
      fireEvent.click(screen.getByRole('button', { name: /reattach in app/i }));
      fireEvent.click(screen.getByRole('button', { name: /^Reattach$/ }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/old session ended/i);
      expect(alert.textContent).toMatch(/did not start/i);
      expect(alert.textContent).toMatch(/tmux: server exited/i);
      // Not the ordinary failure's Dismiss -- a real way forward.
      expect(screen.queryByRole('button', { name: /^Dismiss/ })).toBeNull();
      expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
    });

    it('retries from the stranded sessionId/cwd, not this card\'s own pid, and opens the new pid on success', async () => {
      const onOpen = vi.fn();
      const onReattach = vi.fn<(pid: number, cols: number, rows: number) => Promise<LaunchResult>>()
        .mockResolvedValue({
          status: 'killed_not_relaunched', reason: 'tmux: server exited', sessionId: 'abc-123', cwd: '/a/proj',
        });
      const onResume = vi.fn<(sessionId: string, cwd: string, cols: number, rows: number) => Promise<LaunchResult>>()
        .mockResolvedValue({ status: 'launched', pid: 9002 });
      render(<OpenSessionCard onOpen={onOpen} onKill={neverKill()}
        onReattach={onReattach} onResume={onResume} state={reattachable} />);
      fireEvent.click(screen.getByRole('button', { name: /reattach in app/i }));
      fireEvent.click(screen.getByRole('button', { name: /^Reattach$/ }));
      fireEvent.click(await screen.findByRole('button', { name: /try again/i }));
      await waitFor(() => expect(onOpen).toHaveBeenCalledWith(9002));
      expect(onResume).toHaveBeenCalledWith('abc-123', '/a/proj', expect.any(Number), expect.any(Number));
    });

    // The recoverability requirement itself: a retry that ALSO fails must
    // not degrade into a dead-end -- Try again has to still be there.
    it('stays retryable when the retry itself fails', async () => {
      const onReattach = vi.fn<(pid: number, cols: number, rows: number) => Promise<LaunchResult>>()
        .mockResolvedValue({
          status: 'killed_not_relaunched', reason: 'tmux: server exited', sessionId: 'abc-123', cwd: '/a/proj',
        });
      const onResume = vi.fn<(sessionId: string, cwd: string, cols: number, rows: number) => Promise<LaunchResult>>()
        .mockResolvedValue({ status: 'failed', reason: 'tmux: still down' });
      render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()}
        onReattach={onReattach} onResume={onResume} state={reattachable} />);
      fireEvent.click(screen.getByRole('button', { name: /reattach in app/i }));
      fireEvent.click(screen.getByRole('button', { name: /^Reattach$/ }));
      fireEvent.click(await screen.findByRole('button', { name: /try again/i }));
      expect(await screen.findByText(/tmux: still down/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
    });

    // Same regression class as killrow's own test: every control here lives
    // inside the card's own role="button" wrapper.
    it('never opens the session when any reattach control is clicked', () => {
      const onOpen = vi.fn();
      const onReattach = vi.fn<(pid: number, cols: number, rows: number) => Promise<LaunchResult>>()
        .mockReturnValue(new Promise(() => {}));
      render(<OpenSessionCard onOpen={onOpen} onKill={neverKill()}
        onReattach={onReattach} onResume={neverResume()} state={reattachable} />);
      fireEvent.click(screen.getByRole('button', { name: /reattach in app/i }));
      fireEvent.click(screen.getByRole('button', { name: /^Cancel/ }));
      fireEvent.click(screen.getByRole('button', { name: /reattach in app/i }));
      fireEvent.click(screen.getByRole('button', { name: /^Reattach$/ }));
      expect(onOpen).not.toHaveBeenCalled();
    });
  });

  // David: Close and Reattach were stacking one per line, making every
  // eligible card noticeably taller for no reason. Both idle, single-line
  // pill buttons now share one row (.actionsrow); each keeps its own
  // confirm/status machinery untouched (proven above, in "closing a
  // session" and "reattaching a session") -- this only proves the shared
  // row itself, and that entering a wider phase doesn't corrupt the other
  // row's own idle/confirm behaviour.
  describe('the shared Close/Reattach actions row', () => {
    const reattachable: OpenSession = { ...base, tmux: false }; // claude, not tmux -- Reattach offered

    it('puts Close and Reattach on the same row when both are present', () => {
      const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={reattachable} />);
      const row = container.querySelector('.actionsrow');
      expect(row).not.toBeNull();
      expect(row!.querySelector('.killrow')).not.toBeNull();
      expect(row!.querySelector('.reattachrow')).not.toBeNull();
    });

    // `base` is tmux:true -- already interactive, so Reattach is not
    // offered (see the "offers Reattach in app only for..." test above).
    it('keeps just Close in the row when Reattach is not offered', () => {
      const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={base} />);
      const row = container.querySelector('.actionsrow')!;
      expect(row.querySelector('.killrow')).not.toBeNull();
      expect(row.querySelector('.reattachrow')).toBeNull();
    });

    it('keeps just Close in the row for a Codex session, with its explanation rendered outside the row', () => {
      const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={{ ...base, provider: 'codex' }} />);
      const row = container.querySelector('.actionsrow')!;
      expect(row.querySelector('.killrow')).not.toBeNull();
      expect(row.querySelector('.reattachrow')).toBeNull();
      const explanation = container.querySelector('.reattach-na');
      expect(explanation).not.toBeNull();
      expect(row.contains(explanation)).toBe(false);
    });

    // Mutation target: dropping the `wide` class (or applying it
    // unconditionally) would either squeeze the confirm panel next to an
    // idle Reattach button or force Reattach wide even while it's doing
    // nothing.
    it('marks its own row wide once Close enters confirmation, leaving an idle Reattach compact', () => {
      const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={reattachable} />);
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      expect(container.querySelector('.killrow')!.classList.contains('wide')).toBe(true);
      expect(container.querySelector('.reattachrow')!.classList.contains('wide')).toBe(false);
    });

    it('marks the reattach row wide once it enters confirmation, leaving an idle Close compact', () => {
      const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={reattachable} />);
      fireEvent.click(screen.getByRole('button', { name: /reattach in app/i }));
      expect(container.querySelector('.reattachrow')!.classList.contains('wide')).toBe(true);
      expect(container.querySelector('.killrow')!.classList.contains('wide')).toBe(false);
    });

    // The confirm flow end to end, in the one shape the "closing a session"
    // block above never exercises: Reattach also present on the same row.
    // Proves the restructuring didn't disturb Close's own confirm/cancel
    // behaviour, or its focus safety net (Cancel takes focus first, so a
    // stray Return lands on the safe choice, not the destructive one).
    it('confirms and cancels Close correctly with Reattach also present, and Cancel holds focus', () => {
      const onKill = neverKill();
      render(<OpenSessionCard onOpen={() => {}} onKill={onKill} onReattach={neverReattach()} onResume={neverResume()} state={reattachable} />);
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      expect(screen.getByRole('group')).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Cancel/ }));
      fireEvent.click(screen.getByRole('button', { name: /^Cancel/ }));
      expect(screen.getByRole('button', { name: /^Close/ })).toBeTruthy();
      expect(screen.getByRole('button', { name: /reattach in app/i })).toBeTruthy();
      expect(onKill).not.toHaveBeenCalled();
    });
  });

  describe('OpenSessionCard -- the compact variant', () => {
    const enrichedCompact: OpenSession = {
      ...base, match: 'unique', sessionId: 's1', lastProse: 'Reused the JWT helper',
      events: 9129, activity: 'working', tmux: false,
    };
    const renderCompact = (over: Partial<OpenSession> = {}, props: Record<string, unknown> = {}) =>
      render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()}
        onResume={neverResume()} compact state={{ ...enrichedCompact, ...over }} {...props} />);

    it('keeps the provider, the project, the status, the host and some of the message, and drops the rest', () => {
      const { container } = renderCompact();
      expect(container.querySelector('.card')!.classList.contains('compact')).toBe(true);
      expect(screen.getByText('trellome')).toBeTruthy();
      expect(screen.getByText('Claude')).toBeTruthy();
      expect(screen.getByText('iTerm2')).toBeTruthy();
      expect(screen.getByText('working')).toBeTruthy();
      // Kept, per David (looking at the real, running window, mid-task):
      // some of the message text, clamped to three lines by this card's own
      // .compact-said CSS rule -- see OpenSessionCard.css.test.ts for the
      // clamp itself; jsdom computes no layout, so this only proves the
      // element renders, never that the clamp visually holds.
      expect(screen.getByText('Reused the JWT helper')).toBeTruthy();
      // Dropped: the path, the age/memory line and the event count -- still
      // too tall for a compact card even with the message text kept.
      expect(screen.queryByText('/Users/me/trellome')).toBeNull();
      expect(screen.queryByText(/206 MB/)).toBeNull();
      expect(screen.queryByText('9,129')).toBeNull();
    });

    it('renders the message through its own class, never SessionCard.css\'s two-line .said', () => {
      // The regression this guards against: the conversation pane once
      // reused .said for exactly this purpose and silently clipped every
      // reply past two lines in the real window while jsdom -- which
      // computes no layout -- kept passing. Pinning the exact class name
      // here is what would catch a future edit that reaches for .said
      // again, since jsdom can't catch the clamp count itself.
      const { container } = renderCompact();
      const msg = container.querySelector('.compact-said');
      expect(msg).not.toBeNull();
      expect(msg!.classList.contains('said')).toBe(false);
      expect(msg!.textContent).toBe('Reused the JWT helper');
    });

    it('shows no message element on a compact card with nothing to say', () => {
      // Same "blank is honest, not a placeholder" rule the full card's own
      // .said follows -- extended to the compact card's .compact-said.
      const { container } = renderCompact({ lastProse: null });
      expect(container.querySelector('.compact-said')).toBeNull();
    });

    it('keeps the unread dot, which is the whole point of glancing at the rail', () => {
      const { container } = renderCompact({}, { unread: true });
      expect(container.querySelector('.unread-dot')).not.toBeNull();
    });

    it('keeps the blocked badge and its wording', () => {
      const { container } = renderCompact({ activity: 'waiting_permission' });
      expect(container.querySelector('.badge')).not.toBeNull();
      expect(container.querySelector('.state-word')!.textContent).toBe('waiting');
      expect(container.querySelector('.card')!.getAttribute('aria-label')).toContain('waiting on you');
    });

    it('offers no bare Close or Reattach button -- they live in the menu', () => {
      renderCompact();
      expect(screen.queryByRole('button', { name: /^Close, pid/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Reattach in app, pid/ })).toBeNull();
      expect(screen.getByRole('button', { name: /session actions/i })).toBeTruthy();
    });

    it('opens the menu with the four documented items, favourites included', () => {
      const { container } = renderCompact({}, { onReveal: vi.fn(async () => {}) });
      fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
      expect([...container.querySelectorAll('.cardmenu-item')].map(b => b.textContent))
        .toEqual(['Show in iTerm2', 'Reattach in app', 'Add to category', 'Add folder to favourites', 'Close session']);
    });

    it('omits Reattach for a session that is already tmux-backed, and Show in host with no host', () => {
      // 'unknown', not null: OpenSession.host (src/fleet/state.ts) is
      // LiveProcess['host'] with no null in its union -- classifyHost's own
      // sentinel for "no host" is the string 'unknown', the same value the
      // non-compact card's own "renders no host text" test already uses.
      const { container } = renderCompact({ tmux: true, host: 'unknown' });
      fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
      expect([...container.querySelectorAll('.cardmenu-item')].map(b => b.textContent))
        .toEqual(['Add to category', 'Add folder to favourites', 'Close session']);
    });

    it.each([
      ['Escape', () => fireEvent.keyDown(window, { key: 'Escape' })],
      ['a click elsewhere', () => fireEvent.mouseDown(document.body)],
    ])('closes the menu on %s', (_label, act) => {
      const { container } = renderCompact();
      fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
      expect(container.querySelector('.cardmenu-list')).not.toBeNull();
      act();
      expect(container.querySelector('.cardmenu-list')).toBeNull();
    });

    // David's own bug report against the real, running window: the next
    // card in the list painted over this one's open menu ("card action bar
    // is hidden below the card"). jsdom computes no layout or paint, so
    // this cannot prove one card visibly covers another -- see
    // OpenSessionCard.css.test.ts for the stylesheet half of this fix. This
    // only pins the DOM half: the raising class tracks menuOpen exactly,
    // never lingering once the menu itself is gone.
    it('marks the card raised only while its menu is open', () => {
      const { container } = renderCompact();
      const card = container.querySelector('.card')!;
      expect(card.classList.contains('menu-open')).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
      expect(card.classList.contains('menu-open')).toBe(true);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(card.classList.contains('menu-open')).toBe(false);
    });

    // Reuse, not a second implementation: Close opens the SAME confirm panel
    // the full card shows, naming the same session in the same words.
    it('routes Close session into the existing confirm flow, not straight to a kill', () => {
      const onKill = neverKill();
      const { container } = renderCompact({}, { onKill });
      fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
      fireEvent.click(screen.getByRole('button', { name: 'Close session' }));
      expect(container.querySelector('.kill-confirm')).not.toBeNull();
      expect(screen.getByText(/^End the Claude session in trellome/)).toBeTruthy();
      expect(onKill).not.toHaveBeenCalled();
      expect(container.querySelector('.cardmenu-list')).toBeNull();
    });

    it('routes Reattach in app into the existing confirm flow too', () => {
      const onReattach = neverReattach();
      const { container } = renderCompact({}, { onReattach });
      fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
      fireEvent.click(screen.getByRole('button', { name: 'Reattach in app' }));
      expect(container.querySelector('.reattach-confirm')).not.toBeNull();
      expect(onReattach).not.toHaveBeenCalled();
    });

    it('brings the host forward from the menu', () => {
      const onReveal = vi.fn(async () => {});
      renderCompact({}, { onReveal });
      fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
      fireEvent.click(screen.getByRole('button', { name: 'Show in iTerm2' }));
      expect(onReveal).toHaveBeenCalledWith(4242);
    });

    // Every control on this card is nested inside the card's own
    // role="button" wrapper, so each must stop its own click from also
    // opening the session -- the same rule .killrow and .reattachrow already
    // follow.
    it('never opens the session when the menu or one of its items is clicked', () => {
      const onOpen = vi.fn();
      renderCompact({}, { onOpen, onReveal: vi.fn(async () => {}) });
      fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
      fireEvent.click(screen.getByRole('button', { name: 'Show in iTerm2' }));
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('still renders the full card by default, with nothing opted in', () => {
      const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()}
        onReattach={neverReattach()} onResume={neverResume()} state={enrichedCompact} />);
      expect(container.querySelector('.card')!.classList.contains('compact')).toBe(false);
      expect(screen.getByText('/Users/me/trellome')).toBeTruthy();
    });

    // David's addition: the "⋯" menu now exists on a full card too, but
    // ONLY for favouriting -- Close/Reattach stay exactly as they were,
    // visible inline pills, never duplicated into this menu for a full card.
    it('offers a session-actions menu on a full card too, with the category and favourites items in it', () => {
      const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()}
        onReattach={neverReattach()} onResume={neverResume()} state={enrichedCompact} />);
      fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
      expect([...container.querySelectorAll('.cardmenu-item')].map(b => b.textContent))
        .toEqual(['Add to category', 'Add folder to favourites']);
      // Close/Reattach still render as their own visible pills, unaffected.
      expect(screen.getByRole('button', { name: /^Close, pid/ })).toBeTruthy();
    });
  });

  // Favourite folders (David's addition): the SAME shared store LaunchBar's
  // star and MainPane's header star use (state/favourites.ts) -- exercised
  // here through the card's own "⋯" menu item, on both card sizes.
  describe('the favourites menu item', () => {
    it('adds the session folder to the shared store, live, with no reload', () => {
      renderCompact({}, {});
      fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
      // Same as every other item (Show in X/Reattach/Close): clicking closes
      // the menu, so the toggled label is checked by reopening it.
      fireEvent.click(screen.getByRole('button', { name: 'Add folder to favourites' }));
      expect(getFavourites()).toContain('/Users/me/trellome');
      fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
      expect(screen.getByRole('button', { name: 'Remove folder from favourites' })).toBeTruthy();
    });

    it('shows Remove, and removes on click, once the folder is already a favourite', () => {
      addFavourite('/Users/me/trellome');
      renderCompact({}, {});
      fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
      fireEvent.click(screen.getByRole('button', { name: 'Remove folder from favourites' }));
      expect(getFavourites()).not.toContain('/Users/me/trellome');
    });

    it('is disabled when the session has no cwd at all', () => {
      renderCompact({ cwd: null }, {});
      fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
      const item = screen.getByRole('button', { name: 'Add folder to favourites' }) as HTMLButtonElement;
      expect(item.disabled).toBe(true);
    });

    it('never opens the session when clicked, same as every other menu item', () => {
      const onOpen = vi.fn();
      renderCompact({}, { onOpen });
      fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
      fireEvent.click(screen.getByRole('button', { name: 'Add folder to favourites' }));
      expect(onOpen).not.toHaveBeenCalled();
    });
  });

  function renderCompact(over: Partial<OpenSession> = {}, props: Record<string, unknown> = {}) {
    const enrichedCompact: OpenSession = {
      ...base, match: 'unique', sessionId: 's1', lastProse: 'Reused the JWT helper',
      events: 9129, activity: 'working', tmux: false,
    };
    return render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()}
      onResume={neverResume()} compact state={{ ...enrichedCompact, ...over }} {...props} />);
  }
});

// Categories (Task 1's groups.ts store), filed from this card's own "..."
// menu. A top-level describe, not nested inside `describe('OpenSessionCard',
// ...)` above: it needs its own beforeEach clearing groups.ts's storage
// (the outer describe's beforeEach only resets favourites.ts), and nothing
// here depends on state declared inside that block.
describe('the category menu item', () => {
  // A session-keyed store, so the fixture needs a real sessionId -- the
  // base fixture is deliberately unmatched (sessionId: null), which is the
  // "cannot be categorised" case tested last.
  const matched: OpenSession = {
    ...base, match: 'unique', sessionId: 's1', activity: 'working', tmux: true,
  };

  function renderCat(over: Partial<OpenSession> = {}) {
    return render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()}
      onResume={neverResume()} compact state={{ ...matched, ...over }} />);
  }

  function openCategoryPanel() {
    fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
    fireEvent.click(screen.getByRole('button', { name: /^(Add to category|Category: )/ }));
  }

  beforeEach(() => { localStorage.clear(); reloadGroups(); });

  it('offers to put the session in a category', () => {
    renderCat();
    fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
    expect(screen.getByRole('button', { name: 'Add to category' })).toBeTruthy();
  });

  it('creates a name and assigns the session to it in one go', () => {
    renderCat();
    openCategoryPanel();
    const field = screen.getByRole('textbox', { name: /new category name/i });
    fireEvent.change(field, { target: { value: 'Fleet' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(categoryOfSession('s1')).toBe('Fleet');
    expect(categoryNames()).toEqual(['Fleet']);
  });

  // THE case David will actually hit, and the one the exact-session-identity
  // work exists to make possible: two sessions in the same repo, each with
  // its own id because applyExactMatches resolved each pid from its live
  // session file, filed under two different names. A shared cwd is not a
  // barrier -- this test is what says so.
  it('files two sessions sharing a folder under two different categories', () => {
    const { unmount } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()}
      onReattach={neverReattach()} onResume={neverResume()} compact
      state={{ ...matched, pid: 101, cwd: '/repo', sessionId: 's1', match: 'unique' }} />);
    openCategoryPanel();
    let field = screen.getByRole('textbox', { name: /new category name/i });
    fireEvent.change(field, { target: { value: 'Review' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    unmount();

    render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()}
      onReattach={neverReattach()} onResume={neverResume()} compact
      state={{ ...matched, pid: 102, cwd: '/repo', sessionId: 's2', match: 'unique' }} />);
    openCategoryPanel();
    field = screen.getByRole('textbox', { name: /new category name/i });
    fireEvent.change(field, { target: { value: 'Shipping' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(categoryOfSession('s1')).toBe('Review');
    expect(categoryOfSession('s2')).toBe('Shipping');
    expect(categoryNames()).toEqual(['Review', 'Shipping']);
  });

  it('names the current category on the menu item once assigned', () => {
    assignCategory('s1', 'Fleet');
    renderCat();
    fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
    expect(screen.getByRole('button', { name: 'Category: Fleet' })).toBeTruthy();
  });

  it('assigns to a name another session already created', () => {
    assignCategory('other', 'Fleet');
    renderCat();
    openCategoryPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Fleet' }));
    expect(categoryOfSession('s1')).toBe('Fleet');
  });

  it('marks the current category as the chosen one', () => {
    assignCategory('s1', 'Fleet');
    renderCat();
    openCategoryPanel();
    // No @testing-library/jest-dom in this repo (verified: package.json
    // never mentions it, vitest.config.ts registers no setupFiles) -- so
    // this reads the attribute directly rather than using toHaveAttribute.
    expect(screen.getByRole('button', { name: 'Fleet' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('clears the category through No category, leaving the name standing', () => {
    assignCategory('s1', 'Fleet');
    renderCat();
    openCategoryPanel();
    fireEvent.click(screen.getByRole('button', { name: 'No category' }));
    expect(categoryOfSession('s1')).toBeNull();
    expect(categoryNames()).toEqual(['Fleet']);
  });

  it('renames a category, and the session follows the new name', () => {
    assignCategory('s1', 'Fleet');
    renderCat();
    openCategoryPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Rename Fleet' }));
    const field = screen.getByRole('textbox', { name: /new name for Fleet/i });
    fireEvent.change(field, { target: { value: 'Shipping' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(categoryOfSession('s1')).toBe('Shipping');
  });

  it('says why a rename was refused rather than failing silently', () => {
    assignCategory('other', 'Review');
    assignCategory('s1', 'Fleet');
    renderCat();
    openCategoryPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Rename Fleet' }));
    const field = screen.getByRole('textbox', { name: /new name for Fleet/i });
    fireEvent.change(field, { target: { value: 'Review' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByText(/already a category/i)).toBeTruthy();
    expect(categoryOfSession('s1')).toBe('Fleet');
  });

  // The spec's rule, and the UI half of it: "The UI shows why, rather than
  // hiding the option."
  it('blocks Delete while a live session holds the name, and explains it on the button', () => {
    assignCategory('s1', 'Fleet');
    renderCat();
    openCategoryPanel();
    const del = screen.getByRole('button', { name: 'Delete Fleet' }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    const why = screen.getByText(/a session is in Fleet/i);
    expect(del.getAttribute('aria-describedby')).toBe(why.getAttribute('id'));
    expect(categoryNames()).toEqual(['Fleet']);
  });

  it('deletes a name that nothing holds', () => {
    assignCategory('other', 'Fleet');
    // The rail prunes on every fleet push; here the session simply is not live.
    pruneAssignments(['s1']);
    renderCat();
    openCategoryPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Fleet' }));
    expect(categoryNames()).toEqual([]);
  });

  // Disabled WITH THE REASON VISIBLE, not hidden and not in a title
  // attribute -- a tooltip explains nothing to anyone on a keyboard or a
  // screen reader, the same call this app already makes for the Codex
  // reattach line and the name field in the launch dropdown.
  it('says a folder is shared, when that is why it cannot file this one', () => {
    renderCat({ sessionId: null, match: 'ambiguous' });
    fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
    const item = screen.getByRole('button', { name: 'Add to category' }) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    const why = screen.getByText(/several sessions share this folder/i);
    expect(why.textContent).toMatch(/cannot tell which one this is/i);
    expect(item.getAttribute('aria-describedby')).toBe(why.getAttribute('id'));
  });

  // The other cause of a null sessionId, and a different sentence: nothing
  // matched this process at all, which is not the same as too much matching.
  it('says no conversation was matched, when THAT is why', () => {
    renderCat({ sessionId: null, match: 'unknown' });
    fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
    expect((screen.getByRole('button', { name: 'Add to category' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/no conversation matched to this process yet/i)).toBeTruthy();
  });

  it('shows no reason at all once the session is uniquely matched', () => {
    renderCat();
    fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
    expect(screen.queryByText(/several sessions share this folder/i)).toBeNull();
    expect((screen.getByRole('button', { name: 'Add to category' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('never opens the session when a category control is clicked', () => {
    const onOpen = vi.fn();
    render(<OpenSessionCard onOpen={onOpen} onKill={neverKill()} onReattach={neverReattach()}
      onResume={neverResume()} compact state={matched} />);
    openCategoryPanel();
    fireEvent.click(screen.getByRole('button', { name: 'No category' }));
    expect(onOpen).not.toHaveBeenCalled();
  });
});

/* ---- Status row, variant A -------------------------------------------
   At the rail's narrowest widths the status word is hidden and the icon is
   the only thing left showing the state. Which width that happens at is
   CSS (SessionRail.css's container query) and jsdom computes no layout --
   but the part that MUST hold at every width is testable here: the word is
   in the DOM, in every state, always. CSS only ever hides it visually. */
describe('the status row', () => {
  const render1 = (activity: OpenSession['activity']) => render(
    <OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()}
      onResume={neverResume()} state={{ ...base, match: 'unique', sessionId: 's1', activity }} />,
  );

  it.each<[NonNullable<OpenSession['activity']>, string]>([
    ['working', 'working'], ['idle', 'idle'], ['error', 'error'],
    // Shortened for the row alone (ACTIVITY_WORD_ROW): it was the widest
    // word the row could hold and set both of the rail's breakpoints for
    // every other state. The card's NAME keeps the full phrase -- asserted
    // separately below.
    ['waiting_permission', 'waiting'], ['waiting_input', 'waiting'],
  ])('renders %s with its word in the DOM, never an icon alone', (activity, word) => {
    const { container } = render1(activity);
    expect(container.querySelector('.state-word')!.textContent).toBe(word);
    expect(container.querySelector('.stateicon')).toBeTruthy();
  });

  // The card's accessible name carries the state too, so the status is
  // reachable even at the width where the word is visually hidden.
  it.each<NonNullable<OpenSession['activity']>>(['waiting_permission', 'waiting_input'])(
    'names the card "waiting on you" for %s', (activity) => {
      const { container } = render1(activity);
      expect(container.querySelector('.card')!.getAttribute('aria-label'))
        .toContain('waiting on you');
    });

  // The icon is decoration; the word beside it is the name. If the icon
  // announced itself too, a screen reader would say the state twice.
  it('leaves the naming to the word, not the icon', () => {
    const { container } = render1('working');
    expect(container.querySelector('.stateicon')!.getAttribute('aria-hidden')).toBe('true');
  });

  // The colour-only dot is retired everywhere, not merely hidden in the
  // rail: David asked for one treatment across the rail and the fleet
  // view, and a dot left in the markup would be a second one waiting to
  // come back.
  it('no longer renders the colour-only dot anywhere', () => {
    const { container } = render1('idle');
    expect(container.querySelector('.state .dot')).toBeNull();
    expect(container.querySelector('.state .stateicon')).toBeTruthy();
  });
});

/* ---- the sub-agent count --------------------------------------------
   Shown only when there are agents to show. That is not only tidiness:
   measured, the count costs ~27px of a status row that has overflowed its
   card three times already, and most sessions spawn none -- so the common
   card has to pay nothing for this. */
describe('the sub-agent count', () => {
  const render1 = (over: Partial<OpenSession>) => render(
    <OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()}
      onResume={neverResume()} state={{ ...base, match: 'unique', sessionId: 's1',
        activity: 'working', agents: null, liveAgents: null, ...over }} />,
  );

  it('shows live/total, the same notation the history card uses', () => {
    const { container } = render1({ agents: 3, liveAgents: 2 });
    expect(container.querySelector('.agents')!.textContent).toContain('2/3');
  });

  it('adds nothing to the row when the session spawned none', () => {
    const { container } = render1({ agents: 0, liveAgents: 0 });
    expect(container.querySelector('.agents')).toBeNull();
  });

  // The distinction the data layer keeps (see tests/fleet/state.test.ts):
  // null is "this pid is not uniquely matched", not "it has none". Both
  // render nothing -- but only one of them would be a lie if it rendered
  // "0/0", so neither may.
  it('shows nothing, not a zero, when the count is unknown', () => {
    const { container } = render1({ agents: null, liveAgents: null, match: 'ambiguous', sessionId: null });
    expect(container.querySelector('.agents')).toBeNull();
    expect(container.textContent).not.toContain('0/0');
  });

  // The row's width rules have to know whether this element is there: a
  // container query cannot ask "is a child present", so the row says so.
  // On the ROW rather than the card, because in the fleet grid the card IS
  // the query container and a container can't match itself.
  it('marks the row, so the width rules can budget for it', () => {
    expect(render1({ agents: 2, liveAgents: 1 }).container.querySelector('.metrics')!.className).toContain('hasagents');
    expect(render1({ agents: 0, liveAgents: 0 }).container.querySelector('.metrics')!.className).not.toContain('hasagents');
  });

  // "2/3" read aloud is "two slash three", which says nothing about what
  // is being counted. The digits are decoration; the phrase is the name.
  it('names itself for a screen reader rather than reading as digits', () => {
    const { container } = render1({ agents: 3, liveAgents: 2 });
    const el = container.querySelector('.agents')!;
    expect(el.querySelector('[aria-hidden="true"]')!.textContent).toBe('2/3');
    expect(el.textContent).toContain('2 of 3 sub-agents running');
  });

  it('counts down to none running without disappearing', () => {
    const { container } = render1({ agents: 4, liveAgents: 0 });
    expect(container.querySelector('.agents')!.textContent).toContain('0/4');
  });
});
