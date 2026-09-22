import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { SettingsModal } from '../../src/renderer/components/SettingsModal.tsx';
import { DEFAULT_SETTINGS, getSettings, reloadSettings } from '../../src/renderer/state/settings.ts';

beforeEach(() => {
  localStorage.clear();
  reloadSettings();
  document.documentElement.className = '';
  // Left undefined outside the Quick answers tests below (its own
  // beforeEach sets it): SettingsModal's hooksGet/hooksSet calls are
  // guarded by `window.fleet?`, so every test unrelated to the switch runs
  // exactly as it did before that feature existed, with no promise for an
  // unrelated test to have to wait out.
  (globalThis as never as { window: { fleet: unknown } }).window.fleet = undefined;
});

describe('SettingsModal', () => {
  it('renders nothing visible until it is opened', () => {
    const { container } = render(<SettingsModal open={false} onClose={() => {}} />);
    expect(container.querySelector('dialog')!.hasAttribute('open')).toBe(false);
  });

  // Each segmented control is a labelled group of buttons standing in for
  // the old <select>'s options -- getByRole('group', {name}) is the group
  // getByLabelText used to find directly on the <select>, and the pressed
  // button inside it is the stored value made visible.
  it('offers every documented choice, with the stored value pressed', () => {
    render(<SettingsModal open={true} onClose={() => {}} />);

    const appearance = screen.getByRole('group', { name: 'Appearance' });
    expect(within(appearance).getAllByRole('button').map(b => b.textContent)).toEqual(['System', 'Light', 'Dark']);
    expect(within(appearance).getByRole('button', { name: 'System' }).getAttribute('aria-pressed')).toBe('true');

    const textSize = screen.getByRole('group', { name: 'Text size' });
    expect(within(textSize).getAllByRole('button').map(b => b.textContent))
      .toEqual(['14 px', '15 px', '16 px', '17 px']);
    expect(within(textSize).getByRole('button', { name: '16 px' }).getAttribute('aria-pressed')).toBe('true');

    const compact = screen.getByRole('group', { name: 'Compact cards' });
    expect(within(compact).getAllByRole('button').map(b => b.textContent))
      .toEqual(['Off', 'Sidebar', 'Fleet', 'Both']);
    expect(within(compact).getByRole('button', { name: 'Both' }).getAttribute('aria-pressed')).toBe('true');

    const style = screen.getByRole('group', { name: 'Message style' });
    expect(within(style).getByRole('button', { name: /A · Margin rule/ }).getAttribute('aria-pressed')).toBe('true');
    expect(within(style).getByRole('button', { name: /C · Your messages in a bubble/ }).getAttribute('aria-pressed'))
      .toBe('false');
  });

  it('writes a change straight through to the store', () => {
    render(<SettingsModal open={true} onClose={() => {}} />);
    fireEvent.click(within(screen.getByRole('group', { name: 'Text size' }))
      .getByRole('button', { name: '14 px' }));
    expect(getSettings().textSize).toBe(14);
    fireEvent.click(within(screen.getByRole('group', { name: 'Message style' }))
      .getByRole('button', { name: /C · Your messages in a bubble/ }));
    expect(getSettings().messageStyle).toBe('c');
  });

  // Pressing a segment moves aria-pressed off the old choice and onto the
  // new one -- the same state a screen reader announces, not just a colour
  // change (spec: "keyboard and screen readers" for the segmented controls).
  it('exposes the pressed segment to assistive tech, and moves it on click', () => {
    render(<SettingsModal open={true} onClose={() => {}} />);
    const appearance = screen.getByRole('group', { name: 'Appearance' });
    expect(within(appearance).getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(within(appearance).getByRole('button', { name: 'Dark' }));
    expect(within(appearance).getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(appearance).getByRole('button', { name: 'System' }).getAttribute('aria-pressed')).toBe('false');
  });

  // The old <select>-driven test fired a raw onChange with a value never
  // offered in the DOM ('sepia'), which only a hand-rolled event could ever
  // produce -- the segmented buttons that replace the select cannot present
  // an unlisted value at all, so there is no UI action left that exercises
  // this path. The guarantee itself (normalizeSettings falls back to the
  // default for an out-of-range value) is unit-tested directly in
  // tests/renderer/settings.test.ts; what this test can still prove at the
  // modal layer is the other half -- that the control's own option list
  // never grows or shrinks silently.
  it('presents exactly the documented set of choices, nothing more', () => {
    render(<SettingsModal open={true} onClose={() => {}} />);
    expect(within(screen.getByRole('group', { name: 'Appearance' })).getAllByRole('button')).toHaveLength(3);
    expect(within(screen.getByRole('group', { name: 'Text size' })).getAllByRole('button')).toHaveLength(4);
    expect(within(screen.getByRole('group', { name: 'Compact cards' })).getAllByRole('button')).toHaveLength(4);
    expect(within(screen.getByRole('group', { name: 'Message style' })).getAllByRole('button')).toHaveLength(2);
  });

  // Regression: the title and the "default" tag used to sit in adjacent JSX
  // elements with no space between them, so the computed accessible name
  // concatenated straight into "A · Margin ruledefault". getByRole's name
  // match runs the same accessible-name computation a screen reader would,
  // so an exact match here is the one place that word-glue defect would
  // resurface silently.
  it('puts a space before the "default" tag in the accessible name, not glued to the title', () => {
    render(<SettingsModal open={true} onClose={() => {}} />);
    const style = screen.getByRole('group', { name: 'Message style' });
    expect(within(style).getByRole('button', { name: 'A · Margin rule default' })).toBeTruthy();
  });

  it.each([
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
    ['the close button', () => fireEvent.click(screen.getByRole('button', { name: /close settings/i }))],
    ['Done', () => fireEvent.click(screen.getByRole('button', { name: /^done$/i }))],
  ])('closes on %s', (_label, act) => {
    const onClose = vi.fn();
    render(<SettingsModal open={true} onClose={onClose} />);
    act();
    expect(onClose).toHaveBeenCalled();
  });

  // A click on a native dialog's backdrop targets the dialog element
  // itself; a click on anything inside targets that child. Both are
  // exercised, because a handler that only checked "is this the dialog"
  // would also close on every click that bubbled up from a control.
  it('closes on a backdrop click but not on a click inside the panel', () => {
    const onClose = vi.fn();
    const { container } = render(<SettingsModal open={true} onClose={onClose} />);
    fireEvent.click(within(screen.getByRole('group', { name: 'Appearance' }))
      .getByRole('button', { name: 'System' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('dialog')!);
    expect(onClose).toHaveBeenCalled();
  });

  // Spec §3.5: the page and the conversation do not scroll while this is
  // open. jsdom paints nothing, so the class that carries the lock is what
  // can be asserted; SettingsModal.css is where the rules live.
  it('locks background scrolling while open and releases it on close', () => {
    const { rerender, unmount } = render(<SettingsModal open={true} onClose={() => {}} />);
    expect(document.documentElement.classList.contains('modal-open')).toBe(true);
    rerender(<SettingsModal open={false} onClose={() => {}} />);
    expect(document.documentElement.classList.contains('modal-open')).toBe(false);
    rerender(<SettingsModal open={true} onClose={() => {}} />);
    unmount();
    expect(document.documentElement.classList.contains('modal-open')).toBe(false);
  });

  // The live preview is the one genuinely new surface: it must actually
  // move when either control it depends on changes, not just render once
  // at mount. jsdom computes no layout, so this asserts the two attributes
  // the CSS keys off (data-style and the --prev-size custom property),
  // which is as far as a DOM-only test can go toward "looks different".
  describe('the live preview', () => {
    function preview(container: HTMLElement): HTMLElement {
      return container.querySelector('.settingsprev') as HTMLElement;
    }

    it('renders at the stored text size and message style by default', () => {
      const { container } = render(<SettingsModal open={true} onClose={() => {}} />);
      const prev = preview(container);
      expect(prev.getAttribute('data-style')).toBe(DEFAULT_SETTINGS.messageStyle);
      expect(prev.style.getPropertyValue('--prev-size')).toBe(`${DEFAULT_SETTINGS.textSize}px`);
    });

    it('follows a text-size change', () => {
      const { container } = render(<SettingsModal open={true} onClose={() => {}} />);
      fireEvent.click(within(screen.getByRole('group', { name: 'Text size' }))
        .getByRole('button', { name: '17 px' }));
      expect(preview(container).style.getPropertyValue('--prev-size')).toBe('17px');
    });

    it('follows a message-style change', () => {
      const { container } = render(<SettingsModal open={true} onClose={() => {}} />);
      fireEvent.click(within(screen.getByRole('group', { name: 'Message style' }))
        .getByRole('button', { name: /C · Your messages in a bubble/ }));
      expect(preview(container).getAttribute('data-style')).toBe('c');
    });
  });

  it('offers a control for grouping sessions by folder', () => {
    render(<SettingsModal open={true} onClose={() => {}} />);
    const control = screen.getByRole('checkbox', { name: /group sessions by folder/i });
    expect((control as HTMLInputElement).checked).toBe(true);
  });

  it('writes the setting when toggled off', () => {
    render(<SettingsModal open={true} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /group sessions by folder/i }));
    expect(getSettings().groupSessions).toBe('off');
  });

  // Design §4/§9: a switch (not a segmented control) that reads and writes
  // the app's real hooks state through window.fleet.hooksGet/hooksSet,
  // re-reading fresh every time the modal opens.
  describe('Quick answers', () => {
    // A fake window.fleet, same pattern as LaunchBar.test.tsx. Scoped to
    // this describe block (not the file's top-level beforeEach) so every
    // other test in this file keeps window.fleet undefined and never has a
    // hooksGet/hooksSet promise of its own to settle.
    let hooksGet: ReturnType<typeof vi.fn>;
    let hooksSet: ReturnType<typeof vi.fn>;
    let hooksPreview: ReturnType<typeof vi.fn>;
    let hooksDecline: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      hooksGet = vi.fn(async () => ({ installed: false, error: null }));
      hooksSet = vi.fn(async (on: boolean) => ({ installed: on, error: null }));
      // The consent gate (first-run design §6): turning Quick answers ON no
      // longer writes anything by itself. It opens a panel built from this
      // preview, and the token below is what makes an install possible at
      // all -- main refuses hooksSet(true) without one.
      hooksPreview = vi.fn(async () => ({
        file: '/home/me/.claude/settings.json',
        helperPath: '/home/me/.llm-workspace/bin/helper.sh',
        fileExists: true, installed: false,
        additions: [{ event: 'SessionStart', matcher: null, json: '{"hooks":[]}' }],
        token: 'tok-1', error: null, decision: null,
      }));
      hooksDecline = vi.fn(async () => ({ decision: 'declined' }));
      (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
        hooksGet, hooksSet, hooksPreview, hooksDecline,
      };
    });

    it('says that turning it on shows you the change before making it', async () => {
      render(<SettingsModal open={true} onClose={() => {}} />);
      expect(screen.getByText(
        'Lets the app show what Claude is asking, using hooks in ~/.claude/settings.json. '
        + 'Turning this on shows you exactly what it would add before anything is written. '
        + 'Turning it off removes only the entries it added.',
      )).toBeTruthy();
      // Lets the initial hooksGet() resolve inside this test's act() scope,
      // rather than after it returns.
      await waitFor(() => expect(hooksGet).toHaveBeenCalled());
    });

    it('reads the real state from hooksGet when the modal opens, not a guess', async () => {
      hooksGet.mockResolvedValue({ installed: true, error: null });
      render(<SettingsModal open={true} onClose={() => {}} />);
      await waitFor(() => {
        expect(screen.getByRole('switch', { name: 'Quick answers' }).getAttribute('aria-checked')).toBe('true');
      });
    });

    it('starts the switch disabled until the initial read resolves', async () => {
      let resolve!: (v: { installed: boolean; error: null }) => void;
      hooksGet.mockReturnValue(new Promise(r => { resolve = r; }));
      render(<SettingsModal open={true} onClose={() => {}} />);
      expect(screen.getByRole('switch', { name: 'Quick answers' }).hasAttribute('disabled')).toBe(true);
      resolve({ installed: false, error: null });
      await waitFor(() => {
        expect(screen.getByRole('switch', { name: 'Quick answers' }).hasAttribute('disabled')).toBe(false);
      });
    });

    it('re-reads hooksGet every time the modal is reopened', async () => {
      const { rerender } = render(<SettingsModal open={true} onClose={() => {}} />);
      await waitFor(() => expect(hooksGet).toHaveBeenCalledTimes(1));
      rerender(<SettingsModal open={false} onClose={() => {}} />);
      rerender(<SettingsModal open={true} onClose={() => {}} />);
      await waitFor(() => expect(hooksGet).toHaveBeenCalledTimes(2));
    });

    // Design §6: consent is a gate IN FRONT of the write. Flipping the
    // switch on must not edit a file the person owns -- it must show them
    // what it would put there and wait.
    it('turning it on writes nothing: it shows what would be written', async () => {
      render(<SettingsModal open={true} onClose={() => {}} />);
      await waitFor(() => expect(screen.getByRole('switch', { name: 'Quick answers' }).hasAttribute('disabled')).toBe(false));
      fireEvent.click(screen.getByRole('switch', { name: 'Quick answers' }));

      await waitFor(() => expect(hooksPreview).toHaveBeenCalled());
      // The one assertion this whole change exists for.
      expect(hooksSet).not.toHaveBeenCalled();
      // And the file it would touch is named on screen, before anything.
      await waitFor(() => expect(screen.getByText('/home/me/.claude/settings.json')).toBeTruthy());
    });

    it('installs only after an explicit yes, and only with the previewed token', async () => {
      render(<SettingsModal open={true} onClose={() => {}} />);
      await waitFor(() => expect(screen.getByRole('switch', { name: 'Quick answers' }).hasAttribute('disabled')).toBe(false));
      fireEvent.click(screen.getByRole('switch', { name: 'Quick answers' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Add them' })).toBeTruthy());

      fireEvent.click(screen.getByRole('button', { name: 'Add them' }));
      // The token main issued with the preview -- without it main refuses.
      expect(hooksSet).toHaveBeenCalledWith(true, 'tok-1');
    });

    it('takes no for an answer, and writes nothing when it gets one', async () => {
      render(<SettingsModal open={true} onClose={() => {}} />);
      await waitFor(() => expect(screen.getByRole('switch', { name: 'Quick answers' }).hasAttribute('disabled')).toBe(false));
      fireEvent.click(screen.getByRole('switch', { name: 'Quick answers' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'No thanks' })).toBeTruthy());

      fireEvent.click(screen.getByRole('button', { name: 'No thanks' }));
      await waitFor(() => expect(hooksDecline).toHaveBeenCalled());
      expect(hooksSet).not.toHaveBeenCalled();
    });

    it('turns quick answers off via hooksSet when it was already on', async () => {
      hooksGet.mockResolvedValue({ installed: true, error: null });
      render(<SettingsModal open={true} onClose={() => {}} />);
      await waitFor(() => {
        expect(screen.getByRole('switch', { name: 'Quick answers' }).getAttribute('aria-checked')).toBe('true');
      });
      fireEvent.click(screen.getByRole('switch', { name: 'Quick answers' }));
      expect(hooksSet).toHaveBeenCalledWith(false);
      await waitFor(() => {
        expect(screen.getByRole('switch', { name: 'Quick answers' }).getAttribute('aria-checked')).toBe('false');
      });
    });

    it('shows the refusal when the install is rejected, and stays honest about the state', async () => {
      hooksSet.mockResolvedValue({ installed: false, error: 'Settings changed while installing -- try again' });
      render(<SettingsModal open={true} onClose={() => {}} />);
      await waitFor(() => expect(screen.getByRole('switch', { name: 'Quick answers' }).hasAttribute('disabled')).toBe(false));
      fireEvent.click(screen.getByRole('switch', { name: 'Quick answers' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Add them' })).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Add them' }));

      await waitFor(() => {
        expect(screen.getAllByRole('alert').some(
          el => el.textContent === 'Settings changed while installing -- try again',
        )).toBe(true);
      });
      // The switch never claims a state the file does not show.
      expect(screen.getByRole('switch', { name: 'Quick answers' }).getAttribute('aria-checked')).toBe('false');
    });

    // Turning it OFF is now the only direct write the switch itself makes,
    // so it is the one that can still be in flight.
    it('disables the switch while a remove request is in flight, and re-enables after it settles', async () => {
      hooksGet.mockResolvedValue({ installed: true, error: null });
      render(<SettingsModal open={true} onClose={() => {}} />);
      await waitFor(() => expect(screen.getByRole('switch', { name: 'Quick answers' }).hasAttribute('disabled')).toBe(false));
      let resolve!: (v: { installed: boolean; error: null }) => void;
      hooksSet.mockReturnValue(new Promise(r => { resolve = r; }));
      fireEvent.click(screen.getByRole('switch', { name: 'Quick answers' }));
      expect(screen.getByRole('switch', { name: 'Quick answers' }).hasAttribute('disabled')).toBe(true);
      resolve({ installed: false, error: null });
      await waitFor(() => {
        expect(screen.getByRole('switch', { name: 'Quick answers' }).hasAttribute('disabled')).toBe(false);
      });
    });

    it('does not crash when window.fleet is unavailable (a failed preload)', () => {
      (globalThis as never as { window: { fleet: unknown } }).window.fleet = undefined;
      expect(() => render(<SettingsModal open={true} onClose={() => {}} />)).not.toThrow();
      expect(screen.getByRole('switch', { name: 'Quick answers' }).hasAttribute('disabled')).toBe(true);
    });
  });

  // Usage design, Part B: a switch and a number input, same pattern as
  // Quick answers above (re-read fresh from main every time the modal
  // opens, disabled until that first read resolves, an error line on a
  // refusal) -- plus the coordinator's own two review notes: the hint
  // names the trust/hooks preconditions, and a bad compacts-at value never
  // reaches usage:compacts-at:set.
  describe('Usage and context', () => {
    let usageSwitchGet: ReturnType<typeof vi.fn>;
    let usageSwitchSet: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      usageSwitchGet = vi.fn(async () => ({ installed: false, error: null }));
      usageSwitchSet = vi.fn(async (on: boolean) => ({ installed: on, error: null }));
      // Quick answers' own hooksGet/hooksSet are stubbed purely so that
      // mount doesn't throw (its effect guards only on `window.fleet`
      // existing, not on the specific method) -- its own behaviour is
      // covered by the "Quick answers" describe block above.
      const hooksGet = vi.fn(async () => ({ installed: false, error: null }));
      const hooksSet = vi.fn(async (on: boolean) => ({ installed: on, error: null }));
      (globalThis as never as { window: { fleet: unknown } }).window.fleet =
        { usageSwitchGet, usageSwitchSet, hooksGet, hooksSet };
    });

    it('shows the exact hint sentence, including the trust/hooks preconditions', async () => {
      render(<SettingsModal open={true} onClose={() => {}} />);
      expect(screen.getByText(
        "Adds a status line to ~/.claude/settings.json so the app can show context and plan usage. "
        + "Claude Code hides most footer hints while any status line is set. "
        + "Needs a trusted folder; off when hooks are disabled.",
      )).toBeTruthy();
      await waitFor(() => expect(usageSwitchGet).toHaveBeenCalled());
    });

    it('reads the real state from usageSwitchGet when the modal opens', async () => {
      usageSwitchGet.mockResolvedValue({ installed: true, error: null });
      render(<SettingsModal open={true} onClose={() => {}} />);
      await waitFor(() => {
        expect(screen.getByRole('switch', { name: 'Usage and context' }).getAttribute('aria-checked')).toBe('true');
      });
    });

    it('starts the switch disabled until the initial read resolves', async () => {
      let resolve!: (v: { installed: boolean; error: null }) => void;
      usageSwitchGet.mockReturnValue(new Promise(r => { resolve = r; }));
      render(<SettingsModal open={true} onClose={() => {}} />);
      expect(screen.getByRole('switch', { name: 'Usage and context' }).hasAttribute('disabled')).toBe(true);
      resolve({ installed: false, error: null });
      await waitFor(() => {
        expect(screen.getByRole('switch', { name: 'Usage and context' }).hasAttribute('disabled')).toBe(false);
      });
    });

    it('re-reads usageSwitchGet every time the modal is reopened', async () => {
      const { rerender } = render(<SettingsModal open={true} onClose={() => {}} />);
      await waitFor(() => expect(usageSwitchGet).toHaveBeenCalledTimes(1));
      rerender(<SettingsModal open={false} onClose={() => {}} />);
      rerender(<SettingsModal open={true} onClose={() => {}} />);
      await waitFor(() => expect(usageSwitchGet).toHaveBeenCalledTimes(2));
    });

    it('turns Usage and context on via usageSwitchSet and reflects the result', async () => {
      render(<SettingsModal open={true} onClose={() => {}} />);
      await waitFor(() => expect(screen.getByRole('switch', { name: 'Usage and context' }).hasAttribute('disabled')).toBe(false));
      fireEvent.click(screen.getByRole('switch', { name: 'Usage and context' }));
      expect(usageSwitchSet).toHaveBeenCalledWith(true);
      await waitFor(() => {
        expect(screen.getByRole('switch', { name: 'Usage and context' }).getAttribute('aria-checked')).toBe('true');
      });
    });

    it('shows the refusal line when usageSwitchSet refuses, and leaves the switch reflecting the real state', async () => {
      usageSwitchSet.mockResolvedValue({ installed: false, error: 'You already have a status line in settings.json -- not replaced.' });
      render(<SettingsModal open={true} onClose={() => {}} />);
      await waitFor(() => expect(screen.getByRole('switch', { name: 'Usage and context' }).hasAttribute('disabled')).toBe(false));
      fireEvent.click(screen.getByRole('switch', { name: 'Usage and context' }));
      await waitFor(() => {
        expect(screen.getByText('You already have a status line in settings.json -- not replaced.')).toBeTruthy();
      });
      expect(screen.getByRole('switch', { name: 'Usage and context' }).getAttribute('aria-checked')).toBe('false');
    });

    it('does not crash when window.fleet is unavailable', () => {
      (globalThis as never as { window: { fleet: unknown } }).window.fleet = undefined;
      expect(() => render(<SettingsModal open={true} onClose={() => {}} />)).not.toThrow();
      expect(screen.getByRole('switch', { name: 'Usage and context' }).hasAttribute('disabled')).toBe(true);
    });
  });
});
