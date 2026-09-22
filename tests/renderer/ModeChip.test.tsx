import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ModeChip } from '../../src/renderer/components/ModeChip.tsx';
import type { SessionMode } from '../../src/renderer/state/useSessionLive.ts';

/** The chip. Spec: docs/superpowers/specs/2026-09-21-mode-switcher-design.md
 *  §2, §3.2 and §4.1.
 *
 *  Layout and colour cannot be asserted here -- jsdom computes no layout
 *  and loads no stylesheet -- so the CSS is checked separately
 *  (ModeChip.css.test.ts) and the look still needs a pair of eyes. What
 *  IS asserted here is the behaviour: which menu each provider gets, what
 *  is sent, and everything that must NOT happen. */

const PID = 4242;

function state(o: Partial<SessionMode> = {}): SessionMode {
  return { provider: 'claude', mode: 'manual', blocked: null, ...o };
}

function bridge(setMode = vi.fn().mockResolvedValue({ status: 'set', mode: 'plan' })) {
  (globalThis as unknown as { window: { fleet?: unknown } }).window.fleet = { setMode };
  return setMode;
}

afterEach(() => {
  delete (globalThis as unknown as { window: { fleet?: unknown } }).window.fleet;
});

describe('ModeChip: what it shows', () => {
  it('shows the current mode by name', () => {
    render(<ModeChip pid={PID} state={state({ mode: 'acceptEdits' })} onOpenTerminal={() => {}} />);
    expect(screen.getByRole('button').textContent).toContain('Accept edits');
  });

  // Converted from 'renders nothing at all when the mode is unknown'
  // (2026-09-22). §5's rule is unchanged and still pinned below -- the chip
  // must never NAME a mode it does not know, because claiming "Manual" on a
  // session that is actually on Auto is the worst failure this feature has.
  // What changed is the other half: a control that vanishes teaches nothing,
  // so the chip now stays put, disabled, saying why. The label reads "Mode":
  // it names the control without asserting any state.
  it('stays put with an honest label, rather than vanishing, when the mode is unknown', () => {
    render(
      <ModeChip pid={PID} state={state({ mode: null, blocked: 'unreadable' })} onOpenTerminal={() => {}} />,
    );
    const chip = screen.getByRole('button') as HTMLButtonElement;
    expect(chip.textContent).toContain('Mode');
    expect(chip.disabled).toBe(true);
    expect(chip.getAttribute('title')).toBe('Could not read the mode from the session');
  });

  it('names no mode at all when it does not know one', () => {
    render(<ModeChip pid={PID} state={state({ mode: null, blocked: 'unreadable' })} onOpenTerminal={() => {}} />);
    const chip = screen.getByRole('button');
    for (const name of ['Manual', 'Accept edits', 'Plan', 'Auto', 'Default']) {
      expect(chip.textContent).not.toContain(name);
    }
    expect(chip.getAttribute('aria-label')).not.toMatch(/Manual|Accept edits|Plan|Auto|Default/);
  });

  // The one case that still draws nothing, and the reason it must: this is
  // the pane before its first live push, when the app has not yet asked. A
  // disabled chip here would claim a fact ("no mode") that nobody has
  // established. .convfoot:empty collapses the row until the push lands.
  it('renders nothing when there is no chip state at all', () => {
    const { container } = render(<ModeChip pid={PID} state={null} onOpenTerminal={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  // §2: colour by mode, so the state reads without the word. The attribute
  // is what the stylesheet keys on; the colour itself is CSS.
  it.each([
    ['manual', 'manual'],
    ['acceptEdits', 'edits'],
    ['plan', 'plan'],
    ['auto', 'auto'],
    ['default', 'manual'],
  ] as const)('marks %s with the %s colour slot', (mode, tone) => {
    const provider = mode === 'default' ? 'codex' : 'claude';
    const { container } = render(
      <ModeChip pid={PID} state={state({ provider, mode })} onOpenTerminal={() => {}} />,
    );
    expect(container.querySelector('.modechip')!.getAttribute('data-mode')).toBe(tone);
  });

  // A fifth slot, for the chip that names no mode: it has to resolve to a
  // real --m/--m-soft pair or the pill loses its colour entirely (the vars
  // would be undefined). Neutral, like the ask-first mode -- it is not a
  // warning, it is an absence. ModeChip.css.test.ts pins the tokens.
  it('takes a neutral colour slot when there is no mode to colour', () => {
    const { container } = render(
      <ModeChip pid={PID} state={state({ mode: null, blocked: 'not_tmux' })} onOpenTerminal={() => {}} />,
    );
    expect(container.querySelector('.modechip')!.getAttribute('data-mode')).toBe('unknown');
  });
});

describe('ModeChip: the menu is built per provider', () => {
  it("offers Claude's four modes and no link out", () => {
    render(<ModeChip pid={PID} state={state()} onOpenTerminal={() => {}} />);
    fireEvent.click(screen.getByRole('button'));
    const rows = screen.getAllByRole('menuitemradio');
    expect(rows.map(r => r.querySelector('span')!.textContent))
      .toEqual(['Manual', 'Accept edits', 'Plan', 'Auto']);
    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  it("offers Codex's two modes plus Permissions…, and never Claude's", () => {
    render(<ModeChip pid={PID} state={state({ provider: 'codex', mode: 'default' })} onOpenTerminal={() => {}} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getAllByRole('menuitemradio').map(r => r.querySelector('span')!.textContent))
      .toEqual(['Default', 'Plan']);
    expect(screen.getByRole('menuitem').textContent).toContain('Permissions');
    expect(screen.queryByText('Accept edits')).toBeNull();
    expect(screen.queryByText('Auto')).toBeNull();
  });

  // §3.2: "The menu states, in words, that Plan also lowers the model's
  // effort. A person who is never told will only notice it in the bill or
  // in weaker output."
  it("says in words that Codex's Plan lowers the model's effort", () => {
    render(<ModeChip pid={PID} state={state({ provider: 'codex', mode: 'default' })} onOpenTerminal={() => {}} />);
    fireEvent.click(screen.getByRole('button'));
    const plan = screen.getAllByRole('menuitemradio')[1]!;
    expect(plan.textContent).toMatch(/lowers the model.s reasoning effort/i);
    expect(plan.textContent).toContain('xhigh');
    expect(plan.textContent).toContain('medium');
  });

  it('marks the current mode, and only it', () => {
    render(<ModeChip pid={PID} state={state({ mode: 'plan' })} onOpenTerminal={() => {}} />);
    fireEvent.click(screen.getByRole('button'));
    const checked = screen.getAllByRole('menuitemradio').filter(r => r.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0]!.textContent).toContain('Plan');
  });
});

describe('ModeChip: switching', () => {
  it('sends the pid and the mode, and nothing else', async () => {
    const setMode = bridge();
    render(<ModeChip pid={PID} state={state()} onOpenTerminal={() => {}} />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getAllByRole('menuitemradio')[2]!); // Plan
    await waitFor(() => expect(setMode).toHaveBeenCalledWith(PID, 'plan'));
    expect(setMode.mock.calls).toHaveLength(1);
  });

  it('closes the menu on a pick', async () => {
    bridge();
    render(<ModeChip pid={PID} state={state()} onOpenTerminal={() => {}} />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getAllByRole('menuitemradio')[2]!);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  // §7.2: switching into Claude's Auto happens on the click, with no "are
  // you sure". What carries the weight instead is the --critical colour
  // and the menu entry's own words.
  it('switches into Auto on the click, with no confirmation step', async () => {
    const setMode = bridge();
    render(<ModeChip pid={PID} state={state()} onOpenTerminal={() => {}} />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getAllByRole('menuitemradio')[3]!); // Auto
    await waitFor(() => expect(setMode).toHaveBeenCalledWith(PID, 'auto'));
  });

  // Converted 2026-09-22 from the same test driven with reason 'busy',
  // which main can no longer return: the reason is now one main still
  // gives. What it pins is unchanged -- a refusal is shown, never swallowed.
  it('shows the refusal main gave, rather than pretending the mode changed', async () => {
    bridge(vi.fn().mockResolvedValue({ status: 'refused', reason: 'prompt_open' }));
    render(<ModeChip pid={PID} state={state()} onOpenTerminal={() => {}} />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getAllByRole('menuitemradio')[2]!);
    expect((await screen.findByRole('status')).textContent).toBe('Answer the prompt above first.');
  });

  it('says so, and never silently, when the bridge rejects', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    bridge(vi.fn().mockRejectedValue(new Error('no handler')));
    render(<ModeChip pid={PID} state={state()} onOpenTerminal={() => {}} />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getAllByRole('menuitemradio')[2]!);
    expect((await screen.findByRole('status')).textContent).toBe('Could not reach the app.');
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  // §3.2: the Permissions… item ONLY opens the session in the terminal.
  // The app does not type /permissions and does not drive that menu.
  it('opens the terminal for Permissions…, and sends no key', () => {
    const setMode = bridge();
    const onOpenTerminal = vi.fn();
    render(<ModeChip pid={PID} state={state({ provider: 'codex', mode: 'default' })} onOpenTerminal={onOpenTerminal} />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('menuitem'));
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
    expect(setMode).not.toHaveBeenCalled();
  });
});

describe('ModeChip: when it refuses to open at all', () => {
  // Converted 2026-09-22. The 'busy' row is gone: being mid-turn no longer
  // blocks the switch at all (main/mode.ts §4 -- Shift+Tab was measured to
  // be honoured mid-turn), and the type no longer carries the value. Its
  // place is taken by the three cases that used to make the chip VANISH,
  // and now disable it instead, `not_tmux` being the common one: a session
  // David started in iTerm or VS Code, with no pane to read a mode from.
  it.each([
    ['prompt_open', 'manual', 'Answer the prompt above first'],
    ['session_gone', null, 'That session has ended'],
    ['not_tmux', null, 'This app did not start this session, so its mode cannot be read or changed'],
    ['unreadable', null, 'Could not read the mode from the session'],
  ] as const)('is disabled, with a reason, while %s', (blocked, mode, reason) => {
    render(<ModeChip pid={PID} state={state({ mode, blocked })} onOpenTerminal={() => {}} />);
    // No jest-dom in this project, same as PromptCard.test.tsx: the
    // disabled state is read off the element itself.
    const chip = screen.getByRole('button') as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    expect(chip.getAttribute('title')).toBe(reason);
    fireEvent.click(chip);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('still shows the mode while it is disabled', () => {
    render(<ModeChip pid={PID} state={state({ mode: 'plan', blocked: 'prompt_open' })} onOpenTerminal={() => {}} />);
    expect(screen.getByRole('button').textContent).toContain('Plan');
  });

  // Defensive, and not a case main produces: it never sends a null mode
  // without a reason. The menu switches FROM the mode the pane reports, and
  // main refuses a press it cannot read a mode for (`unreadable`), so a chip
  // that opened here would be a control that could only fail.
  it('will not open a menu when it has no mode to switch from', () => {
    render(<ModeChip pid={PID} state={state({ mode: null, blocked: null })} onOpenTerminal={() => {}} />);
    const chip = screen.getByRole('button') as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    expect(chip.getAttribute('title')).toBe('Could not read the mode from the session');
  });

  it('is disabled with no live pid', () => {
    render(<ModeChip pid={null} state={state()} onOpenTerminal={() => {}} />);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ModeChip: closing the menu', () => {
  it('closes on Escape and puts focus back on the chip', () => {
    render(<ModeChip pid={PID} state={state()} onOpenTerminal={() => {}} />);
    const chip = screen.getByRole('button');
    fireEvent.click(chip);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it('closes on a click outside it', () => {
    render(<ModeChip pid={PID} state={state()} onOpenTerminal={() => {}} />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('stays open for a click inside it', () => {
    render(<ModeChip pid={PID} state={state()} onOpenTerminal={() => {}} />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.mouseDown(screen.getByRole('menu'));
    expect(screen.queryByRole('menu')).toBeTruthy();
  });

  it('focuses the first row on open and walks the rows with the arrow keys', () => {
    render(<ModeChip pid={PID} state={state()} onOpenTerminal={() => {}} />);
    fireEvent.click(screen.getByRole('button'));
    const rows = screen.getAllByRole('menuitemradio');
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(rows[0]);
  });
});
