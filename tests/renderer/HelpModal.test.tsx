import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { SettingsModal } from '../../src/renderer/components/SettingsModal.tsx';
import { HelpModal, HELP_TOPICS, type HelpTopic } from '../../src/renderer/components/HelpModal.tsx';
import { reloadSettings } from '../../src/renderer/state/settings.ts';

/** Option B of the "Help button in Settings" mockup
 *  (claude.ai/artifact/Pm1UjzEWrck2qvkGVjnNri): a Help row at the end of
 *  Settings opening a Help modal over it, on the Fleet Mail topic. */

const REVIEW_REQUEST =
  "Use fleet-mail to have codex-reviewer review docs/my-plan.md. Attach it, set project to this folder's "
  + 'absolute path, then check_mail until it replies and show me the review.';
const FOLLOW_UP =
  'Fix what you agree with in docs/my-plan.md, then send the next pass with re set to the last letter id, '
  + 'saying what you fixed and what you declined. Check mail until it replies.';

beforeEach(() => {
  localStorage.clear();
  reloadSettings();
  document.documentElement.className = '';
  (globalThis as never as { window: { fleet: unknown } }).window.fleet = undefined;
});

const helpDialog = () => document.querySelector('dialog.helpdlg') as HTMLDialogElement;
const settingsDialog = () => document.querySelector('dialog.settingsdlg:not(.helpdlg)') as HTMLDialogElement;
const helpRow = () => screen.getByRole('button', { name: /^Help\b/ });
const locked = (cls: string) => document.documentElement.classList.contains(cls);

function openSettingsThenHelp(onClose = vi.fn()) {
  const utils = render(<SettingsModal open={true} onClose={onClose} />);
  fireEvent.click(helpRow());
  return { ...utils, onClose };
}

describe('the Help row in Settings', () => {
  it('sits after "What this app needs", names what is inside, and starts with Help closed', () => {
    render(<SettingsModal open={true} onClose={() => {}} />);
    const sections = [...settingsDialog().querySelectorAll('.settingssection')];
    expect(sections.at(-2)!.querySelector('.settingssectitle')!.textContent).toBe('What this app needs');
    expect(within(sections.at(-1) as HTMLElement).getByRole('button', { name: /^Help\b/ })).toBeTruthy();
    expect(helpRow().textContent).toContain('How to use Fleet Mail, step by step.');
    expect(helpDialog().hasAttribute('open')).toBe(false);
  });

  it('opens Help over Settings, on the Fleet Mail topic, with its five sections', () => {
    openSettingsThenHelp();
    expect(helpDialog().hasAttribute('open')).toBe(true);
    expect(settingsDialog().hasAttribute('open')).toBe(true);
    const help = screen.getByRole('dialog', { name: 'Help' });
    expect(within(help).getByRole('heading', { level: 3 }).textContent).toBe('Fleet Mail');
    expect(within(help).getAllByRole('heading', { level: 4 }).map(h => h.textContent)).toEqual([
      '1 Before you start', '2 Ask for a review', '3 Keep going', "What you'll see", 'Limits',
    ]);
  });
});

describe('closing Help', () => {
  // SettingsModal listens for Escape on the whole document, so without
  // stepping aside one press would close both modals.
  it('closes only Help on Escape, and Settings takes Escape back afterwards', () => {
    const { onClose } = openSettingsThenHelp();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(helpDialog().hasAttribute('open')).toBe(false);
    expect(settingsDialog().hasAttribute('open')).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
    ['the close button', () => fireEvent.click(screen.getByRole('button', { name: 'Close help' }))],
    ['Done', () => fireEvent.click(within(helpDialog()).getByRole('button', { name: 'Done' }))],
    ['a backdrop click', () => fireEvent.click(helpDialog())],
  ])('closes on %s: back to Settings, focus on the row, Settings still locked behind', (_label, act) => {
    const { onClose } = openSettingsThenHelp();
    expect(locked('help-open')).toBe(true);
    expect(locked('modal-open')).toBe(true);
    act();
    expect(helpDialog().hasAttribute('open')).toBe(false);
    expect(settingsDialog().hasAttribute('open')).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(locked('help-open')).toBe(false);
    // Settings is still open, so the app behind it stays locked.
    expect(locked('modal-open')).toBe(true);
    expect(document.activeElement).toBe(helpRow());
  });

  it('does not close on a click inside the Help panel', () => {
    openSettingsThenHelp();
    fireEvent.click(within(helpDialog()).getByRole('heading', { level: 3 }));
    expect(helpDialog().hasAttribute('open')).toBe(true);
  });

  it('releases its lock if it unmounts while open', () => {
    const { unmount } = render(<HelpModal open={true} onClose={() => {}} />);
    expect(locked('help-open')).toBe(true);
    unmount();
    expect(locked('help-open')).toBe(false);
  });

  it('closes with Settings, and opens closed next time', () => {
    const { rerender } = openSettingsThenHelp();
    rerender(<SettingsModal open={false} onClose={() => {}} />);
    expect(helpDialog().hasAttribute('open')).toBe(false);
    expect(locked('help-open')).toBe(false);
    rerender(<SettingsModal open={true} onClose={() => {}} />);
    expect(helpDialog().hasAttribute('open')).toBe(false);
  });
});

