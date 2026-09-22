import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StackCard, stackSummary } from '../../src/renderer/components/StackCard.tsx';
import type { OpenSession } from '../../src/fleet/state.ts';

// No jest-dom in this project (PromptCard.test.tsx's own note: "grep found
// none", and node_modules/@testing-library has no jest-dom package) -- so
// presence is read with .toBeTruthy()/.toBeNull() and attributes with
// .getAttribute(), the same pattern ConversationView.test.tsx and
// SessionRail.test.tsx already use, not .toBeInTheDocument()/
// .toHaveAttribute(). Declared deviation from the brief's literal test text.

function session(pid: number, activity: OpenSession['activity'], project = 'repo'): OpenSession {
  return { pid, cwd: '/repo', project, activity } as unknown as OpenSession;
}

const members = [session(1, 'waiting_permission'), session(2, 'working'), session(3, 'idle')];

describe('stackSummary', () => {
  it('counts each state it finds, waiting first', () => {
    expect(stackSummary(members)).toBe('1 waiting on you, 1 working, 1 idle');
  });

  it('omits a state with no members', () => {
    expect(stackSummary([session(1, 'working'), session(2, 'working')])).toBe('2 working');
  });

  it('counts both waiting kinds together', () => {
    expect(stackSummary([session(1, 'waiting_permission'), session(2, 'waiting_input')]))
      .toBe('2 waiting on you');
  });
});

describe('StackCard', () => {
  function renderStack(over: Partial<Parameters<typeof StackCard>[0]> = {}) {
    const props = {
      cwd: '/repo', members, open: false, onToggle: vi.fn(), selectedPid: null,
      renderMember: (s: OpenSession) => <div key={s.pid}>member {s.pid}</div>,
      onAnswer: vi.fn(),
      ...over,
    };
    const { container } = render(<StackCard {...props} />);
    return { ...props, container };
  }

  it('names the folder and the member count when folded', () => {
    renderStack();
    expect(screen.getByText('repo')).toBeTruthy();
    expect(screen.getByText('3 sessions')).toBeTruthy();
  });

  it('states what its members are doing when folded', () => {
    renderStack();
    expect(screen.getByText('1 waiting on you, 1 working, 1 idle')).toBeTruthy();
  });

  // Members are ALWAYS mounted now -- a node that does not exist cannot
  // transition from anything. What changes is the `open` class on the root,
  // which is what the stylesheet animates and what hides the subtree from
  // assistive technology while folded. Deliberately NOT toBeVisible(): CSS
  // imports are stubbed under this repo's vitest config, so that matcher
  // would answer "visible" in both states and prove nothing. The rules
  // themselves are pinned in StackCard.css.test.ts.
  it('keeps its members mounted in both states, so the height can transition', () => {
    const { rerender, container } = render(
      <StackCard cwd="/repo" members={members} open={false} onToggle={vi.fn()}
        selectedPid={null} renderMember={s => <div>member {s.pid}</div>} />,
    );
    expect(screen.getByText('member 1')).toBeTruthy();
    expect(container.querySelector('.stack.open')).toBeNull();
    rerender(
      <StackCard cwd="/repo" members={members} open={true} onToggle={vi.fn()}
        selectedPid={null} renderMember={s => <div>member {s.pid}</div>} />,
    );
    expect(screen.getByText('member 1')).toBeTruthy();
    expect(container.querySelector('.stack.open')).not.toBeNull();
  });

  it('wraps each member in its own stagger slot, indexed in order', () => {
    const { container } = render(
      <StackCard cwd="/repo" members={members} open={true} onToggle={vi.fn()}
        selectedPid={null} renderMember={s => <div>member {s.pid}</div>} />,
    );
    const slots = [...container.querySelectorAll('.stackmember')];
    expect(slots).toHaveLength(3);
    expect(slots.map(el => (el as HTMLElement).style.getPropertyValue('--i'))).toEqual(['0', '1', '2']);
  });

  it('marks the chevron decorative, since the toggle already names itself', () => {
    const { container } = render(
      <StackCard cwd="/repo" members={members} open={false} onToggle={vi.fn()}
        selectedPid={null} renderMember={() => null} />,
    );
    expect(container.querySelector('.stackchev')!.getAttribute('aria-hidden')).toBe('true');
  });

  // getByRole('button', { name: /repo/i }) (the brief's literal query) is
  // ambiguous once the face's Answer button renders: exactly one member is
  // waiting in the default fixture, so "Answer repo, pid 1" also matches
  // /repo/i, and getByRole throws "found multiple elements". The toggle's
  // own class is unambiguous and is already how this file identifies the
  // root ('.stack.open') and other structural pieces. Declared deviation.
  it('reports its folded state to assistive technology', () => {
    const { container } = renderStack();
    expect(container.querySelector('.stacktoggle')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('calls onToggle with the folder when the face is clicked', () => {
    const props = renderStack();
    fireEvent.click(props.container.querySelector('.stacktoggle')!);
    expect(props.onToggle).toHaveBeenCalledWith('/repo');
  });

  it('offers Answer on the face when exactly one member is waiting', () => {
    const props = renderStack();
    fireEvent.click(screen.getByRole('button', { name: /^Answer repo, pid 1$/ }));
    expect(props.onAnswer).toHaveBeenCalledWith(1);
  });

  it('offers no Answer button when two members are waiting, because which one is ambiguous', () => {
    renderStack({ members: [session(1, 'waiting_permission'), session(2, 'waiting_input')] });
    expect(screen.queryByRole('button', { name: /^Answer/ })).toBeNull();
  });

  it('carries the attention treatment while any member waits', () => {
    const { container } = render(
      <StackCard cwd="/repo" members={members} open={false} onToggle={vi.fn()}
        selectedPid={null} renderMember={() => null} />,
    );
    expect(container.querySelector('.stack.attn')).not.toBeNull();
  });

  it('drops the attention treatment when nothing waits', () => {
    const { container } = render(
      <StackCard cwd="/repo" members={[session(1, 'idle')]} open={false} onToggle={vi.fn()}
        selectedPid={null} renderMember={() => null} />,
    );
    expect(container.querySelector('.stack.attn')).toBeNull();
  });
});
