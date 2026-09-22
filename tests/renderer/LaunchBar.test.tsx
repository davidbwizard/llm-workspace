import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LaunchBar } from '../../src/renderer/components/LaunchBar.tsx';
import { reloadFavourites } from '../../src/renderer/state/favourites.ts';
import {
  reloadGroups, assignCategory, categoryNames, categoryOfSession, getGroups, resolvePendingCategories,
} from '../../src/renderer/state/groups.ts';

// @testing-library/user-event is not a project dependency (see
// tests/renderer/SessionRail.test.tsx) -- fireEvent substitutes for it,
// matching every other renderer test file.
let launch: ReturnType<typeof vi.fn>;
let chooseDirectory: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // groups.ts is a module-scoped singleton (same shape as favourites.ts
  // below) -- clearing localStorage alone leaves its in-memory `current`
  // untouched, so every test in this file also reloads it.
  localStorage.clear();
  reloadGroups();
  launch = vi.fn(async () => ({ status: 'launched', pid: 4821 }));
  chooseDirectory = vi.fn(async () => null);
  // LaunchBar's settings gear mounts the real SettingsModal (below), which
  // reads Quick answers' state via hooksGet on open -- stubbed here purely
  // so that mount doesn't throw; its own behaviour is covered by
  // tests/renderer/SettingsModal.test.tsx.
  const hooksGet = vi.fn(async () => ({ installed: false, error: null }));
  const hooksSet = vi.fn(async (on: boolean) => ({ installed: on, error: null }));
  (globalThis as never as { window: { fleet: unknown } }).window.fleet =
    { launch, chooseDirectory, hooksGet, hooksSet };
});

