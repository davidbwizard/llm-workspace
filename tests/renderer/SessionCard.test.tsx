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

  // HOST_LABEL is typed Record<string, string> -- an index signature, not a
  // mapped type over HostApp -- so a host value the map doesn't recognise
  // types fine and silently renders nothing without this fallback.
  it('falls back to a labelled placeholder instead of a blank field for an unrecognised host', () => {
    render(<SessionCard onOpen={() => {}} state={{ ...base, host: 'ssh-remote' as any }} />);
    expect(screen.getByText('unknown host')).toBeTruthy();
  });
});
