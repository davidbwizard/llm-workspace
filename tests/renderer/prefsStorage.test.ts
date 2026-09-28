import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readPref, writePref, migratePrefsOnce } from '../../src/renderer/state/prefsStorage.ts';

// Every other renderer test runs without window.fleet, so they all exercise
// the localStorage FALLBACK. These are the ones that cover the path the app
// actually takes.
const withApi = (over: Record<string, unknown> = {}) => {
  const api = {
    prefs: {} as Record<string, string>,
    setPref: vi.fn(async () => ({ ok: true })),
    migratePrefs: vi.fn(async () => ({ taken: [], prefs: {} })),
    ...over,
  };
  (window as unknown as { fleet?: unknown }).fleet = api;
  return api;
};

beforeEach(() => { localStorage.clear(); });
afterEach(() => { delete (window as unknown as { fleet?: unknown }).fleet; });

describe('reading', () => {
  it('prefers main\'s store over localStorage', () => {
    localStorage.setItem('llmws:settings', '"stale"');
    withApi({ prefs: { 'llmws:settings': '"current"' } });
    expect(readPref('llmws:settings')).toBe('"current"');
  });

  it('falls back to localStorage for a key main does not have yet', () => {
    // Before migration has run, the person's existing values are still only
    // in localStorage -- so nothing depends on migration having finished.
    localStorage.setItem('llmws:settings', '"mine"');
    withApi({ prefs: {} });
    expect(readPref('llmws:settings')).toBe('"mine"');
  });

  it('falls back when there is no API at all', () => {
    // A preload that threw leaves a normal-looking window with no API.
    localStorage.setItem('llmws:settings', '"mine"');
    expect(readPref('llmws:settings')).toBe('"mine"');
  });

  it('is null when neither has it', () => {
    withApi({ prefs: {} });
    expect(readPref('llmws:settings')).toBeNull();
  });

  it('distinguishes a stored empty string from a missing key', () => {
    withApi({ prefs: { 'llmws:settings': '' } });
    expect(readPref('llmws:settings')).toBe('');
  });
});

describe('writing', () => {
  it('sends the write to main and does not touch localStorage', () => {
    const api = withApi();
    writePref('llmws:settings', '{"a":1}');
    expect(api.setPref).toHaveBeenCalledWith('llmws:settings', '{"a":1}');
    expect(localStorage.getItem('llmws:settings')).toBeNull();
  });

  it('updates the snapshot so a read straight after sees the new value', () => {
    // Without this, a read between the write and the IPC round trip would
    // return the old value.
    withApi({ prefs: { 'llmws:settings': '"old"' } });
    writePref('llmws:settings', '"new"');
    expect(readPref('llmws:settings')).toBe('"new"');
  });

  it('writes to localStorage when there is no API, rather than dropping it', () => {
    writePref('llmws:settings', '{"a":1}');
    expect(localStorage.getItem('llmws:settings')).toBe('{"a":1}');
  });

  it('reports a rejected write instead of throwing it at the caller', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    withApi({ setPref: vi.fn(async () => { throw new Error('disk gone'); }) });
    expect(() => writePref('llmws:settings', '{}')).not.toThrow();
    await new Promise(r => setTimeout(r, 0));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('the one-time migration', () => {
  it('hands main everything in localStorage and folds the result back in', async () => {
    localStorage.setItem('llmws:settings', '"mine"');
    localStorage.setItem('unrelated', 'x');
    const api = withApi({
      migratePrefs: vi.fn(async () => ({ taken: ['llmws:settings'], prefs: { 'llmws:settings': '"mine"' } })),
    });
    migratePrefsOnce();
    expect(api.migratePrefs).toHaveBeenCalledWith(
      expect.objectContaining({ 'llmws:settings': '"mine"', unrelated: 'x' }));
    await new Promise(r => setTimeout(r, 0));
    // Folded in, so a store reading later in this session needs no reload.
    expect((api.prefs as Record<string, string>)['llmws:settings']).toBe('"mine"');
    // Asserted HERE, in the one test where the migration actually runs:
    // migratePrefsOnce guards itself with a module-level flag, so a second
    // test calling it would no-op and pass even if this code deleted
    // everything. The cost of a stale key left behind is nothing; the cost
    // of a wrong delete is somebody's favourites.
    expect(localStorage.getItem('llmws:settings')).toBe('"mine"');
    expect(localStorage.getItem('unrelated')).toBe('x');
  });
});
