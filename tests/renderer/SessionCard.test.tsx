import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionCard, OpenSessionCard } from '../../src/renderer/components/SessionCard.tsx';
import type { SessionState, OpenSession } from '../../src/fleet/state.ts';

const base: SessionState = {
  sessionId:'s1', runId:'r1', provider:'claude', cwd:'/Users/me/trellome',
  project:'trellome', lifecycle:'active', activity:'working', stale:false,
  confidence:'guess', source:'transcript', lastProse:'Reused the JWT helper.',
  lastActivityAt:'2026-09-10T12:00:00Z', agents:44, liveAgents:2, events:9129,
  blocker:null, match:'unique', candidates:[123], host:'iterm2',
  alive:true, processAgeSeconds:null, processRssBytes:null, sharesWorktreeWith:[],
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

  // A "we don't know" field shown on every single card (true of all of them
  // today -- process discovery never runs on the app's path yet) claims we
  // looked and failed, when the truth is we never looked. Rendering nothing
  // says that honestly; Phase 5's process discovery is what starts putting
  // real labels here. Covers null (no discovery), classifyHost's own
  // 'unknown' result, and -- since HOST_LABEL is a closed Record<Host,
  // string> that TS itself proves never misses for a real HostApp value --
  // an out-of-union value (stale persisted state, an `as any`, a future bug
  // elsewhere) falls through the same way: there is no real label to show,
  // so none of these three cases is a genuinely different one.
  it('renders no host text when host is null', () => {
    const { container } = render(<SessionCard onOpen={() => {}} state={{ ...base, host: null }} />);
    expect(container.querySelector('.host')).toBeNull();
  });

  it('renders no host text when host is classifyHost\'s own "unknown"', () => {
    const { container } = render(<SessionCard onOpen={() => {}} state={{ ...base, host: 'unknown' }} />);
    expect(container.querySelector('.host')).toBeNull();
  });

  it('renders no host text for a value that never went through classifyHost()', () => {
    const { container } = render(<SessionCard onOpen={() => {}} state={{ ...base, host: 'ssh-remote' as any }} />);
    expect(container.querySelector('.host')).toBeNull();
  });

  it('still shows a real host label when one is known', () => {
    render(<SessionCard onOpen={() => {}} state={{ ...base, host: 'iterm2' }} />);
    expect(screen.getByText('iTerm2')).toBeTruthy();
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

  // A blocked card's badge visually overlapped a longer host label (e.g.
  // "VS Code") in the same top-right corner -- fixed by reserving the
  // badge's width in the row (.crow.hasbadge), not by shortening the
  // label. jsdom does not lay out CSS, so this cannot assert the overlap
  // is gone; it guards the fix stayed a layout fix rather than the DOM
  // text itself getting truncated to dodge the badge.
  it('keeps the full host label next to the badge, rather than shortening it', () => {
    const { container } = render(<SessionCard onOpen={() => {}} state={{ ...base, host:'vscode',
      activity:'waiting_permission', blocker:{ sessionId:'s1', kind:'PermissionRequest', toolUseId:'t1',
        promptId:null, occurredAt:'2026-09-10T11:58:00Z', text:'Permission: Bash npm run dist:mac' } }} />);
    expect(screen.getByText('VS Code')).toBeTruthy();
    expect(container.querySelector('.badge')).not.toBeNull();
  });

  // Process age/memory is what makes a "Waiting for you" card judgeable
  // ("is this the 9-day-old 206 MB one I should kill?") -- but it is noise
  // on every other tier, so FleetView has to opt a card in explicitly
  // rather than this component inferring it from state.alive alone.
  describe('process age/memory (showProcessMeta)', () => {
    it('shows formatted age and memory when showProcessMeta is set', () => {
      render(<SessionCard onOpen={() => {}} showProcessMeta
        state={{ ...base, processAgeSeconds: 9 * 86_400, processRssBytes: 206 * 1024 * 1024 }} />);
      expect(screen.getByText(/9d/)).toBeTruthy();
      expect(screen.getByText(/206 MB/)).toBeTruthy();
    });

    it('shows nothing for process meta when showProcessMeta is not set, even with known values', () => {
      const { container } = render(<SessionCard onOpen={() => {}}
        state={{ ...base, processAgeSeconds: 9 * 86_400, processRssBytes: 206 * 1024 * 1024 }} />);
      expect(container.querySelector('.procmeta')).toBeNull();
    });

    it('shows nothing for process meta when showProcessMeta is set but the values are unknown', () => {
      const { container } = render(<SessionCard onOpen={() => {}} showProcessMeta
        state={{ ...base, processAgeSeconds: null, processRssBytes: null }} />);
      expect(container.querySelector('.procmeta')).toBeNull();
    });

    it('shows only the known half when age is missing but memory is known', () => {
      render(<SessionCard onOpen={() => {}} showProcessMeta
        state={{ ...base, processAgeSeconds: null, processRssBytes: 206 * 1024 * 1024 }} />);
      expect(screen.getByText('206 MB')).toBeTruthy();
    });
  });
});

// The model correction: one card per live process, "ALL OPEN SESSIONS
// should show. And the source." Fully unattributed by default -- most
// tests below override only what they're testing, so the base fixture
// pins the honest "we don't know" case (no session could be matched) that
// is the common outcome on a shared-cwd repo.
describe('OpenSessionCard', () => {
  const openBase: OpenSession = {
    pid: 4242, host: 'iterm2', cwd: '/Users/me/trellome', project: 'trellome',
    ageSeconds: 9 * 86_400, rssBytes: 206 * 1024 * 1024, match: 'unknown',
    sessionId: null, provider: null, lastProse: null, events: null, activity: null,
  };

  it('shows pid, project, cwd, host, age and memory even with no transcript match at all', () => {
    render(<OpenSessionCard onOpen={() => {}} state={openBase} />);
    expect(screen.getByText('trellome')).toBeTruthy();
    expect(screen.getByText('/Users/me/trellome')).toBeTruthy();
    expect(screen.getByText('iTerm2')).toBeTruthy();
    expect(screen.getByText(/9d/)).toBeTruthy();
    expect(screen.getByText(/206 MB/)).toBeTruthy();
    expect(screen.getByText(/pid 4242/)).toBeTruthy();
  });

  it('is operable by keyboard and mouse, passing pid to onOpen every time', () => {
    const onOpen = vi.fn();
    render(<OpenSessionCard state={openBase} onOpen={onOpen} />);
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

  it('renders no provider badge when the process could not be matched to exactly one session', () => {
    const { container } = render(<OpenSessionCard onOpen={() => {}} state={openBase} />);
    expect(container.querySelector('.prov')).toBeNull();
    expect(screen.queryByText('Claude')).toBeNull();
    expect(screen.queryByText('Codex')).toBeNull();
  });

  it('renders no last-message text when unmatched -- blank is honest, not a placeholder', () => {
    const { container } = render(<OpenSessionCard onOpen={() => {}} state={openBase} />);
    expect(container.querySelector('.said')).toBeNull();
  });

  it('renders no working/waiting state word when unmatched', () => {
    const { container } = render(<OpenSessionCard onOpen={() => {}} state={openBase} />);
    expect(container.querySelector('.state')).toBeNull();
    expect(container.querySelector('.badge')).toBeNull();
  });

  it('renders no host text when host is null or classifyHost\'s own "unknown"', () => {
    const { container: withNull } = render(
      <OpenSessionCard onOpen={() => {}} state={{ ...openBase, host: null as any }} />);
    expect(withNull.querySelector('.host')).toBeNull();
    const { container: withUnknown } = render(
      <OpenSessionCard onOpen={() => {}} state={{ ...openBase, host: 'unknown' }} />);
    expect(withUnknown.querySelector('.host')).toBeNull();
  });

  // Enrichment (provider/lastProse/events/activity) appears only on a
  // unique transcript match -- src/fleet/state.ts's openSessions doc
  // comment. This is the one fixture in this describe block that sets it.
  describe('enrichment on a unique match', () => {
    const enriched: OpenSession = {
      ...openBase, match: 'unique', sessionId: 's1', provider: 'claude',
      lastProse: 'Reused the JWT helper.', events: 9129, activity: 'working',
    };

    it('shows provider, last prose, events and the working state', () => {
      render(<OpenSessionCard onOpen={() => {}} state={enriched} />);
      expect(screen.getByText('Claude')).toBeTruthy();
      expect(screen.getByText(/Reused the JWT helper/)).toBeTruthy();
      expect(screen.getByText('9,129')).toBeTruthy();
      expect(screen.getByText('working')).toBeTruthy();
    });

    it('shows the blocked badge and wording when the matched session is waiting on the user', () => {
      const { container } = render(<OpenSessionCard onOpen={() => {}}
        state={{ ...enriched, activity: 'waiting_permission' }} />);
      expect(container.querySelector('.badge')).not.toBeNull();
      expect(screen.getByText(/waiting on you/)).toBeTruthy();
    });

    it('includes pid, project, provider, activity and last prose in the accessible name', () => {
      render(<OpenSessionCard onOpen={() => {}} state={enriched} />);
      const card = screen.getByRole('button', { name: /trellome/i });
      const label = card.getAttribute('aria-label') ?? '';
      expect(label).toMatch(/pid 4242/);
      expect(label).toMatch(/Claude/);
      expect(label).toMatch(/working/);
      expect(label).toMatch(/Reused the JWT helper/);
    });
  });
});
