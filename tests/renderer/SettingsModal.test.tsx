import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

  it('offers every documented choice, with the stored value selected', () => {
    render(<SettingsModal open={true} onClose={() => {}} />);
    expect((screen.getByLabelText('Appearance') as HTMLSelectElement).value).toBe('system');
    expect((screen.getByLabelText('Conversation text size') as HTMLSelectElement).value).toBe('16');
    expect((screen.getByLabelText('Message style') as HTMLSelectElement).value).toBe('a');
    expect((screen.getByLabelText('Compact cards') as HTMLSelectElement).value).toBe('both');
    expect([...(screen.getByLabelText('Conversation text size') as HTMLSelectElement).options].map(o => o.value))
      .toEqual(['14', '15', '16', '17']);
    expect([...(screen.getByLabelText('Compact cards') as HTMLSelectElement).options].map(o => o.value))
      .toEqual(['off', 'sidebar', 'fleet', 'both']);
  });

  it('writes a change straight through to the store', () => {
    render(<SettingsModal open={true} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Conversation text size'), { target: { value: '14' } });
    expect(getSettings().textSize).toBe(14);
    fireEvent.change(screen.getByLabelText('Message style'), { target: { value: 'c' } });
    expect(getSettings().messageStyle).toBe('c');
  });

  it('refuses a value outside the offered set rather than storing it', () => {
    render(<SettingsModal open={true} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Appearance'), { target: { value: 'sepia' } });
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
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
  // would also close on every click that bubbled up from a select.
  it('closes on a backdrop click but not on a click inside the panel', () => {
    const onClose = vi.fn();
    const { container } = render(<SettingsModal open={true} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Appearance'));
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
});