describe('the Fleet Mail topic', () => {
  it.each([
    ['Copy the review request', REVIEW_REQUEST],
    ['Copy the follow-up', FOLLOW_UP],
  ])('"%s" puts the exact message on the clipboard', async (name, text) => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<HelpModal open={true} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
    expect(writeText).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());
  });

  it('shows the messages it copies, word for word', () => {
    render(<HelpModal open={true} onClose={() => {}} />);
    expect([...document.querySelectorAll('.helpmsgtext')].map(p => p.textContent)).toEqual([REVIEW_REQUEST, FOLLOW_UP]);
  });

  it('says when the copy failed rather than claiming success', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<HelpModal open={true} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy the review request' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy failed' })).toBeTruthy());
    err.mockRestore();
  });

  it('draws the real mail badges: a plane on the sender, a tray with the pass on the reviewer', () => {
    render(<HelpModal open={true} onClose={() => {}} />);
    const sender = document.querySelector('.helpbadge .mailbadge.sender')!;
    const reviewer = document.querySelector('.helpbadge .mailbadge.reviewer')!;
    expect(sender.querySelector('svg')).not.toBeNull();
    expect(sender.querySelector('.mailbadge-n')!.textContent).toBe('×1');
    expect(reviewer.querySelector('svg')).not.toBeNull();
    expect(reviewer.querySelector('.mailbadge-n')!.textContent).toBe('2/4');
  });

  it('states the limits', () => {
    render(<HelpModal open={true} onClose={() => {}} />);
    const facts = document.querySelector('.helppanel .hcfacts')!;
    const rows = [...facts.querySelectorAll('dt')].map(dt => [dt.textContent, dt.nextElementSibling!.textContent]);
    expect(rows).toEqual([
      ['Passes per review', '4 by default. After that you get a notification.'],
      ['Letters', '40 in any 24 hours.'],
      ['Attachments', 'Files inside the project only. Anything that looks like a secret, such as a key file or .env, is refused.'],
      ['Settings file', 'To change the limits or add specialists, edit ~/.llm-workspace/mail/config.json.'],
    ]);
  });
});

describe('topics', () => {
  it('has one topic today, so no topic list', () => {
    expect(HELP_TOPICS.map(t => t.title)).toEqual(['Fleet Mail']);
    render(<HelpModal open={true} onClose={() => {}} />);
    expect(screen.queryByRole('navigation', { name: 'Help topics' })).toBeNull();
  });

  it('shows a topic list once a second topic exists, and switches on click', () => {
    const second: HelpTopic = { id: 'other', title: 'Other', lede: 'Another topic.', Body: () => <p>Other body</p> };
    render(<HelpModal open={true} onClose={() => {}} topics={[...HELP_TOPICS, second]} />);
    const nav = screen.getByRole('navigation', { name: 'Help topics' });
    expect(within(nav).getAllByRole('button').map(b => b.textContent)).toEqual(['Fleet Mail', 'Other']);
    expect(within(nav).getByRole('button', { name: 'Fleet Mail' }).getAttribute('aria-current')).toBe('true');
    fireEvent.click(within(nav).getByRole('button', { name: 'Other' }));
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Other');
    expect(screen.getByText('Other body')).toBeTruthy();
  });
});
