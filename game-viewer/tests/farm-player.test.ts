import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createFarm, advanceFarm, moveFarmer, command, validateFarm } from '../farm/model.mjs';
import { parseFarm, serializeFarm } from '../farm/storage.mjs';
import { plotPosition, monsterPosition } from '../farm/world.mjs';

describe('the player farmer', () => {
  it('moves at a consistent speed, normalizes diagonals, and stops on release', () => {
    const a = createFarm(), b = createFarm();
    a.farmer.x = b.farmer.x = 300; a.farmer.y = b.farmer.y = 310;
    expect(moveFarmer(a, 1, 0, .5)).toBe(true);
    moveFarmer(b, 1, 1, .5);
    expect(a.farmer.x).toBe(340);
    expect(Math.hypot(b.farmer.x - 300, b.farmer.y - 310)).toBeCloseTo(40);
    expect(a.farmer.action).toBe('walk');
    moveFarmer(a, 0, 0, .05);
    expect(a.farmer.action).toBe('idle');
    const c = createFarm(); c.farmer.x = 300; c.farmer.y = 310;
    for (let n = 0; n < 10; n++) moveFarmer(c, 1, 0, .05);
    moveFarmer(c, 0, 0, .05);
    expect(c.farmer).toEqual(a.farmer);
  });
  it('respects the map edge, farmhouse, and pond without tunnelling on a slow frame', () => {
    const s = createFarm(); s.farmer.x = 10; s.farmer.y = 150;
    moveFarmer(s, -1, 0, 2); expect(s.farmer.x).toBe(0);
    s.farmer.x = 90; s.farmer.y = 125;
    moveFarmer(s, 0, -1, 2); expect(s.farmer.y).toBeGreaterThanOrEqual(93);
    s.farmer.x = 120; s.farmer.y = 290;
    moveFarmer(s, -1, 0, 2); expect(s.farmer.x).toBeGreaterThanOrEqual(98);
    expect(validateFarm(s)).toBe(true);
  });
  it('rejects malformed movement atomically and freezes when disconnected or injured', () => {
    const s = createFarm(), before = structuredClone(s);
    for (const args of [[NaN, 0, 1], [2, 0, .1], [1, 0, -1], [0, 1, Infinity]]) {
      expect(() => moveFarmer(s, ...args)).toThrow();
      expect(s).toEqual(before);
    }
    s.connected = false; expect(moveFarmer(s, 1, 0, 1)).toBe(false);
    s.connected = true; s.mainHealth = 5;
    expect(moveFarmer(s, 1, 0, 1)).toBe(false);
    expect(s.farmer).toEqual(before.farmer);
  });
  it('harvests a nearby ripe crop once and makes distant swings harmless', () => {
    const s = createFarm(); s.raidTimer = 1000;
    Object.assign(s.plots[0], { stage: 'ready', growth: 75, water: 80 });
    command(s, { type: 'interact' }); advanceFarm(s, 1);
    const p = plotPosition(0); Object.assign(s.farmer, { x: p.x, y: p.y });
    command(s, { type: 'interact' });
    expect(s.inventory.parsnip).toBe(2); expect(s.plots[0].stage).toBe('empty');
    expect(s.farmer.action).toBe('harvest');
    advanceFarm(s, 1);
    command(s, { type: 'interact' }); advanceFarm(s, 1);
    expect(s.inventory.parsnip).toBe(2);
  });
  it('attacks only a nearby enemy, applies cooldown, and awards defeat exactly once', () => {
    const s = createFarm(); s.guards = []; s.raidTimer = 1000;
    command(s, { type: 'raid' });
    command(s, { type: 'interact' }); advanceFarm(s, 1);
    const m = s.monsters[0]; m.x = 330; m.y = 160; m.health = 24;
    const pos = monsterPosition(m); Object.assign(s.farmer, { x: pos.x - 24, y: pos.y });
    command(s, { type: 'interact' });
    expect(m.health).toBe(12); expect(s.farmer.action).toBe('attack');
    command(s, { type: 'interact' });
    expect(m.health).toBe(12);
    advanceFarm(s, 1); command(s, { type: 'interact' });
    expect(s.monsters).toHaveLength(0); expect(s.coins).toBe(37);
    advanceFarm(s, 1); expect(s.coins).toBe(37);
  });
  it('saves position, upgrades older v1 saves, and rejects invalid new fields', () => {
    const s = createFarm(); moveFarmer(s, 1, 0, .5);
    const restored = parseFarm(serializeFarm(s));
    expect(restored.farmer.x).toBe(s.farmer.x);
    expect(restored.farmer.action).toBe('idle');
    const legacy = JSON.parse(readFileSync(new URL('./fixtures/farm-v1.json', import.meta.url), 'utf8')).farm; delete legacy.farmer;
    expect(parseFarm(JSON.stringify({ version: 1, farm: legacy })).farmer).toEqual(createFarm().farmer);
    expect(() => parseFarm(JSON.stringify({ version: 3, farm: { ...s, farmer: { ...s.farmer, x: 99999 } } }))).toThrow(/farmer/i);
    expect(() => validateFarm({ ...s, farmer: { ...s.farmer, action: '<script>' } })).toThrow(/farmer/i);
  });
});

it('each patrolling protector damages one priority target, not every incoming slime', () => {
  const s = createFarm(); command(s, { type: 'raid' }); command(s, { type: 'raid' });
  Object.assign(s.guards[0], { x: 300, y: 140 });
  Object.assign(s.monsters[0], { x: 330, y: 140 }); Object.assign(s.monsters[1], { x: 500, y: 200 });
  const [first, second] = s.monsters.map(m => m.health);
  advanceFarm(s, .25);
  expect(s.monsters[0].health).toBe(first - 7);
  expect(s.monsters[1].health).toBe(second);
  expect(s.guards[0].health).toBe(57);
});

it('keeps fighting below the old retreat threshold and lets the player redeploy a wounded protector', () => {
  const s = createFarm(); s.policy.autoHeal = false; s.raidTimer = 1000;
  Object.assign(s.guards[0], { health: 15, x: 300, y: 140 }); command(s, { type: 'raid' }); Object.assign(s.monsters[0], { x: 330, y: 140 });
  advanceFarm(s, .05); expect(s.guards[0].health).toBe(12);
  advanceFarm(s, .05); expect(s.guards[0].mode).toBe('patrol');
  command(s, { type: 'guardMode', guardId: 'guard-1', mode: 'home' });
  expect(s.guards[0].mode).toBe('home');
  expect(() => command(s, { type: 'guardMode', guardId: 'guard-1', mode: 'patrol' })).not.toThrow();
  expect(s.guards[0].mode).toBe('patrol');
});
