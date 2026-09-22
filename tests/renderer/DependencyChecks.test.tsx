import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { DependencyChecks, CheckAgain } from '../../src/renderer/components/DependencyChecks.tsx';
import { FirstRun, shouldTakeOver, continueLabel, headline } from '../../src/renderer/components/FirstRun.tsx';
import type { ChecksStatus, ChecksView } from '../../src/renderer/state/useChecks.ts';
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

function panel(r: Readiness | null, over: Partial<Parameters<typeof DependencyChecks>[0]> = {}) {
  const props = { status: (r ? 'ready' : 'running') as ChecksStatus, readiness: r, recheck: () => {}, rechecking: false, ...over };
  return render(
    <>
      <DependencyChecks {...props} />
      <CheckAgain recheck={props.recheck} rechecking={props.rechecking} />
    </>,
  );
}

describe('every state gets its own words', () => {
  // The four outcomes main keeps apart must stay apart on screen. A screen
  // that says "not installed" about a broken install sends someone to
  // install something they already have.
  it.each([
    ['ok', 'Found'],
    ['unhealthy', 'Needs attention'],
    ['missing', 'Missing'],
    ['timeout', 'No answer'],
  ] as const)('gives %s the accessible name "%s"', (state, name) => {
    panel(readiness([check('tmux', state), check('claude', 'ok'), check('codex', 'ok')]));
    expect(screen.getAllByRole('img', { name }).length).toBeGreaterThan(0);
  });

  it('shows main\'s own sentence for the state, not one of its own', () => {
    panel(readiness([check('tmux', 'missing'), check('claude', 'ok'), check('codex', 'ok')]));
    expect(screen.getByText('tmux detail for missing.')).toBeTruthy();
  });

  it('says nothing about state on a row that is fine -- the mark already does', () => {
    panel(readiness([check('tmux', 'ok'), check('claude', 'ok'), check('codex', 'ok')]));
    expect(screen.queryByText('tmux detail for ok.')).toBeNull();
    // But it still says what the thing is for.
    expect(screen.getByText(/What tmux is for/)).toBeTruthy();
  });

  it('shows a version when there is one', () => {
    panel(readiness([check('tmux', 'ok'), check('claude', 'ok'), check('codex', 'ok')]));
    expect(screen.getAllByText('1.2.3').length).toBe(3);
  });

  // Colour is the second carrier, never the only one: the marks differ in
  // shape so the list still works in greyscale.
  it('draws a different shape per mark, not just a different colour', () => {
    const { container } = panel(readiness([
      check('tmux', 'ok'), check('claude', 'missing'), check('codex', 'unhealthy'),
    ]));
    const marks = [...container.querySelectorAll('.mk')];
    const shapes = marks.map(m => m.innerHTML);
    expect(new Set(shapes).size).toBe(3);
    // And each carries a real name, since a path tells a screen reader
    // nothing.
    for (const m of marks) expect(m.getAttribute('aria-label')).toBeTruthy();
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
    expect(screen.queryByRole('button', { name: /^Copy / })).toBeNull();
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
  it('names the four states four different things', () => {
    const names = ['Found', 'Missing', 'Needs attention', 'No answer'];
    expect(new Set(names).size).toBe(4);
    panel(readiness([check('tmux', 'ok'), check('claude', 'unhealthy'), check('codex', 'missing')]));
    for (const n of ['Found', 'Needs attention', 'Missing']) {
      expect(screen.getAllByRole('img', { name: n }).length).toBeGreaterThan(0);
    }
    expect(screen.queryByRole('img', { name: 'No answer' })).toBeNull();
  });

  // The critical-toned row is for MISSING alone. A timed-out tool is
  // present, and dressing it as absent would undo the distinction.
  it('gives the missing row the critical tone and the timed-out row none', () => {
    const { container } = panel(readiness([
      check('tmux', 'missing'), check('claude', 'timeout'), check('codex', 'ok'),
    ]));
    const rows = [...container.querySelectorAll('.dep')];
    expect(rows[0]!.className).toContain('bad');
    expect(rows[1]!.className).not.toContain('bad');
    expect(rows[1]!.getAttribute('data-state')).toBe('timeout');
    // And they wear different marks.
    expect(rows[0]!.querySelector('.mk')!.getAttribute('class')).toContain('miss');
    expect(rows[1]!.querySelector('.mk')!.getAttribute('class')).toContain('warn');
  });
});

describe('the app installs nothing', () => {
  // Design §5. The command is text with a copy button, and nothing in the
  // renderer can run it -- there is no channel that would.
  it('shows the exact command for something missing', () => {
    panel(readiness([check('tmux', 'missing'), check('claude', 'ok'), check('codex', 'ok')]));
    expect(screen.getByText('brew install tmux')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy brew install tmux' })).toBeTruthy();
  });

  it('shows no command for something that is already fine', () => {
    panel(readiness([check('tmux', 'ok'), check('claude', 'ok'), check('codex', 'ok')]));
    expect(screen.queryByRole('button', { name: /^Copy / })).toBeNull();
  });

  it('copies the command to the clipboard, and nothing else happens', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    panel(readiness([check('tmux', 'missing'), check('claude', 'ok'), check('codex', 'ok')]));
    fireEvent.click(screen.getByRole('button', { name: 'Copy brew install tmux' }));
    // The write is deferred by a microtask on purpose (state/useCopy.ts):
    // a clipboard accessor that THROWS rather than rejecting has to land in
    // the same failure path, so it is wrapped in a resolved promise.
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('brew install tmux'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());
  });

  // Never a false "Copied": someone who believes the command is on their
  // clipboard and pastes nothing is worse off than someone told plainly.
  it('says it failed when the clipboard refuses, rather than claiming success', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    panel(readiness([check('tmux', 'missing'), check('claude', 'ok'), check('codex', 'ok')]));
    fireEvent.click(screen.getByRole('button', { name: 'Copy brew install tmux' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy failed' })).toBeTruthy());
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

// The takeover rule. The mockup does not answer when this screen appears,
// and getting it wrong means a wall between someone and the app they just
// opened -- so the rule is a pure function and these are its statement.
describe('when the first-run screen takes the window over', () => {
  const problem = (over: Partial<Readiness> = {}) => readiness(
    [check('tmux', 'ok'), check('claude', 'missing'), check('codex', 'ok')], over,
  );
  const allWell = () => readiness([check('tmux', 'ok'), check('claude', 'ok'), check('codex', 'ok')]);
  const noTmux = () => readiness(
    [check('tmux', 'missing'), check('claude', 'ok'), check('codex', 'ok')],
    { attach: { available: false, reason: 'tmux is not installed.', warning: null } },
  );

  // Rule 4: there is no welcome step to click through on a machine where
  // everything is already installed.
  it('never appears when everything is installed, not even the first time', () => {
    expect(shouldTakeOver(allWell(), false)).toBe(false);
    expect(shouldTakeOver(allWell(), true)).toBe(false);
  });

  // Rule 1.
  it('appears on the first run when something is wrong', () => {
    expect(shouldTakeOver(problem(), false)).toBe(true);
  });

  // Rule 3, the one that follows from design §4 rather than the mockup: a
  // missing tool costs one capability, not the app. Someone who chose to
  // run without Codex must not be walled every launch for it.
  it('does not appear again once they have continued past it', () => {
    expect(shouldTakeOver(problem(), true)).toBe(false);
  });

  // Rule 2: without tmux nothing can be launched or attached, so the
  // normal window would be a set of controls that all refuse.
  it('appears every launch when the core is gone, even after continuing', () => {
    expect(shouldTakeOver(noTmux(), true)).toBe(true);
  });

  // While a sweep is running the app stays quiet rather than flashing a
  // wall that vanishes a moment later -- a full sweep is ~11s.
  it('stays out of the way until a sweep has actually finished', () => {
    expect(shouldTakeOver(null, false)).toBe(false);
    expect(shouldTakeOver(null, true)).toBe(false);
  });
});

describe('what the first-run screen says', () => {
  const withProblems = (...states: (CheckState | undefined)[]) => readiness([
    check('tmux', states[0] ?? 'ok'),
    check('claude', states[1] ?? 'ok'),
    check('codex', states[2] ?? 'ok'),
  ]);

  it('counts rather than asserting, so the heading is never wrong', () => {
    expect(headline(withProblems('missing'))).toBe('One thing to install first');
    expect(headline(withProblems('missing', 'missing'))).toBe('Two things to install first');
  });

  it('does not say "install" about something that is installed but unwell', () => {
    expect(headline(withProblems('unhealthy'))).toBe('One thing needs attention');
    expect(headline(withProblems('missing', 'unhealthy'))).toBe('2 things need attention');
  });

  // The mockup's quiet button names what you are continuing without, which
  // only works while there is one of them.
  it('names the one thing you are continuing without', () => {
    expect(continueLabel(withProblems(undefined, 'missing'))).toBe('Continue without Claude Code');
  });

  it('stops naming them once there are several', () => {
    expect(continueLabel(withProblems('missing', 'missing'))).toBe('Continue anyway');
  });
});

describe('the first-run screen, rendered', () => {
  const view = (r: Readiness | null, over: Partial<ChecksView> = {}): ChecksView => ({
    status: r ? 'ready' : 'running', readiness: r, recheck: () => {}, rechecking: false, ...over,
  });

  it('shows the list, the two actions and where to find it again', () => {
    render(<FirstRun checks={view(readiness([
      check('tmux', 'ok'), check('claude', 'missing'), check('codex', 'ok'),
    ]))} onContinue={() => {}} />);
    expect(screen.getByText('One thing to install first')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue without Claude Code' })).toBeTruthy();
    expect(screen.getByText(/reopen this from Settings/)).toBeTruthy();
    expect(screen.getByText('brew install claude')).toBeTruthy();
  });

  it('continues when asked, whatever is missing -- Continue always works', () => {
    const onContinue = vi.fn();
    render(<FirstRun checks={view(readiness(
      [check('tmux', 'missing'), check('claude', 'ok'), check('codex', 'ok')],
      { attach: { available: false, reason: 'tmux is not installed.', warning: null } },
    ))} onContinue={onContinue} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue without tmux' }));
    expect(onContinue).toHaveBeenCalled();
  });

  it('re-runs the checks from its own primary button', () => {
    const recheck = vi.fn();
    render(<FirstRun checks={view(readiness([
      check('tmux', 'missing'), check('claude', 'ok'), check('codex', 'ok'),
    ]), { recheck })} onContinue={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(recheck).toHaveBeenCalled();
  });

  it('renders nothing before a sweep has landed', () => {
    const { container } = render(<FirstRun checks={view(null)} onContinue={() => {}} />);
    expect(container.textContent).toBe('');
  });
});
