import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, compactIn, getSettings, normalizeSettings,
  reloadSettings, setSettings, subscribeSettings,
} from '../../src/renderer/state/settings.ts';

beforeEach(() => {
  localStorage.clear();
  reloadSettings();
});

describe('normalizeSettings', () => {
  it('accepts a complete, valid object unchanged', () => {
    const s = { appearance: 'dark', textSize: 14, messageStyle: 'c', compactCards: 'off', groupSessions: 'off' };
    expect(normalizeSettings(s)).toEqual(s);
  });

  // Every value is checked against its own allowed set, with a fallback to
  // the default -- the same rule SessionRail's stored width already uses
  // (clamp, never render verbatim). A stored blob is per-viewer data this
  // code wrote, but it is still data on disk that anything could have
  // touched, so it is validated, not trusted.
  it.each([
    ['an unknown appearance', { appearance: 'sepia' }, 'appearance', 'system'],
    ['a text size outside the offered range', { textSize: 40 }, 'textSize', 16],
    ['a text size that is not a number', { textSize: '16' }, 'textSize', 16],
    ['an unknown message style', { messageStyle: 'b' }, 'messageStyle', 'a'],
    ['an unknown compact-cards value', { compactCards: 'yes' }, 'compactCards', 'both'],
  ])('falls back to the default for %s', (_label, patch, key, fallback) => {
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, ...patch })[key as keyof typeof DEFAULT_SETTINGS])
      .toBe(fallback);
  });

  it('fills in missing keys rather than returning a partial object', () => {
    expect(normalizeSettings({ appearance: 'light' }))
      .toEqual({ ...DEFAULT_SETTINGS, appearance: 'light' });
  });

  it.each([['null', null], ['an array', []], ['a string', 'dark'], ['a number', 3]])(
    'returns the defaults for %s', (_label, raw) => {
      expect(normalizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
    });
});

describe('the settings store', () => {
  it('starts at the documented defaults with nothing stored', () => {
    expect(getSettings()).toEqual({
      appearance: 'system', textSize: 16, messageStyle: 'a', compactCards: 'both', groupSessions: 'on',
    });
  });

  it('reads a stored value back on reload -- the restart path', () => {
    setSettings({ textSize: 14, appearance: 'dark' });
    reloadSettings();
    expect(getSettings()).toMatchObject({ textSize: 14, appearance: 'dark' });
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!)).toMatchObject({ textSize: 14 });
  });

  it('uses one namespaced key, and never disturbs the rail\'s own', () => {
    localStorage.setItem('llmws:rail-width', '204');
    setSettings({ textSize: 17 });
    expect(localStorage.getItem('llmws:rail-width')).toBe('204');
    expect(Object.keys(localStorage).filter(k => k.startsWith('llmws:')).sort())
      .toEqual(['llmws:rail-width', 'llmws:settings']);
  });

  it('ignores a corrupt blob rather than throwing or rendering it', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, '{not json');
    expect(() => reloadSettings()).not.toThrow();
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  // localStorage throws in a locked-down or private-mode context. A UI
  // preference is never worth taking the window down over -- the same
  // reasoning as readStoredRailWidth's own try/catch.
  it('never throws when localStorage itself is unavailable', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => setSettings({ textSize: 15 })).not.toThrow();
    expect(() => reloadSettings()).not.toThrow();
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
    setItem.mockRestore();
    getItem.mockRestore();
  });

  it('notifies subscribers on a real change, and not on a no-op write', () => {
    const cb = vi.fn();
    const unsubscribe = subscribeSettings(cb);
    setSettings({ textSize: 15 });
    expect(cb).toHaveBeenCalledTimes(1);
    setSettings({ textSize: 15 });
    expect(cb).toHaveBeenCalledTimes(1);
    unsubscribe();
    setSettings({ textSize: 17 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('hands out a stable snapshot until something actually changes', () => {
    const before = getSettings();
    setSettings({ textSize: 16 }); // already the default
    expect(getSettings()).toBe(before);
    setSettings({ textSize: 17 });
    expect(getSettings()).not.toBe(before);
  });

  it('validates what it is given, not only what it reads back', () => {
    setSettings({ appearance: 'sepia' as never });
    expect(getSettings().appearance).toBe('system');
  });
});

describe('groupSessions', () => {
  it('defaults to on', () => {
    expect(DEFAULT_SETTINGS.groupSessions).toBe('on');
  });

  it('keeps a valid value and falls back to the default for anything else', () => {
    expect(normalizeSettings({ groupSessions: 'off' }).groupSessions).toBe('off');
    expect(normalizeSettings({ groupSessions: 'sometimes' }).groupSessions).toBe('on');
    expect(normalizeSettings({ groupSessions: null }).groupSessions).toBe('on');
  });

  it('round-trips through setSettings', () => {
    setSettings({ groupSessions: 'off' });
    expect(getSettings().groupSessions).toBe('off');
    reloadSettings();
    expect(getSettings().groupSessions).toBe('off');
  });

  it('changes the object identity, so subscribers re-render', () => {
    const before = getSettings();
    setSettings({ groupSessions: 'off' });
    expect(getSettings()).not.toBe(before);
  });
});

describe('compactIn', () => {
  it.each([
    ['off', false, false],
    ['sidebar', true, false],
    ['fleet', false, true],
    ['both', true, true],
  ])('%s', (value, sidebar, fleet) => {
    const s = { ...DEFAULT_SETTINGS, compactCards: value as never };
    expect(compactIn(s, 'sidebar')).toBe(sidebar);
    expect(compactIn(s, 'fleet')).toBe(fleet);
  });
});
