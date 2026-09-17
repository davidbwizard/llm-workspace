import { describe, it, expect } from 'vitest';
import { createFarm, advanceFarm, command, applySessionSnapshot, validateFarm } from '../farm/model.mjs';
import { guardHome, plotPosition, animalPosition } from '../farm/world.mjs';
import { EXPEDITION_TIME } from '../farm/definitions.mjs';

const session = (id = 'a', extra = {}) => ({ id, name: id, provider: 'demo', activity: 'working', parentId: null, attention: null, ...extra });
const snapshot = (sessions = [session()], revision = 1, connected = true) => ({ version: 1, revision, connected, sessions });
function run(state, seconds) { for (let n = 0; n < seconds; n++) advanceFarm(state, 1); }

describe('session labor and crop care', () => {
  it('folds children into one worker, respects attention, and rejects stale snapshots', () => {
    const s = createFarm();
    applySessionSnapshot(s, snapshot([session('a', { activity: 'idle' }), ...Array.from({ length: 30 }, (_, i) => session(`child-${i}`, { parentId: 'a' }))]));
    expect(s.workers).toHaveLength(1);
    expect(s.workers[0].activity).toBe('working');
    applySessionSnapshot(s, snapshot([session('a', { activity: 'waiting_input', attention: { id: 'q1', kind: 'question', text: 'Choose a folder?' } }), session('child', { parentId: 'a' })], 2));
    expect(s.workers[0].activity).toBe('waiting_input');
    expect(s.workers[0].attention.text).toBe('Choose a folder?');
    expect(applySessionSnapshot(s, snapshot([], 1))).toBe(false);
    expect(s.workers).toHaveLength(1);
  });
  it('grows and harvests a crop through real jobs without duplicate rewards', () => {
    const s = createFarm();
    applySessionSnapshot(s, snapshot());
    command(s, { type: 'assign', workerId: 'a', targetId: 'p1' });
    run(s, 210);
    expect(s.plots[0].stage).toBe('ready');
    expect(s.inventory.parsnip).toBe(0);
    Object.assign(s.farmer, plotPosition(0));
    command(s, { type: 'harvest', plotId: 'p1' });
    expect(s.inventory.parsnip).toBe(2);
    expect(s.plots[0].stage).toBe('empty');
    expect(() => command(s, { type: 'harvest', plotId: 'p1' })).toThrow();
    expect(s.inventory.parsnip).toBe(2);
  });
  it('keeps progress when a finished worker is replaced', () => {
    const s = createFarm();
    applySessionSnapshot(s, snapshot());
    command(s, { type: 'assign', workerId: 'a', targetId: 'p1' });
    run(s, 30);
    const progress = s.plots[0].growth;
    expect(progress).toBeGreaterThan(0);
    applySessionSnapshot(s, snapshot([], 2));
    run(s, 5);
    applySessionSnapshot(s, snapshot([session('b')], 3));
    command(s, { type: 'assign', workerId: 'b', targetId: 'p1' });
    run(s, 170);
    expect(s.plots[0].growth).toBeGreaterThanOrEqual(progress);
    expect(s.plots[0].stage).toBe('ready');
  });
  it('does not grant labor to idle sessions, and neglected crops die', () => {
    const s = createFarm();
    Object.assign(s.plots[0], { stage: 'growing', water: 0, growth: 10 });
    applySessionSnapshot(s, snapshot([session('a', { activity: 'idle' })]));
    s.raidTimer = 1000;
    run(s, 150);
    expect(s.plots[0].stage).toBe('dead');
    expect(s.plots[1].stage).toBe('empty');
  });
  it('freezes simulation on disconnection and advances identically across frame partitions', () => {
    const a = createFarm(), b = createFarm();
    applySessionSnapshot(a, snapshot()); applySessionSnapshot(b, snapshot());
    advanceFarm(a, 10);
    for (let i = 0; i < 100; i++) advanceFarm(b, 0.1);
    expect(b).toEqual(a);
    applySessionSnapshot(a, snapshot([], 2, false));
    const before = structuredClone(a);
    advanceFarm(a, 60);
    expect(a).toEqual(before);
  });
  it('keeps one owner per care job and supports clearing an assignment', () => {
    const s = createFarm(); applySessionSnapshot(s, snapshot([session('a'), session('b'), session('c')]));
    advanceFarm(s, 0.25);
    const jobs = s.workers.filter(w => w.job).map(w => w.job.targetId);
    expect(new Set(jobs).size).toBe(jobs.length);
    command(s, { type: 'assign', workerId: 'a', targetId: 'p1' });
    command(s, { type: 'assign', workerId: 'a', targetId: 'auto' });
    expect(s.workers[0].assignment).toBe('auto');
  });
  it('does not advance a job until its helper has physically walked to the target', () => {
    const s = createFarm(); applySessionSnapshot(s, snapshot());
    command(s, { type: 'assign', workerId: 'a', targetId: 'p1' });
    advanceFarm(s, 0.05);
    const worker = s.workers[0];
    expect(worker.job).toMatchObject({ targetId: 'p1', kind: 'till', progress: 0 });
    // Placed far from the plot: time passing alone must not finish the job.
    Object.assign(worker, { x: 400, y: 172 });
    advanceFarm(s, 0.05);
    expect(worker.job.progress).toBe(0);
    expect(s.plots[0].stage).toBe('empty');
    // Placed right beside the plot's work spot: progress can now begin.
    Object.assign(worker, { x: plotPosition(0).x - 9, y: plotPosition(0).y + 12 });
    advanceFarm(s, 0.05);
    expect(worker.job.progress).toBeGreaterThan(0);
  });
  it('leaves a destroyed plot ruined until a helper walks over to clear and replant it', () => {
    const s = createFarm(); applySessionSnapshot(s, snapshot());
    Object.assign(s.plots[0], { stage: 'dead', health: 0 });
    command(s, { type: 'assign', workerId: 'a', targetId: 'p1' });
    advanceFarm(s, 0.05);
    const worker = s.workers[0];
    expect(worker.job.kind).toBe('clear');
    Object.assign(worker, { x: 400, y: 172 });
    advanceFarm(s, 0.05);
    expect(s.plots[0].stage).toBe('dead');
    expect(worker.job.progress).toBe(0);
    Object.assign(worker, { x: plotPosition(0).x - 9, y: plotPosition(0).y + 12 });
    run(s, 8); // clear, till and plant each take a few seconds once the helper has arrived
    expect(s.plots[0].stage).toBe('growing');
  });
});

