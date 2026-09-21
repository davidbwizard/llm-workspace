import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { DependencyChecks } from '../../src/renderer/components/DependencyChecks.tsx';
import { FirstRun } from '../../src/renderer/components/FirstRun.tsx';
import type { CheckState, DependencyCheck, Readiness } from '../../src/main/checks.ts';

afterEach(cleanup);

function check(id: 'tmux' | 'claude' | 'codex', state: CheckState, over: Partial<DependencyCheck> = {}): DependencyCheck {
  const name = { tmux: 'tmux', claude: 'Claude Code', codex: 'Codex' }[id];
  return {
    id, name, state,
    version: state === 'ok' ? '1.2.3' : null,
    purpose: `What ${name} is for.`,
    install: `brew install ${id}`,
    doctor: null,
    detail: `${name} detail for ${state}.`,
    ...over,
  };
}

function readiness(checks: DependencyCheck[], over: Partial<Readiness> = {}): Readiness {
  const cap = (available: boolean, reason: string | null = null) => ({ available, reason, warning: null });
  return {
    checkedAt: '2026-09-21T12:00:00.000Z',
    checks,
    launch: { claude: cap(true), codex: cap(true) },
    attach: cap(true),
    history: cap(true),
    ...over,
  };
}

const panel = (r: Readiness | null, over: Partial<Parameters<typeof DependencyChecks>[0]> = {}) =>
  render(<DependencyChecks status={r ? 'ready' : 'running'} readiness={r} recheck={() => {}} rechecking={false} {...over} />);

describe('every state gets its own words', () => {
  // The four outcomes main keeps apart must stay apart on screen. A screen
  // that says "not installed" about a broken install sends someone to
  // install something they already have.
  it.each([
    ['ok', 'Ready'],
    ['unhealthy', 'Needs attention'],
    ['missing', 'Not installed'],
    ['timeout', 'No answer'],
  ] as const)('labels %s as "%s"', (state, label) => {
    panel(readiness([check('tmux', state), check('claude', 'ok'), check('codex', 'ok')]));
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  });

  it('shows main\'s own sentence for the state, not one of its own', () => {
    panel(readiness([check('tmux', 'missing'), check('claude', 'ok'), check('codex', 'ok')]));
    expect(screen.getByText('tmux detail for missing.')).toBeTruthy();
  });

  it('shows a version when there is one', () => {
    panel(readiness([check('tmux', 'ok'), check('claude', 'ok'), check('codex', 'ok')]));
    expect(screen.getAllByText('1.2.3').length).toBe(3);
  });
});

describe('the app installs nothing', () => {
  // Design §5. The command is text with a copy button, and nothing in the
  // renderer can run it -- there is no channel that would.
  it('shows the exact command for something missing', () => {
    panel(readiness([check('tmux', 'missing'), check('claude', 'ok'), check('codex', 'ok')]));
    expect(screen.getByText('brew install tmux')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });

  it('shows no command for something that is already fine', () => {
    panel(readiness([check('tmux', 'ok'), check('claude', 'ok'), check('codex', 'ok')]));
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
  });

  it('copies the command to the clipboard, and nothing else happens', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    panel(readiness([check('tmux', 'missing'), check('claude', 'ok'), check('codex', 'ok')]));
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('brew install tmux');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());
  });

  it('survives a clipboard that is absent or refuses', () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    panel(readiness([check('tmux', 'missing'), check('claude', 'ok'), check('codex', 'ok')]));
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    // The command itself is still on screen to select by hand.
    expect(screen.getByText('brew install tmux')).toBeTruthy();
  });
});

describe('doctor is handed over, never interpreted', () => {
  it('shows doctor output verbatim when something is wrong', () => {
    panel(readiness([
      check('tmux', 'ok'),
      check('claude', 'unhealthy', {
        doctor: { state: 'unhealthy', exitCode: 1, output: 'Auto-updates: failing\nPath: /somewhere' },
      }),
      check('codex', 'ok'),
    ]));
    fireEvent.click(screen.getByRole('button', { name: /what Claude Code reported/ }));
    expect(screen.getByText(/Auto-updates: failing/)).toBeTruthy();
  });

  it('does not put doctor output on screen for a healthy tool', () => {
    panel(readiness([
      check('tmux', 'ok'),
      check('claude', 'ok', { doctor: { state: 'ok', exitCode: 0, output: 'No installation issues found.' } }),
      check('codex', 'ok'),
    ]));
    expect(screen.queryByText(/what Claude Code reported/)).toBeNull();
  });
});

