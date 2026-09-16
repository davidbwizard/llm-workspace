import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as model from '../farm/model.mjs';
import { parseFarm, serializeFarm } from '../farm/storage.mjs';
import * as definitions from '../farm/definitions.mjs';
import { monsterPosition, moveActor, canStand, distance, plotPosition } from '../farm/world.mjs';

const { createFarm, command, advanceFarm, validateFarm } = model;
function run(s, seconds) { for (let n = 0; n < seconds; n++) advanceFarm(s, 1); }
function encounter(s, kind = 'slime', x = 320, y = 140) {
  command(s, { type: 'raid' }); const m = s.monsters.at(-1);
  Object.assign(m, { kind, x, y, health: 80, maxHealth: 80 }); return m;
}

it('starts small, makes land a real purchase, and rejects locked plot labor', () => {
  const s = createFarm(); expect(s.coins).toBe(35);
  expect(s.plots.filter(p => p.unlocked)).toHaveLength(3);
  expect(() => command(s, { type: 'tend', plotId: 'p4' })).toThrow(/unlock|land/i);
  expect(() => command(s, { type: 'crop', plotId: 'p4', crop: 'wheat' })).toThrow(/unlock|land/i);
  expect(() => command(s, { type: 'unlockPlot', plotId: 'p4' })).toThrow(/coins/i);
  s.coins = 100; command(s, { type: 'unlockPlot', plotId: 'p4' });
  expect(s.coins).toBe(50); expect(s.plots[3].unlocked).toBe(true);
  expect(definitions.landCost(s)).toBe(75);
  expect(() => command(s, { type: 'unlockPlot', plotId: 'p4' })).toThrow();
  expect(s.coins).toBe(50);
});

it('slows crops and livestock; early farm revenue requires continued care', () => {
  expect(definitions.CROPS.parsnip.growTime).toBe(180);
  expect(definitions.CROPS.wheat.growTime).toBe(240);
  const s = createFarm(); s.raidTimer = 1000;
  model.applySessionSnapshot(s, { version: 1, revision: 1, connected: true, sessions: ['a','b','c'].map(id => ({ id, name: id, provider: 'demo', activity: 'working' })) });
  run(s, 100); expect(s.plots.filter(p => p.stage === 'ready')).toHaveLength(0);
  expect(s.animals.every(a => a.produce === 0)).toBe(true);
  run(s, 110); command(s, { type: 'harvestAll' });
  expect(s.harvests).toBe(3); expect(s.inventory.parsnip).toBe(6);
  command(s, { type: 'sell', item: 'parsnip' }); expect(s.coins).toBe(59);
  expect(s.plots.filter(p => p.stage !== 'empty' && !p.unlocked)).toHaveLength(0);
});

it('introduces more distinct enemies at harvest milestones and rotates entry sides', () => {
  const s = createFarm(); const sides = new Set();
  for (let n = 0; n < 4; n++) {
    command(s, { type: 'raid' }); expect(s.monsters).toHaveLength(1);
    expect(s.monsters[0].kind).toBe('slime'); sides.add(s.monsters[0].spawn); s.monsters = [];
  }
  expect([...sides].sort()).toEqual(['east','north','south','west']);
  for (const [harvests, count, kind] of [[6,2,'raider'],[18,3,'spitter'],[36,4,'brute']]) {
    s.harvests = harvests; command(s, { type: 'raid' });
    expect(s.monsters).toHaveLength(count); expect(s.monsters.some(m => m.kind === kind)).toBe(true);
    s.monsters = [];
  }
});

it('counts harvests once, including automated harvest, and never from crop growth alone', () => {
  const s = createFarm(); s.raidTimer = 1000;
  Object.assign(s.plots[0], { stage: 'ready', growth: 180, water: 100 });
  advanceFarm(s, .05); expect(s.harvests).toBe(0);
  Object.assign(s.farmer, plotPosition(0));
  command(s, { type: 'harvest', plotId: 'p1' }); expect(s.harvests).toBe(1);
  expect(() => command(s, { type: 'harvest', plotId: 'p1' })).toThrow();
  expect(s.harvests).toBe(1);
});

it('lands the first melee hit immediately on contact without overlapping or remote damage', () => {
  const s = createFarm(); s.raidTimer = 1000; s.policy.autoHeal = false;
  const g = s.guards[0]; Object.assign(g, { x: 300, y: 140 });
  const m = encounter(s, 'slime', 333, 140);
  advanceFarm(s, .05); expect(m.health).toBeLessThan(80);
  expect(g.health).toBeLessThan(g.maxHealth);
  expect(Math.hypot(g.x-m.x,g.y-m.y)).toBeGreaterThanOrEqual(20);
  const after = m.health; advanceFarm(s, .05); expect(m.health).toBe(after);
  m.x = 580; m.y = 340; g.cooldown = 0;
  advanceFarm(s, .05); expect(m.health).toBe(after);
});

