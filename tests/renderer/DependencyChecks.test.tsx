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
    install: [{ command: `brew install ${id}`, requires: 'homebrew', note: null }],
    probe: `${id} --version`,
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
    homebrew: true,
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

// The lead's question, 2026-09-21: can a `timeout` be mistaken for a
// `missing` anywhere in the UI text? These pin the answer.
describe('"no answer" never reads as "not installed"', () => {
  const timedOut = () => panel(readiness(
    [check('tmux', 'timeout'), check('claude', 'ok'), check('codex', 'ok')],
  ));

  // The blur this closes: a timed-out tool used to be offered an install
  // command. If it is installed and merely wedged, `brew install tmux` is a
  // guess dressed as a remedy -- and printing it under "No answer" is
  // exactly how a timeout gets read as absent.
  it('offers no install command for a tool that simply did not answer', () => {
    timedOut();
    expect(screen.queryByText('brew install tmux')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
  });

  it('says outright that it is not the same as missing', () => {
    timedOut();
    expect(screen.getByText(/does not mean tmux is missing/)).toBeTruthy();
  });

  it('hands over the command the app itself ran, so they can settle it', () => {
    timedOut();
    expect(screen.getByText('tmux --version')).toBeTruthy();
  });

  it('gives a missing tool the install command, and a timed-out one none', () => {
    panel(readiness([check('tmux', 'missing'), check('claude', 'timeout'), check('codex', 'ok')]));
    expect(screen.getByText('brew install tmux')).toBeTruthy();
    expect(screen.queryByText('brew install claude')).toBeNull();
  });

  // Nothing on screen may collapse the four into fewer. The labels, and the
  // sentences main writes, must all differ.
  it('renders four distinct labels for the four states', () => {
    const { container } = panel(readiness([
      check('tmux', 'ok'), check('claude', 'unhealthy'), check('codex', 'missing'),
    ]));
    const labels = [...container.querySelectorAll('.checkstate')].map(el => el.textContent);
    expect(new Set(labels).size).toBe(3);
    expect(labels).toEqual(['Ready', 'Needs attention', 'Not installed']);
    // And the fourth is its own word, not a synonym of any of them.
    expect(labels).not.toContain('No answer');
  });

  it('marks missing and timeout with different emphasis, not the same one', () => {
    const { container } = panel(readiness([
      check('tmux', 'missing'), check('claude', 'timeout'), check('codex', 'ok'),
    ]));
    const rows = [...container.querySelectorAll('.checkrow')];
    expect(rows[0]!.getAttribute('data-state')).toBe('missing');
    expect(rows[1]!.getAttribute('data-state')).toBe('timeout');
    const cls = rows.map(r => r.querySelector('.checkstate')!.className);
    expect(cls[0]).not.toBe(cls[1]);
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

// A command starting `brew` is useless to someone without Homebrew, and
// printing it as though it would work is the kind of small dishonesty that
// makes a first-run screen untrustworthy.
describe('advice a machine can actually act on', () => {
  it('shows the brew command plainly when the Mac has Homebrew', () => {
    panel(readiness([check('tmux', 'missing'), check('claude', 'ok'), check('codex', 'ok')]));
    expect(screen.getByText('brew install tmux')).toBeTruthy();
    expect(screen.queryByText(/does not have/)).toBeNull();
  });

  it('says what is needed first when the Mac has no Homebrew', () => {
    panel(readiness(
      [check('tmux', 'missing'), check('claude', 'ok'), check('codex', 'ok')],
      { homebrew: false },
    ));
    expect(screen.getByText(/needs Homebrew, which this Mac[\s\S]*does not have/)).toBeTruthy();
    // The command is still shown -- hiding it teaches nothing -- just
    // captioned with what it needs first.
    expect(screen.getByText('brew install tmux')).toBeTruthy();
  });

  it('links to Homebrew rather than printing its pipe-to-shell installer', () => {
    panel(readiness(
      [check('tmux', 'missing'), check('claude', 'ok'), check('codex', 'ok')],
      { homebrew: false },
    ));
    const link = screen.getByRole('link', { name: /brew\.sh/ });
    expect(link.getAttribute('href')).toBe('https://brew.sh');
    // Nothing on screen pipes a download into a shell.
    expect(document.body.textContent).not.toMatch(/\|\s*(ba)?sh\b/);
  });

  it('prefers the route that works, when one of them does not need Homebrew', () => {
    const claude = check('claude', 'missing', {
      install: [
        { command: 'brew install --cask claude-code', requires: 'homebrew', note: null },
        { command: 'npm install -g @anthropic-ai/claude-code', requires: null, note: 'Needs Node.js 22 or later.' },
      ],
    });
    panel(readiness([check('tmux', 'ok'), claude, check('codex', 'ok')], { homebrew: false }));
    // The npm route stands on its own, so it is shown and the brew one is
    // not -- and there is no caveat, because there is nothing to caveat.
    expect(screen.getByText('npm install -g @anthropic-ai/claude-code')).toBeTruthy();
    expect(screen.queryByText('brew install --cask claude-code')).toBeNull();
    expect(screen.queryByText(/does not have/)).toBeNull();
  });

  it('shows a route\'s prerequisite note', () => {
    const claude = check('claude', 'missing', {
      install: [{ command: 'npm install -g @anthropic-ai/claude-code', requires: null, note: 'Needs Node.js 22 or later.' }],
    });
    panel(readiness([check('tmux', 'ok'), claude, check('codex', 'ok')]));
    expect(screen.getByText('Needs Node.js 22 or later.')).toBeTruthy();
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