describe('what a missing tool costs, said out loud', () => {
  // Design §4: disabled WITH a reason, never hidden -- and never "the app
  // cannot run".
  it('names each capability that is off, and why', () => {
    panel(readiness(
      [check('tmux', 'missing'), check('claude', 'ok'), check('codex', 'ok')],
      {
        attach: { available: false, reason: 'tmux is not installed.', warning: null },
        launch: {
          claude: { available: false, reason: 'tmux is not installed.', warning: null },
          codex: { available: false, reason: 'tmux is not installed.', warning: null },
        },
      },
    ));
    expect(screen.getByText(/Starting and attaching to sessions/)).toBeTruthy();
    expect(screen.getByText(/Launching Claude/)).toBeTruthy();
  });

  it('says history is still readable, so nothing reads as "the app is broken"', () => {
    panel(readiness(
      [check('tmux', 'missing'), check('claude', 'ok'), check('codex', 'ok')],
      { attach: { available: false, reason: 'tmux is not installed.', warning: null } },
    ));
    expect(screen.getByText(/still browse your history/)).toBeTruthy();
  });

  it('says nothing about capabilities when everything works', () => {
    panel(readiness([check('tmux', 'ok'), check('claude', 'ok'), check('codex', 'ok')]));
    expect(screen.queryByText(/Turned off for now/)).toBeNull();
  });
});

describe('Check again', () => {
  // Design §5: re-runs without a restart, so a person can fix something in
  // a terminal and carry on.
  it('re-runs on demand', () => {
    const recheck = vi.fn();
    panel(readiness([check('tmux', 'ok'), check('claude', 'ok'), check('codex', 'ok')]), { recheck });
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(recheck).toHaveBeenCalled();
  });

  it('cannot be fired twice while a run is in flight', () => {
    const recheck = vi.fn();
    panel(readiness([check('tmux', 'ok'), check('claude', 'ok'), check('codex', 'ok')]),
      { recheck, rechecking: true });
    const button = screen.getByRole('button', { name: 'Checking…' });
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('says it is still checking rather than showing an empty list', () => {
    panel(null);
    expect(screen.getByText(/Checking what is installed/)).toBeTruthy();
  });

  it('says so when the checks could not be run at all', () => {
    panel(null, { status: 'unavailable' });
    expect(screen.getByRole('alert').textContent).toMatch(/could not run these checks/);
  });
});

describe('the first-run surface', () => {
  let checksGet: ReturnType<typeof vi.fn>;

  const mount = (r: Readiness) => {
    checksGet = vi.fn(async () => ({ status: 'ready' as const, readiness: r }));
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      checksGet, checksRun: vi.fn(), onChecks: () => () => {},
    };
    return render(<FirstRun />);
  };

  beforeEach(() => {
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = undefined;
  });

  // A machine where everything is installed must never see a "welcome"
  // step to click through.
  it('renders nothing at all when every dependency is fine', async () => {
    const { container } = mount(readiness([check('tmux', 'ok'), check('claude', 'ok'), check('codex', 'ok')]));
    await waitFor(() => expect(checksGet).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('appears, and names the problem, when something is missing', async () => {
    mount(readiness([check('tmux', 'missing'), check('claude', 'ok'), check('codex', 'ok')]));
    await waitFor(() => expect(screen.getByText('tmux needs attention')).toBeTruthy());
  });

  it('counts them when more than one is wrong', async () => {
    mount(readiness([check('tmux', 'missing'), check('claude', 'unhealthy'), check('codex', 'ok')]));
    await waitFor(() => expect(screen.getByText('2 things need attention')).toBeTruthy());
  });

  it('can be hidden, and says where to find it again', async () => {
    const { container } = mount(readiness([check('tmux', 'missing'), check('claude', 'ok'), check('codex', 'ok')]));
    await waitFor(() => expect(screen.getByText(/What this app needs/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Hide for now' }));
    expect(container.textContent).toBe('');
  });

  it('stays silent while the first sweep is still running', () => {
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      checksGet: vi.fn(async () => ({ status: 'running' as const })),
      checksRun: vi.fn(),
      onChecks: () => () => {},
    };
    const { container } = render(<FirstRun />);
    expect(container.textContent).toBe('');
  });
});
