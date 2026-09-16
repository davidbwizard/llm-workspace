import { it, expect } from 'vitest';
import { createFarm, advanceFarm, command } from '../farm/model.mjs';
import { createCombatView } from '../farm/combat-view.mjs';

it('keeps a defeated monster visible for one bounded transition without mutating the farm', () => {
  const s = createFarm(); command(s, { type: 'raid' }); s.monsters[0].progress = .7;
  const view = createCombatView(); const first = view.update(s, 0);
  s.monsters = []; const before = structuredClone(s);
  let frame = view.update(s, .1);
  expect(frame.defeats).toHaveLength(1);
  expect(frame.defeats[0]).toMatchObject({ x: first.monsters[0].x, y: first.monsters[0].y, age: 0, duration: 1.4, reward: 2 });
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

it('uses model positions and actual strike IDs for equipped attackers', () => {
  const s = createFarm(); s.coins = 1000;
  command(s, { type: 'hire', kind: 'knight' }); command(s, { type: 'hire', kind: 'ranger' });
  command(s, { type: 'raid' }); Object.assign(s.monsters[0], { x: 340, y: 160, health: 100, maxHealth: 100 });
  s.guards.forEach((g,i) => Object.assign(g,{x:i===2?250:310,y:160}));
  const view=createCombatView(); view.update(s,0); advanceFarm(s,.05);
  let frame=view.update(s,.05);
  expect(frame.guards.map(g=>g.weapon)).toEqual(['sword','sword','bow']);
  frame.guards.forEach((g,i)=>{
    expect(g.attacking).toBe(true); expect(g.targetId).toBe(s.monsters[0].id);
    expect({x:g.x,y:g.y}).toEqual({x:s.guards[i].x,y:s.guards[i].y});
  });
  const pose=frame.guards[0]; frame=view.update(s,1,{paused:true});
  expect(frame.guards[0].strikeAge).toBe(pose.strikeAge);
  expect(view.update(s,.4).guards.every(g=>!g.attacking)).toBe(true);
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