describe('production, money, and protection', () => {
  it('produces milk and wool with care, collects once, and converts a selected animal once', () => {
    const s = createFarm(); s.raidTimer = 1000;
    run(s, 185);
    expect(s.animals[0].produce).toBe(1);
    expect(s.animals[1].produce).toBe(1);
    Object.assign(s.farmer, animalPosition(0));
    command(s, { type: 'collect', animalId: 'cow-1' });
    expect(s.inventory.milk).toBe(1);
    expect(() => command(s, { type: 'collect', animalId: 'cow-1' })).toThrow();
    command(s, { type: 'slaughter', animalId: 'cow-1' });
    expect(s.inventory.meat).toBe(5);
    expect(s.inventory.hide).toBe(2);
    expect(() => command(s, { type: 'slaughter', animalId: 'cow-1' })).toThrow();
    expect(s.inventory.meat).toBe(5);
  });
  it('rejects unaffordable/invalid purchases without changing state and trades exact quantities', () => {
    const s = createFarm(); s.coins = 0;
    const before = structuredClone(s);
    expect(() => command(s, { type: 'buy', item: 'cow' })).toThrow();
    expect(s).toEqual(before);
    s.inventory.parsnip = 3;
    command(s, { type: 'sell', item: 'parsnip', quantity: 2 });
    expect(s.inventory.parsnip).toBe(1);
    expect(s.coins).toBe(8);
    expect(() => command(s, { type: 'sell', item: 'parsnip', quantity: -1 })).toThrow();
    expect(() => command(s, { type: 'buy', item: '__proto__' })).toThrow();
  });
  it('honors automatic harvest and sale separately', () => {
    const s = createFarm(); applySessionSnapshot(s, snapshot());
    command(s, { type: 'assign', workerId: 'a', targetId: 'p1' });
    command(s, { type: 'policy', key: 'autoHarvest', value: true });
    run(s, 210);
    expect(s.inventory.parsnip).toBeGreaterThan(0);
    const coins = s.coins;
    command(s, { type: 'policy', key: 'autoSell', value: true });
    advanceFarm(s, 0.25);
    expect(s.inventory.parsnip).toBe(0);
    expect(s.coins).toBeGreaterThan(coins);
  });
  it('protectors fight threats, take damage, and can be healed and deployed', () => {
    const s = createFarm(); s.raidTimer = 1000;
    command(s, { type: 'policy', key: 'autoHeal', value: false });
    command(s, { type: 'raid' });
    run(s, 30);
    expect(s.monsters).toHaveLength(0);
    expect(s.guards[0].health).toBeLessThan(60);
    const medicine = s.inventory.medicine;
    command(s, { type: 'heal', targetId: 'guard-1' });
    expect(s.inventory.medicine).toBe(medicine - 1);
    command(s, { type: 'guardMode', guardId: 'guard-1', mode: 'expedition' });
    const coins = s.coins;
    run(s, 185);
    expect(s.coins).toBeGreaterThan(coins);
    expect(s.guards[0].mode).toBe('home');
  });
  it('has a recovery route without generating unlimited free seed inventory', () => {
    const s = createFarm(); s.coins = 0; s.inventory.seeds = 0;
    command(s, { type: 'recover' });
    expect(s.inventory.seeds).toBeGreaterThan(0);
    expect(() => command(s, { type: 'recover' })).toThrow();
  });
  it('rejects malformed state, bad elapsed time, and malformed session feeds atomically', () => {
    const s = createFarm(); expect(validateFarm(s)).toBe(true);
    expect(() => validateFarm({ ...s, coins: -1 })).toThrow();
    expect(() => validateFarm({ ...s, inventory: { ...s.inventory, milk: NaN } })).toThrow();
    expect(() => advanceFarm(s, Infinity)).toThrow();
    expect(() => advanceFarm(s, -1)).toThrow();
    const before = structuredClone(s);
    expect(() => applySessionSnapshot(s, snapshot([session('a'), session('a')]))).toThrow();
    expect(s).toEqual(before);
    expect(() => applySessionSnapshot(s, snapshot([session('a', { parentId: 'b' }), session('b', { parentId: 'a' })]))).toThrow();
    expect(() => command(s, { type: 'policy', key: '__proto__', value: true })).toThrow();
  });
  it('keeps a dead plot saveable when choosing a crop with a shorter growth cycle', () => {
    const s = createFarm(); Object.assign(s.plots[0], { crop: 'wheat', stage: 'dead', health: 0, growth: 100 });
    expect(validateFarm(s)).toBe(true);
    command(s, { type: 'crop', plotId: 'p1', crop: 'parsnip' });
    expect(validateFarm(s)).toBe(true);
  });
  it('releases care jobs in the same tick that an animal dies', () => {
    const s = createFarm(); applySessionSnapshot(s, snapshot());
    s.animals[0].hunger = 0; s.animals[0].health = 0.01; s.policy.autoHeal = false;
    s.inventory.feed = 0;
    s.workers[0].job = { targetId: 'cow-1', kind: 'feed', duration: 3, progress: 0 };
    expect(validateFarm(s)).toBe(true);
    advanceFarm(s, 0.05);
    expect(s.animals.some(a => a.id === 'cow-1')).toBe(false);
    expect(s.workers[0].job).toBeNull();
    expect(validateFarm(s)).toBe(true);
  });
  it('kills a patrolling protector permanently in combat and journals its death, upgrades included', () => {
    const s = createFarm(); s.policy.autoHeal = false; s.raidTimer = 1000; s.coins = 100;
    command(s, { type: 'upgradeGuard', guardId: 'guard-1' });
    Object.assign(s.guards[0], { health: 1, x: 300, y: 140 });
    command(s, { type: 'raid' }); Object.assign(s.monsters[0], { x: 330, y: 140 });
    advanceFarm(s, .05);
    expect(s.guards.some(g => g.id === 'guard-1')).toBe(false);
    expect(s.events[0].text).toMatch(/scout/i);
    expect(validateFarm(s)).toBe(true);
  });
  it('sends a fully healed home protector back to patrol automatically', () => {
    const s = createFarm(); s.policy.autoHeal = false; s.raidTimer = 1000;
    Object.assign(s.guards[0], { mode: 'home', health: 1, ...guardHome(0) });
    for (let n = 0; n < 100; n++) advanceFarm(s, 1);
    expect(s.guards[0].mode).toBe('patrol');
    expect(s.guards[0].health).toBe(s.guards[0].maxHealth);
  });
  it('caps expedition wear so it cannot kill a protector', () => {
    const s = createFarm();
    Object.assign(s.guards[0], { mode: 'expedition', health: 5, progress: EXPEDITION_TIME - 0.05 });
    advanceFarm(s, 1);
    expect(s.guards[0].health).toBeGreaterThan(0);
    expect(s.guards[0].mode).toBe('home');
  });
  it('requires the farmer to stand near a plot or animal for Tend, Harvest, Collect, Heal and Slaughter', () => {
    const s = createFarm(); s.raidTimer = 1000;
    Object.assign(s.plots[0], { stage: 'tilled' }); // seeds are available: needs planting
    Object.assign(s.animals[0], { produce: 1, health: 40 });
    // The farmer starts at home, far from both the garden bed and the pasture.
    expect(() => command(s, { type: 'tend', plotId: 'p1' })).toThrow(/closer/i);
    expect(() => command(s, { type: 'collect', animalId: 'cow-1' })).toThrow(/closer/i);
    expect(() => command(s, { type: 'heal', targetId: 'cow-1' })).toThrow(/closer/i);
    expect(() => command(s, { type: 'slaughter', animalId: 'cow-1' })).toThrow(/closer/i);
    s.plots[0].stage = 'ready'; s.plots[0].growth = 180;
    expect(() => command(s, { type: 'harvest', plotId: 'p1' })).toThrow(/closer/i);
    s.plots[0].stage = 'tilled';
    // Walking beside the plot lets Tend succeed, then Harvest once it is ready.
    Object.assign(s.farmer, plotPosition(0));
    command(s, { type: 'tend', plotId: 'p1' });
    expect(s.plots[0].stage).toBe('growing');
    s.plots[0].stage = 'ready';
    command(s, { type: 'harvest', plotId: 'p1' });
    expect(s.plots[0].stage).toBe('empty');
    // Walking beside the pasture lets Collect, Heal and Slaughter succeed.
    Object.assign(s.farmer, animalPosition(0));
    command(s, { type: 'collect', animalId: 'cow-1' });
    expect(s.inventory.milk).toBe(1);
    command(s, { type: 'heal', targetId: 'cow-1' });
    expect(s.animals[0].health).toBeGreaterThan(40);
    command(s, { type: 'slaughter', animalId: 'cow-1' });
    expect(s.animals.some(a => a.id === 'cow-1')).toBe(false);
    // Healing the farmer or a protector is exempt from the proximity requirement.
    s.mainHealth = 10; s.inventory.medicine = 1;
    expect(() => command(s, { type: 'heal', targetId: 'main' })).not.toThrow();
    s.guards[0].health = 1; s.inventory.medicine = 1;
    expect(() => command(s, { type: 'heal', targetId: 'guard-1' })).not.toThrow();
  });
});