it('enemies damage a nearby crop or animal, clean up deaths, and do not hurt distant property', () => {
  const s = createFarm(); s.guards = []; s.raidTimer = 1000; s.policy.autoHeal = false;
  Object.assign(s.farmer, { x: 166, y: 105 });
  Object.assign(s.plots[0], { stage: 'growing', growth: 20, water: 80, health: 2 });
  const m = encounter(s, 'slime', 230, 135);
  const animalHealth = s.animals[0].health;
  advanceFarm(s, .05); expect(s.plots[0].stage).toBe('dead');
  expect(s.animals[0].health).toBe(animalHealth);
  Object.assign(m, { kind: 'raider', x: 471, y: 155, cooldown: 0 });
  s.animals[0].health = 2;
  advanceFarm(s, .05); expect(s.animals.some(a=>a.id === 'cow-1')).toBe(false);
  expect(validateFarm(s)).toBe(true);
});

it('rangers and spitters attack at range while melee units must close the gap', () => {
  const s = createFarm(); s.coins = 1000; s.guards = []; s.raidTimer = 1000;
  command(s, { type: 'hire', kind: 'ranger' }); Object.assign(s.guards[0], { x: 300, y: 140 });
  const m = encounter(s, 'spitter', 390, 140);
  advanceFarm(s, .05);
  expect(m.health).toBeLessThan(80); expect(s.guards[0].health).toBeLessThan(80);
  expect(Math.hypot(s.guards[0].x-m.x,s.guards[0].y-m.y)).toBeGreaterThan(60);
});

it('patrols spread around the farm and paid upgrades improve a protector', () => {
  const s = createFarm(); s.coins = 1000; s.raidTimer = 1000;
  const g = s.guards[0]; const origin = { x:g.x, y:g.y };
  run(s, 4); expect(Math.hypot(g.x-origin.x,g.y-origin.y)).toBeGreaterThan(25);
  command(s, { type: 'guardPost', guardId: g.id, post: 'pasture' });
  run(s, 15); expect(g.x).toBeGreaterThan(400);
  const cost = definitions.upgradeCost(g), stats = definitions.guardStats(g);
  command(s, { type: 'upgradeGuard', guardId: g.id });
  expect(g.level).toBe(2); expect(g.maxHealth).toBeGreaterThan(stats.maxHealth);
  expect(s.coins).toBe(1000-cost);
  expect(() => command(s, { type: 'guardPost', guardId: g.id, post: '__proto__' })).toThrow();
});

it('uses the same body reach from every side and collects nearby livestock with Space', () => {
  for (const [dx,dy] of [[48,0],[-48,0],[0,48],[0,-48]]) {
    const s=createFarm(); s.guards=[]; const m=encounter(s,'slime',330,160);
    Object.assign(s.farmer,{x:m.x+dx,y:m.y+dy});
    expect(model.getInteractionTarget(s)?.id).toBe(m.id);
    command(s,{type:'interact'}); expect(m.health).toBeLessThan(80);
  }
  const s=createFarm(); s.animals[0].produce=2; Object.assign(s.farmer,{x:450,y:181});
  expect(model.getInteractionTarget(s)?.type).toBe('collect'); command(s,{type:'interact'});
  expect(s.inventory.milk).toBe(2); expect(s.animals[0].produce).toBe(0);
});

it('migrates actual v1 saves without losing assets or crop/animal production progress', () => {
  const restored = parseFarm(readFileSync(new URL('./fixtures/farm-v1.json', import.meta.url),'utf8'));
  expect(restored.version).toBe(3); expect(restored.coins).toBe(321);
  expect(restored.inventory.wool).toBe(7); expect(restored.plots.filter(p=>p.unlocked)).toHaveLength(12);
  expect(restored.plots[0].growth/definitions.CROPS.parsnip.growTime).toBeCloseTo(50/75);
  expect(restored.animals[0].production/180).toBeCloseTo(.5);
  expect(restored.monsters[0].health).toBe(18); expect(monsterPosition(restored.monsters[0]).x).toBeCloseTo(526.5);
  expect(validateFarm(restored)).toBe(true);
  expect(parseFarm(serializeFarm(restored))).toEqual(restored);
});

it('validates new state and rejects forged spatial fields, progression, and locked jobs', () => {
  for (const mutate of [s=>s.harvests=-1,s=>s.guards[0].x=Infinity,s=>s.guards[0].post='__proto__',s=>s.plots[3].unlocked='yes']) {
    const s=createFarm(); mutate(s); expect(()=>validateFarm(s)).toThrow();
  }
});

it('routes fighters around the farmhouse instead of getting stuck against its wall', () => {
  const actor = { x: 165, y: 70, facing: 'left' }, destination = { x: 20, y: 70 };
  for (let n = 0; n < 100; n++) {
    moveActor(actor, destination, 50, .05, 2); expect(canStand(actor.x,actor.y)).toBe(true);
  }
  expect(distance(actor,destination)).toBeLessThanOrEqual(3);
});

it('keeps the player out of enemy bodies while still letting nearby sword hits land', () => {
  const s=createFarm(); s.guards=[]; const m=encounter(s,'slime',330,160);
  Object.assign(s.farmer,{x:300,y:160}); model.moveFarmer(s,1,0,.375);
  advanceFarm(s,.05); expect(distance(s.farmer,m)).toBeGreaterThanOrEqual(20);
  const before=m.health; command(s,{type:'interact'}); expect(m.health).toBeLessThan(before);
});
