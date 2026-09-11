import { it, expect } from 'vitest';
import { createFarm, advanceFarm, command } from '../farm/model.mjs';
import { createCombatView } from '../farm/combat-view.mjs';

it('keeps a defeated monster visible for one bounded transition without mutating the farm', () => {
  const s = createFarm(); command(s, { type: 'raid' }); s.monsters[0].progress = .7;
  const view = createCombatView(); const first = view.update(s, 0);
  s.monsters = []; const before = structuredClone(s);
  let frame = view.update(s, .1);
  expect(frame.defeats).toHaveLength(1);
  expect(frame.defeats[0]).toMatchObject({ x: first.monsters[0].x, y: first.monsters[0].y, age: 0, duration: 1.4, reward: 12 });
  frame = view.update(s, 1, { paused: true }); expect(frame.defeats[0].age).toBe(0);
  frame = view.update(s, .5); expect(frame.defeats[0].age).toBeCloseTo(.5);
  frame = view.update(s, 1); expect(frame.defeats).toEqual([]);
  expect(view.update(s, 1).defeats).toEqual([]);
  expect(s).toEqual(before);
});

it('does not invent defeated monsters on mount and holds a short non-flashing hit marker', () => {
  const s = createFarm(), view = createCombatView();
  expect(view.update(s, 0).defeats).toEqual([]);
  command(s, { type: 'raid' }); view.update(s, .1);
  s.monsters[0].health -= 1;
  expect(view.update(s, .1).monsters[0].hit).toBe(true);
  expect(view.update(s, .5, { paused: true }).monsters[0].hit).toBe(true);
  expect(view.update(s, .2).monsters[0].hit).toBe(false);
});

it('equips protectors and visibly intercepts their actual target; home guards do not attack', () => {
  const s = createFarm(); s.coins = 1000;
  command(s, { type: 'hire', kind: 'knight' }); command(s, { type: 'hire', kind: 'ranger' });
  command(s, { type: 'raid' }); s.monsters[0].progress = .7;
  const view = createCombatView(); let frame = view.update(s, 0);
  for (let n = 0; n < 40; n++) frame = view.update(s, .05);
  expect(frame.guards.map(g => g.weapon)).toEqual(['sword', 'sword', 'bow']);
  for (const g of frame.guards) {
    expect(g.attacking).toBe(true); expect(g.targetId).toBe(s.monsters[0].id);
    expect(g.x).toBeLessThan(g.targetX);
  }
  expect(frame.guards[2].x).toBeLessThan(frame.guards[0].x - 20);
  s.guards[0].mode = 'home';
  expect(view.update(s, .05).guards[0].attacking).toBe(false);
});

it('shows the finishing strike even when a large roster defeats a slime in one tick at 4x', () => {
  const s = createFarm(); s.coins = 2000; s.raidTimer = 1000;
  for (let n = 0; n < 11; n++) command(s, { type: 'hire', kind: 'knight' });
  command(s, { type: 'raid' });
  const view = createCombatView(); view.update(s, 0);
  let frame, sawAttack = false;
  for (let n = 0; n < 200; n++) {
    advanceFarm(s, .2); frame = view.update(s, .05);
    sawAttack ||= frame.guards.some(guard => guard.attacking);
    if (!s.monsters.length) break;
  }
  expect(frame.defeats).toHaveLength(1);
  expect(sawAttack).toBe(true);
  for (let n = 0; n < 12; n++) frame = view.update(s, .05);
  expect(frame.guards.some(guard => guard.attacking)).toBe(false);
});
