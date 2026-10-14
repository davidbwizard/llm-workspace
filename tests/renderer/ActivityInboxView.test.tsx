import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ActivityInbox, InboxNav } from '../../src/renderer/components/ActivityInbox.tsx';
describe('ActivityInbox', () => {
  it('shows concrete session identity and opens the waiting session without a dismiss control', () => {
    const session = { pid: 4, provider: 'codex', sessionId: 's', cwd: '/a/project', name: 'Fix permissions', activity: 'waiting_permission', lastProse: 'Allow the command?' };
    const open = vi.fn(); render(<ActivityInbox kind="needs-you" items={[{ key: 's', session, waitingSince: 1000, snippet: session.lastProse }]} onOpen={open} />);
    expect(screen.getByRole('heading', { name: 'Fix permissions' })).toBeTruthy(); expect(screen.getByText(/project/)).toBeTruthy(); expect(screen.getByText(/First seen/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Review/ })); expect(open).toHaveBeenCalledWith(session);
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
  });
  it('exposes separate accessible counted inbox navigation without taking session hotkeys', () => {
    const change = vi.fn(); render(<InboxNav active="fleet" needsCount={2} updatesCount={3} onChange={change} />);
    fireEvent.click(screen.getByRole('button', { name: 'Needs you (2)' })); expect(change).toHaveBeenCalledWith('needs-you');
    expect(screen.getByRole('button', { name: 'Updates (3)' }).getAttribute('aria-keyshortcuts')).toBeNull();
  });
});