describe('LaunchBar', () => {
  it('launches the chosen directory under the default provider, and reports the new pid', async () => {
    const onLaunched = vi.fn();
    render(<LaunchBar onLaunched={onLaunched} />);
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/proj' } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith(4821));
    expect(launch).toHaveBeenCalledWith('claude', '/tmp/proj', expect.any(Number), expect.any(Number), null);
  });

  it('sends the provider the user actually picked, not always the default', async () => {
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'codex' } });
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/proj' } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    await waitFor(() =>
      expect(launch).toHaveBeenCalledWith('codex', '/tmp/proj', expect.any(Number), expect.any(Number), null));
  });

  it('shows the failure reason instead of failing silently', async () => {
    launch.mockResolvedValue({ status: 'failed', reason: 'tmux: no server running' });
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/proj' } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    await waitFor(() => expect(screen.getByText(/no server running/i)).toBeTruthy());
  });

  it('refuses to launch with no directory chosen', () => {
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    expect(launch).not.toHaveBeenCalled();
    expect(screen.getByText(/choose a working directory/i)).toBeTruthy();
  });

  it('opens the native picker and fills the input with the chosen path', async () => {
    chooseDirectory.mockResolvedValue('/tmp/picked');
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose a working directory' }));
    expect(chooseDirectory).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect((screen.getByLabelText('Working directory') as HTMLInputElement).value).toBe('/tmp/picked'));
  });

  it('leaves a typed path untouched when the picker is cancelled', async () => {
    chooseDirectory.mockResolvedValue(null);
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/typed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a working directory' }));
    await waitFor(() => expect(chooseDirectory).toHaveBeenCalledTimes(1));
    expect((screen.getByLabelText('Working directory') as HTMLInputElement).value).toBe('/tmp/typed');
  });

  it('opens settings from a gear beside Launch, and returns focus to it on close', () => {
    render(<LaunchBar onLaunched={() => {}} />);
    const gear = screen.getByRole('button', { name: /^settings$/i });
    fireEvent.click(gear);
    expect(screen.getByLabelText('Appearance')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));
    expect(document.activeElement).toBe(gear);
  });

  // Usage design, Part B: a small non-modal popover, next to the gear.
  describe('the Usage button and its popover', () => {
    beforeEach(() => {
      // Stubbed purely so UsagePopover's own mount effect doesn't throw --
      // its own behaviour (bars, empty states, refresh) is covered by
      // UsagePopover.test.tsx.
      const api = (globalThis as never as { window: { fleet: Record<string, unknown> } }).window.fleet;
      api.usageSwitchGet = vi.fn(async () => ({ installed: true, error: null }));
      api.usageGet = vi.fn(async () => ({ claude: null, codex: null }));
    });

    it('opens the popover from a button beside the gear', () => {
      render(<LaunchBar onLaunched={() => {}} />);
      expect(screen.queryByRole('dialog', { name: /usage/i })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /^usage$/i }));
      expect(screen.getByRole('dialog', { name: /usage/i })).toBeTruthy();
    });

    it('closes on Escape and returns focus to the button', () => {
      render(<LaunchBar onLaunched={() => {}} />);
      const usageBtn = screen.getByRole('button', { name: /^usage$/i });
      fireEvent.click(usageBtn);
      expect(screen.getByRole('dialog', { name: /usage/i })).toBeTruthy();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog', { name: /usage/i })).toBeNull();
      expect(document.activeElement).toBe(usageBtn);
    });

    it('closes on an outside click and returns focus to the button', () => {
      render(<LaunchBar onLaunched={() => {}} />);
      const usageBtn = screen.getByRole('button', { name: /^usage$/i });
      fireEvent.click(usageBtn);
      expect(screen.getByRole('dialog', { name: /usage/i })).toBeTruthy();
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole('dialog', { name: /usage/i })).toBeNull();
      expect(document.activeElement).toBe(usageBtn);
    });

    it('does not close on a click inside the popover itself', () => {
      render(<LaunchBar onLaunched={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: /^usage$/i }));
      const dialog = screen.getByRole('dialog', { name: /usage/i });
      fireEvent.mouseDown(dialog);
      expect(screen.getByRole('dialog', { name: /usage/i })).toBeTruthy();
    });

    it('toggles closed on a second click of the button itself', () => {
      render(<LaunchBar onLaunched={() => {}} />);
      const usageBtn = screen.getByRole('button', { name: /^usage$/i });
      fireEvent.click(usageBtn);
      expect(screen.getByRole('dialog', { name: /usage/i })).toBeTruthy();
      fireEvent.click(usageBtn);
      expect(screen.queryByRole('dialog', { name: /usage/i })).toBeNull();
    });
  });

  // Favourite folders: a star toggle beside the folder input, persisted to
  // localStorage as "llmws.favourites" (a JSON array of absolute paths),
  // rendered as chips directly under the bar. jsdom's real localStorage is
  // used throughout, same convention as SessionRail.test.tsx's own
  // llmws:rail-width persistence tests -- cleared here so no favourite
  // written by one test leaks into the next.
  describe('favourite folders', () => {
    // favourites.ts is a module-scoped singleton store (shared with
    // MainPane's header star and OpenSessionCard's own menu item) -- same
    // reset requirement as settings.ts's own store: clearing localStorage
    // alone leaves the in-memory `current` untouched, so every test also
    // reloads it, same as reloadSettings() elsewhere.
    beforeEach(() => { localStorage.clear(); reloadFavourites(); });

    it('disables the star with no folder chosen', () => {
      render(<LaunchBar onLaunched={() => {}} />);
      const star = screen.getByRole('button', { name: 'Add to favourites' }) as HTMLButtonElement;
      expect(star.disabled).toBe(true);
      expect(star.getAttribute('aria-pressed')).toBe('false');
    });

    it('enables the star once a folder is typed, and toggles it on click', () => {
      render(<LaunchBar onLaunched={() => {}} />);
      fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/Users/me/proj' } });
      const star = screen.getByRole('button', { name: 'Add to favourites' }) as HTMLButtonElement;
      expect(star.disabled).toBe(false);
      fireEvent.click(star);
      expect(screen.getByRole('button', { name: 'Remove from favourites' }).getAttribute('aria-pressed')).toBe('true');
    });

    it('shows a chip for the favourite, named by its last path segment, titled with the full path', () => {
      render(<LaunchBar onLaunched={() => {}} />);
      fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/Users/me/proj' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add to favourites' }));
      const chip = screen.getByRole('button', { name: 'proj' });
      expect(chip.closest('[title]')?.getAttribute('title')).toBe('/Users/me/proj');
    });

    it('shows no favourites row at all when there are none', () => {
      const { container } = render(<LaunchBar onLaunched={() => {}} />);
      expect(container.querySelector('.favrow')).toBeNull();
    });

    it("launches the chip's folder, under the currently selected provider, through the same call the Launch button uses", async () => {
      render(<LaunchBar onLaunched={() => {}} />);
      fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'codex' } });
      fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/Users/me/proj' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add to favourites' }));
      fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: 'proj' }));
      await waitFor(() =>
        expect(launch).toHaveBeenCalledWith('codex', '/Users/me/proj', expect.any(Number), expect.any(Number), null));
    });

    it('removes a favourite from its own × button', () => {
      render(<LaunchBar onLaunched={() => {}} />);
      fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/Users/me/proj' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add to favourites' }));
      fireEvent.click(screen.getByRole('button', { name: 'Remove proj from favourites' }));
      expect(screen.queryByRole('button', { name: 'proj' })).toBeNull();
    });

    it('persists favourites across a remount', () => {
      const { unmount } = render(<LaunchBar onLaunched={() => {}} />);
      fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/Users/me/proj' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add to favourites' }));
      unmount();
      render(<LaunchBar onLaunched={() => {}} />);
      expect(screen.getByRole('button', { name: 'proj' })).toBeTruthy();
    });

    it('ignores corrupt stored favourites rather than crashing', () => {
      localStorage.setItem('llmws.favourites', 'not json');
      // favourites.ts is read at module load and on explicit reload only
      // (see the store's own beforeEach comment above) -- reloadFavourites
      // is what actually exercises the corrupt-JSON path here; its own
      // parsing is unit-tested directly in favourites.test.ts.
      expect(() => reloadFavourites()).not.toThrow();
      expect(() => render(<LaunchBar onLaunched={() => {}} />)).not.toThrow();
      expect(screen.queryByRole('group', { name: /favourite/i })).toBeNull();
    });

    it('validates stored entries: drops non-strings and relative paths, dedupes, and caps at 12', () => {
      const junk = ['/a', '/a', 42, null, 'relative', '/b', ...Array.from({ length: 20 }, (_, i) => `/many-${i}`)];
      localStorage.setItem('llmws.favourites', JSON.stringify(junk));
      reloadFavourites();
      const { container } = render(<LaunchBar onLaunched={() => {}} />);
      expect(container.querySelectorAll('.favchip')).toHaveLength(12);
    });

    it('disables the star at 12 favourites, with a title explaining why', () => {
      const twelve = Array.from({ length: 12 }, (_, i) => `/proj-${i}`);
      localStorage.setItem('llmws.favourites', JSON.stringify(twelve));
      reloadFavourites();
      render(<LaunchBar onLaunched={() => {}} />);
      fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/proj-new' } });
      const star = screen.getByRole('button', { name: 'Add to favourites' }) as HTMLButtonElement;
      expect(star.disabled).toBe(true);
      expect(star.getAttribute('title')).toMatch(/12/);
    });

    it('still allows un-favouriting at the cap', () => {
      const twelve = Array.from({ length: 12 }, (_, i) => `/proj-${i}`);
      localStorage.setItem('llmws.favourites', JSON.stringify(twelve));
      reloadFavourites();
      render(<LaunchBar onLaunched={() => {}} />);
      fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/proj-0' } });
      const star = screen.getByRole('button', { name: 'Remove from favourites' }) as HTMLButtonElement;
      expect(star.disabled).toBe(false);
    });

    it('keeps working even when localStorage throws on read', () => {
      const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('nope'); });
      expect(() => reloadFavourites()).not.toThrow();
      expect(() => render(<LaunchBar onLaunched={() => {}} />)).not.toThrow();
      spy.mockRestore();
    });

    it('keeps working even when localStorage throws on write', () => {
      const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('nope'); });
      render(<LaunchBar onLaunched={() => {}} />);
      fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/Users/me/proj' } });
      expect(() => fireEvent.click(screen.getByRole('button', { name: 'Add to favourites' }))).not.toThrow();
      // Still reflected in this render's own state even though persistence failed.
      expect(screen.getByRole('button', { name: 'Remove from favourites' })).toBeTruthy();
      spy.mockRestore();
    });
  });
});

