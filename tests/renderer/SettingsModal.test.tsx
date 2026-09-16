import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { SettingsModal } from '../../src/renderer/components/SettingsModal.tsx';
import { DEFAULT_SETTINGS, getSettings, reloadSettings } from '../../src/renderer/state/settings.ts';

beforeEach(() => {
  localStorage.clear();
  reloadSettings();
  document.documentElement.className = '';
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
});
