import { describe, it, expect } from 'vitest';
import { createFarm, applySessionSnapshot, advanceFarm, validateFarm } from '../farm/model.mjs';
import { createSaveStore, SAVE_KEY, BACKUP_KEY, serializeFarm, parseFarm } from '../farm/storage.mjs';
import { guardHome } from '../farm/world.mjs';
const memoryStorage = () => {
  const data = new Map<string, string>();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), data };
};

describe('farm saves', () => {
  it('round trips the farm without restoring session labor or private question text', () => {
    const storage = memoryStorage(), store = createSaveStore(storage), s = createFarm();
    applySessionSnapshot(s, { version: 1, revision: 1, connected: true, sessions: [{ id: 'sensitive-session-id', name: 'Rowan', provider: 'demo', activity: 'waiting_input', attention: { id: 'secret-question', kind: 'question', text: 'private question text' } }] });
    s.inventory.wool = 7; s.coins = 80; advanceFarm(s, 10);
    store.save(s);
    expect(storage.getItem(SAVE_KEY)).not.toContain('private question text');
    expect(storage.getItem(SAVE_KEY)).not.toContain('sensitive-session-id');
    const restored = store.load().state;
    expect(restored.inventory.wool).toBe(7); expect(restored.coins).toBe(80);
    expect(restored.time).toBe(10); expect(restored.workers).toEqual([]);
    expect(restored.connected).toBe(false); expect(restored.sessionRevision).toBe(-1);
    advanceFarm(restored, 60); expect(restored.time).toBe(10);
  });
  it('recovers a corrupt primary from its previous valid save with an explicit warning', () => {
    const storage = memoryStorage(), store = createSaveStore(storage), s = createFarm();
    store.save(s); s.coins = 90; store.save(s);
    storage.setItem(SAVE_KEY, '{ broken');
    const loaded = store.load();
    expect(loaded.state.coins).toBe(35); expect(loaded.warning).toMatch(/backup/i);
    expect(storage.getItem(SAVE_KEY)).toBe('{ broken');
    store.save(loaded.state);
    expect(store.load().warning).toBeNull();
  });
  it('preserves corrupt data and refuses a silent reset when both snapshots are invalid', () => {
    const storage = memoryStorage(), store = createSaveStore(storage);
    expect(store.load().state).toBeNull();
    storage.setItem(SAVE_KEY, '{broken'); storage.setItem(BACKUP_KEY, '[]');
    expect(() => store.load()).toThrow(/save/i);
    expect(storage.getItem(SAVE_KEY)).toBe('{broken');
  });
  it('rejects unsupported versions, invalid state and oversized imports', () => {
    const s = createFarm(); s.animals[0].produce = -1;
    expect(() => serializeFarm(s)).toThrow();
    expect(() => parseFarm(JSON.stringify({ version: 9, farm: createFarm() }))).toThrow();
    expect(() => parseFarm(' '.repeat(1_048_577))).toThrow(/large/i);
  });
  it('surfaces denied storage writes without claiming the save succeeded', () => {
    const store = createSaveStore({ getItem: () => null, setItem: () => { throw new Error('Quota exceeded'); } });
    expect(() => store.save(createFarm())).toThrow(/Quota exceeded/);
  });
  it('keeps a zero-health protector resting at home alive through a save/load round trip, then heals and resumes patrol', () => {
    const s = createFarm();
    Object.assign(s.guards[0], { mode: 'home', health: 0, ...guardHome(0) });
    const restored = parseFarm(serializeFarm(s));
    expect(validateFarm(restored)).toBe(true);
    expect(restored.guards[0].health).toBe(0); expect(restored.guards[0].mode).toBe('home');
    restored.connected = true; restored.policy.autoHeal = false; restored.raidTimer = 1000;
    for (let n = 0; n < 100; n++) advanceFarm(restored, 1);
    expect(restored.guards.some(g => g.id === 'guard-1')).toBe(true);
    expect(restored.guards[0].mode).toBe('patrol');
    expect(restored.guards[0].health).toBe(restored.guards[0].maxHealth);
  });
});