// Design §4: a missing dependency costs exactly one capability, and the
// control it costs is DISABLED WITH THE REASON ATTACHED, never hidden. A
// control that vanished teaches the person nothing.
describe('LaunchBar degrades per capability', () => {
  const cap = (available: boolean, reason: string | null = null) =>
    ({ available, reason, warning: null });

  function withReadiness(launchCaps: { claude: ReturnType<typeof cap>; codex: ReturnType<typeof cap> }) {
    const readiness = {
      checkedAt: '2026-09-21T12:00:00.000Z',
      checks: [],
      launch: launchCaps,
      attach: cap(true),
      history: cap(true),
    };
    (globalThis as never as { window: { fleet: Record<string, unknown> } }).window.fleet = {
      launch, chooseDirectory,
      hooksGet: vi.fn(async () => ({ installed: false, error: null })),
      hooksSet: vi.fn(async () => ({ installed: false, error: null })),
      checksGet: vi.fn(async () => ({ status: 'ready', readiness })),
      checksRun: vi.fn(),
      onChecks: () => () => {},
    };
  }

  it('disables Launch and says why when the provider cannot run', async () => {
    withReadiness({ claude: cap(false, 'tmux is not installed.'), codex: cap(true) });
    render(<LaunchBar onLaunched={vi.fn()} />);
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Launch' }) as HTMLButtonElement).disabled).toBe(true);
    });
    // The reason in words, not only as a tooltip: a tooltip is not an
    // explanation for anyone on a keyboard or a screen reader.
    expect(screen.getByText('tmux is not installed.')).toBeTruthy();
  });

  it('keeps both providers in the list, marked, rather than hiding one', async () => {
    withReadiness({ claude: cap(false, 'Claude Code is not installed.'), codex: cap(true) });
    render(<LaunchBar onLaunched={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/Claude \(unavailable\)/)).toBeTruthy());
    // Codex is untouched: one missing tool costs exactly one option.
    expect(screen.getByText('Codex')).toBeTruthy();
  });

  it('never launches a provider it has just said cannot run', async () => {
    withReadiness({ claude: cap(false, 'Claude Code is not installed.'), codex: cap(true) });
    render(<LaunchBar onLaunched={vi.fn()} />);
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Launch' }) as HTMLButtonElement).disabled).toBe(true);
    });
    fireEvent.submit(screen.getByRole('button', { name: 'Launch' }).closest('form')!);
    expect(launch).not.toHaveBeenCalled();
  });

  it('leaves everything enabled while the first sweep has not finished', async () => {
    (globalThis as never as { window: { fleet: Record<string, unknown> } }).window.fleet = {
      launch, chooseDirectory,
      hooksGet: vi.fn(async () => ({ installed: false, error: null })),
      hooksSet: vi.fn(async () => ({ installed: false, error: null })),
      checksGet: vi.fn(async () => ({ status: 'running' })),
      checksRun: vi.fn(),
      onChecks: () => () => {},
    };
    render(<LaunchBar onLaunched={vi.fn()} />);
    // The app assumes it works rather than locking its own controls on no
    // evidence -- a wrongly disabled Launch is worse than a launch that
    // fails with a real message.
    expect((screen.getByRole('button', { name: 'Launch' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

// Naming a session as it launches (design artifact FYpoko2voK1xdg5AXenBjf).
// Launch stays one click and launches unnamed; the attached chevron opens
// the options -- today just a name.
describe('LaunchBar: naming a session at launch', () => {
  function openOptions() {
    fireEvent.click(screen.getByRole('button', { name: 'Launch options' }));
  }

  it('offers a category field in the dropdown, alongside the name', () => {
    render(<LaunchBar onLaunched={() => {}} />);
    openOptions();
    expect(screen.getByLabelText('Category')).toBeTruthy();
  });

  // The name field is disabled for Codex because the CLI has no name flag.
  // A category never touches the CLI, so that reason does not carry over.
  it('keeps the category field usable for Codex, where the name field is not', () => {
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'codex' } });
    openOptions();
    expect((screen.getByLabelText('Session name') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Category') as HTMLInputElement).disabled).toBe(false);
  });

  it('offers the categories that already exist, without forcing one', () => {
    assignCategory('somewhere', 'Fleet');
    const { container } = render(<LaunchBar onLaunched={() => {}} />);
    openOptions();
    const field = screen.getByLabelText('Category') as HTMLInputElement;
    const list = container.querySelector(`datalist#${field.getAttribute('list')}`);
    expect([...list!.querySelectorAll('option')].map(o => o.getAttribute('value'))).toEqual(['Fleet']);
  });

  it('files the new session under the typed category once discovery names it', async () => {
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/proj' } });
    openOptions();
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Fleet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch with this name' }));
    await waitFor(() => expect(launch).toHaveBeenCalled());
    // The NAME exists at once -- typing it was the creation act. The
    // ASSIGNMENT does not, because there is no session id at spawn.
    expect(categoryNames()).toEqual(['Fleet']);
    expect(getGroups().assignments).toEqual({});
    // The push that finally resolves pid 4821 is what files it.
    resolvePendingCategories([{ pid: 4821, sessionId: 's9' }]);
    expect(categoryOfSession('s9')).toBe('Fleet');
  });

  // The picker, rendered: a name typed for one launch is immediately on
  // offer for the next one, with nothing resolved in between.
  it('offers a just-launched category in the dropdown for the next launch', async () => {
    const { container } = render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/proj' } });
    openOptions();
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Fleet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch with this name' }));
    await waitFor(() => expect(launch).toHaveBeenCalled());

    openOptions();
    const field = screen.getByLabelText('Category') as HTMLInputElement;
    expect(field.value).toBe(''); // the panel was cleared, as it always is
    const list = container.querySelector(`datalist#${field.getAttribute('list')}`);
    expect([...list!.querySelectorAll('option')].map(o => o.getAttribute('value'))).toEqual(['Fleet']);
  });

  it('carries no category from the main Launch half, which opens no panel', async () => {
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/proj' } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    await waitFor(() => expect(launch).toHaveBeenCalled());
    resolvePendingCategories([{ pid: 4821, sessionId: 's9' }]);
    expect(categoryOfSession('s9')).toBeNull();
  });

  it('discards a typed category when the panel is closed without launching', () => {
    render(<LaunchBar onLaunched={() => {}} />);
    openOptions();
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Fleet' } });
    fireEvent.keyDown(window, { key: 'Escape' });
    openOptions();
    expect((screen.getByLabelText('Category') as HTMLInputElement).value).toBe('');
  });

  it('keeps a typed category when the provider is switched, since it never reaches the CLI', () => {
    render(<LaunchBar onLaunched={() => {}} />);
    openOptions();
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Fleet' } });
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'codex' } });
    expect((screen.getByLabelText('Category') as HTMLInputElement).value).toBe('Fleet');
  });

  it('leaves the main half exactly as it was -- one click, no name', async () => {
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/proj' } });
    // No dropdown is open, and none has to be.
    expect(screen.queryByLabelText('Session name')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    await waitFor(() =>
      expect(launch).toHaveBeenCalledWith('claude', '/tmp/proj', expect.any(Number), expect.any(Number), null));
  });

  it('opens a name field from the chevron, with the kind of name Claude derives as its placeholder', () => {
    render(<LaunchBar onLaunched={() => {}} />);
    openOptions();
    const field = screen.getByLabelText('Session name') as HTMLInputElement;
    expect(field.placeholder).toBe('llm-workspace-4a');
    expect(field.disabled).toBe(false);
  });

  it("launches with the typed name from the dropdown's own Launch button", async () => {
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/proj' } });
    openOptions();
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'FLEET STUFF' } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch with this name' }));
    await waitFor(() => expect(launch)
      .toHaveBeenCalledWith('claude', '/tmp/proj', expect.any(Number), expect.any(Number), 'FLEET STUFF'));
  });

  it('launches on Enter in the name field', async () => {
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/proj' } });
    openOptions();
    const field = screen.getByLabelText('Session name');
    fireEvent.change(field, { target: { value: 'FLEET STUFF' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(launch)
      .toHaveBeenCalledWith('claude', '/tmp/proj', expect.any(Number), expect.any(Number), 'FLEET STUFF'));
  });

  it('treats a blank name as an ordinary unnamed launch, not an error', async () => {
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/proj' } });
    openOptions();
    fireEvent.click(screen.getByRole('button', { name: 'Launch with this name' }));
    await waitFor(() =>
      expect(launch).toHaveBeenCalledWith('claude', '/tmp/proj', expect.any(Number), expect.any(Number), null));
  });

  it('trims surrounding whitespace rather than refusing what looks like a fine name', async () => {
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/proj' } });
    openOptions();
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: '  FLEET STUFF  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch with this name' }));
    await waitFor(() => expect(launch)
      .toHaveBeenCalledWith('claude', '/tmp/proj', expect.any(Number), expect.any(Number), 'FLEET STUFF'));
  });

  it('closes the dropdown once a launch succeeds, and clears the name with it', async () => {
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/proj' } });
    openOptions();
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'FLEET STUFF' } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch with this name' }));
    await waitFor(() => expect(screen.queryByLabelText('Session name')).toBeNull());
    openOptions();
    expect((screen.getByLabelText('Session name') as HTMLInputElement).value).toBe('');
  });

  // The security point, from the UI side: a name a shell would act on is
  // REFUSED with the reason, never quietly mangled into something else and
  // never sent. Each case is named for the character that makes it
  // dangerous, so a regression names itself in the test output. main
  // refuses these again at the IPC boundary (tests/main/launch.test.ts) --
  // this half is the immediate feedback, not the enforcement.
  describe('refuses a name a shell would act on', () => {
    const attacks: [label: string, name: string][] = [
      ['a semicolon', 'proj; rm -rf ~'],
      ['a command substitution $()', 'proj$(rm -rf ~)'],
      ['backticks', 'proj`rm -rf ~`'],
      ['a single quote', "proj' ; echo x ; '"],
      ['a double quote', 'proj" ; echo x ; "'],
      ['a tilde, which a shell expands to $HOME', 'proj ~'],
      ['a pipe', 'proj | rm -rf ~'],
      ['a leading dash, which claude would read as another flag', '--dangerously-skip-permissions'],
    ];
    for (const [label, name] of attacks) {
      it(`rejects ${label}, saying why and sending nothing`, async () => {
        render(<LaunchBar onLaunched={() => {}} />);
        fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/proj' } });
        openOptions();
        fireEvent.change(screen.getByLabelText('Session name'), { target: { value: name } });
        fireEvent.click(screen.getByRole('button', { name: 'Launch with this name' }));
        expect(await screen.findByText(/letters, numbers/i)).toBeTruthy();
        expect(launch).not.toHaveBeenCalled();
        // The typed text is still there to correct -- refused, not mangled.
        expect((screen.getByLabelText('Session name') as HTMLInputElement).value).toBe(name);
      });
    }
  });

  // A newline is NOT in the list above, and the reason is worth recording
  // rather than leaving as a silent gap: an <input type="text"> strips CR
  // and LF in the DOM's own value-sanitization algorithm, so a newline
  // cannot reach this component from this field at all -- typed or pasted.
  // The defence that actually matters for it is main's, which refuses a
  // newline in the name outright (tests/main/launch.test.ts, "rejects a
  // newline"); this only proves the field is not quietly carrying one.
  it('cannot carry a newline at all -- the field strips it before this component sees it', () => {
    render(<LaunchBar onLaunched={() => {}} />);
    openOptions();
    const field = screen.getByLabelText('Session name') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'proj\nsecond line' } });
    expect(field.value).not.toContain('\n');
  });

  it('refuses a name past the length cap, and says the length is the problem', async () => {
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/proj' } });
    openOptions();
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'a'.repeat(65) } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch with this name' }));
    expect(await screen.findByText(/too long/i)).toBeTruthy();
    expect(launch).not.toHaveBeenCalled();
  });

  // Disabled WITH THE REASON, never hidden -- the same call this app
  // already makes for a missing dependency and for the mode chip on a
  // session it did not launch.
  it('disables the field for Codex and says why, rather than hiding it', () => {
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'codex' } });
    openOptions();
    const field = screen.getByLabelText('Session name') as HTMLInputElement;
    expect(field).toBeTruthy();
    expect(field.disabled).toBe(true);
    expect(screen.getByText(/Codex has no way to set a name when it starts/i)).toBeTruthy();
  });

  it('still launches Codex from the dropdown, just without a name', async () => {
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'codex' } });
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/proj' } });
    openOptions();
    fireEvent.click(screen.getByRole('button', { name: 'Launch with this name' }));
    await waitFor(() =>
      expect(launch).toHaveBeenCalledWith('codex', '/tmp/proj', expect.any(Number), expect.any(Number), null));
  });

  // A name typed while Claude was selected must not be smuggled into a
  // Codex launch by switching the provider afterwards.
  it('drops a typed name when the provider is switched to Codex', async () => {
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/proj' } });
    openOptions();
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'FLEET STUFF' } });
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'codex' } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch with this name' }));
    await waitFor(() =>
      expect(launch).toHaveBeenCalledWith('codex', '/tmp/proj', expect.any(Number), expect.any(Number), null));
  });

  it('closes on Escape and returns focus to the chevron', () => {
    render(<LaunchBar onLaunched={() => {}} />);
    openOptions();
    expect(screen.getByLabelText('Session name')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByLabelText('Session name')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Launch options' }));
  });

  it('closes on a click outside it', () => {
    render(<LaunchBar onLaunched={() => {}} />);
    openOptions();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByLabelText('Session name')).toBeNull();
  });

  // This is what lets the main Launch half stay unnamed without ever
  // silently discarding a name: closing the panel visibly throws the typed
  // text away, so there is never an invisible name waiting to be dropped.
  it('discards a typed name when the panel is closed without launching', async () => {
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/proj' } });
    openOptions();
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'FLEET STUFF' } });
    fireEvent.keyDown(window, { key: 'Escape' });
    openOptions();
    expect((screen.getByLabelText('Session name') as HTMLInputElement).value).toBe('');
    // And the main half launches unnamed, as it always did.
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    await waitFor(() =>
      expect(launch).toHaveBeenCalledWith('claude', '/tmp/proj', expect.any(Number), expect.any(Number), null));
  });

  it('reports its expanded state, so the chevron is not a mystery to a screen reader', () => {
    render(<LaunchBar onLaunched={() => {}} />);
    const chevron = screen.getByRole('button', { name: 'Launch options' });
    expect(chevron.getAttribute('aria-expanded')).toBe('false');
    openOptions();
    expect(chevron.getAttribute('aria-expanded')).toBe('true');
  });

  it('goes inert with the rest of the bar during the first-run takeover', () => {
    render(<LaunchBar onLaunched={() => {}} disabled />);
    expect((screen.getByRole('button', { name: 'Launch options' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
