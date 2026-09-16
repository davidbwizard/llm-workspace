import { CROPS, GOODS, ANIMALS, GUARDS, JOBS, ACTIVITIES, MONSTERS, POSTS, EXPEDITION_TIME, guardStats, own } from './definitions.mjs';
import { WORLD, canStand, createFarmer, monsterPosition, spatialFields, PATROLS } from './world.mjs';
import { cleanReferences } from './combat.mjs';
import { createBalance, validateBalance, DEFAULT_BALANCE } from './balance.mjs';
const LEGACY_CROPS = { parsnip: 75, wheat: 120 };
const LEGACY_GUARDS = { scout: 60, knight: 130, ranger: 80 };

const fail = field => { throw new Error(`Invalid farm save: ${field}.`); };
const numeric = (value, min, max, field, integer = false) => { if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) fail(field); };
const text = (value, field, max = 160) => { if (typeof value !== 'string' || !value.length || value.length > max) fail(field); };
const array = (value, max, field) => { if (!Array.isArray(value) || value.length > max) fail(field); };

/** Validates all state consumed by the engine, including arrays and references. */
export function validateFarm(s) {
  if (!s || typeof s !== 'object' || ![1, 2, 3].includes(s.version)) fail('unsupported version');
  const legacy = s.version === 1;
  // Tuned saves carry their own limits; earlier versions are checked against the shipped ones.
  if (s.version === 3) { try { validateBalance(s.balance); } catch (error) { fail(error.message); } }
  const tuning = s.version === 3 ? s.balance : DEFAULT_BALANCE;
  numeric(s.time, 0, 1e12, 'time'); numeric(s.remainder, 0, legacy ? .25 : .05, 'clock remainder');
  if (!legacy) numeric(s.harvests, 0, 1e9, 'harvest count', true);
  numeric(s.coins, 0, 1e9, 'coins', true); numeric(s.mainHealth, 0, tuning.farmer.main.maxHealth, 'main farmer health');
  numeric(s.nextId, 100, 1e12, 'next identifier', true); numeric(s.wave, 0, 1e9, 'wave', true);
  numeric(s.raidTimer, 0, 1e9, 'encounter timer'); numeric(s.mainCooldown, 0, 10, 'farmer cooldown');
  // Additive v1 field: legacy saves restore the farmer at home.
  if (s.farmer !== undefined || !legacy) {
    const f = s.farmer;
    if (!f || typeof f !== 'object') fail('farmer');
    numeric(f.x, 0, WORLD.width - 32, 'farmer x'); numeric(f.y, 34, WORLD.height - 32, 'farmer y');
    numeric(f.actionTime, 0, 3, 'farmer action time');
    if (!canStand(f.x, f.y) || !['up', 'down', 'left', 'right'].includes(f.facing) || !['idle', 'walk', 'attack', 'harvest'].includes(f.action)) fail('farmer position or action');
  }
  if (typeof s.connected !== 'boolean') fail('connection');
  numeric(s.sessionRevision, -1, Number.MAX_SAFE_INTEGER, 'session revision', true);
  if (!s.policy || !['autoHarvest', 'autoSell', 'autoCollect', 'autoHeal'].every(k => typeof s.policy[k] === 'boolean')) fail('automation policies');
  if (!s.inventory || typeof s.inventory !== 'object') fail('inventory');
  for (const key of [...Object.keys(GOODS), 'seeds', 'feed', 'medicine']) numeric(s.inventory[key], 0, 1e9, `inventory ${key}`, true);
  array(s.plots, 12, 'plots'); if (s.plots.length !== 12) fail('plot count');
  const ids = new Set();
  const identify = entity => { if (!entity || typeof entity !== 'object') fail('entity'); text(entity.id, 'entity identifier'); if (ids.has(entity.id) || entity.id === 'main') fail('duplicate or reserved identifier'); ids.add(entity.id); };
  s.plots.forEach((p, i) => {
    identify(p); if (p.id !== `p${i + 1}` || !own(CROPS, p.crop) || !['empty', 'tilled', 'growing', 'ready', 'dead'].includes(p.stage)) fail('plot');
    if (!legacy && (typeof p.unlocked !== 'boolean' || (!p.unlocked && p.stage !== 'empty'))) fail('plot lock');
    numeric(p.growth, 0, legacy ? LEGACY_CROPS[p.crop] : CROPS[p.crop].growTime, 'growth');
    for (const k of ['water', 'weeds']) numeric(p[k], 0, 100, k);
    numeric(p.health, 0, tuning.plots.land.maxHealth, 'plot health');
    numeric(p.neglect, 0, 1e12, 'neglect');
  });
  array(s.animals, 12, 'animals');
  for (const a of s.animals) {
    identify(a); text(a.name, 'animal name', 80); if (!own(ANIMALS, a.kind)) fail('animal kind');
    numeric(a.health, 0, tuning.animals[a.kind].maxHealth, 'animal health'); numeric(a.hunger, 0, 100, 'animal hunger');
    numeric(a.production, 0, legacy ? 90 : ANIMALS[a.kind].productionTime, 'animal production'); numeric(a.produce, 0, 10, 'animal products', true);
  }
  array(s.guards, 12, 'protectors');
  for (const g of s.guards) {
    identify(g); if (!own(GUARDS, g.kind) || g.maxHealth !== (legacy ? LEGACY_GUARDS[g.kind] : guardStats(g, s.balance).maxHealth) || !['home', 'patrol', 'expedition'].includes(g.mode)) fail('protector');
    numeric(g.health, 0, g.maxHealth, 'protector health'); numeric(g.progress, 0, legacy ? 45 : EXPEDITION_TIME, 'expedition');
    if (!legacy) { numeric(g.level, 1, 3, 'protector level', true); numeric(g.patrolIndex, 0, 3, 'patrol route', true); if (!own(POSTS, g.post)) fail('patrol post'); spatial(g); }
  }
  array(s.monsters, 8, 'monsters');
  for (const m of s.monsters) {
    identify(m); numeric(m.maxHealth, 1, legacy ? 200 : 10000, 'monster maximum health'); numeric(m.health, 0, m.maxHealth, 'monster health');
    if (legacy) numeric(m.progress, 0, 1, 'monster position');
    else { if (!own(MONSTERS, m.kind) || !['north','east','south','west'].includes(m.spawn)) fail('monster type or spawn'); spatial(m); }
  }
  const animals = new Set(s.animals.filter(a => a.health > 0).map(a => a.id));
  const plots = new Set(s.plots.filter(p => legacy || p.unlocked).map(p => p.id));
  if (!legacy) {
    const enemies = new Set(s.monsters.filter(m=>m.health>0).map(m=>m.id));
    const targets = new Set(['main', ...animals, ...s.guards.filter(g=>g.health>0).map(g=>g.id), ...s.plots.filter(p=>p.unlocked && p.stage!=='dead' && p.health>0).map(p=>p.id)]);
    for (const g of s.guards) if (g.targetId !== null && !enemies.has(g.targetId)) fail('protector target');
    for (const m of s.monsters) if (m.targetId !== null && !targets.has(m.targetId)) fail('monster target');
  }
  array(s.workers, 64, 'workers'); const workerIds = new Set(); const targets = new Set();
  for (const w of s.workers) {
    text(w.id, 'worker identifier'); if (workerIds.has(w.id)) fail('duplicate worker'); workerIds.add(w.id);
    text(w.name, 'worker name', 80); text(w.provider, 'provider', 32); text(w.action, 'action');
    if (!ACTIVITIES.includes(w.activity) || !['auto', 'livestock', ...plots].includes(w.assignment)) fail('worker');
    if (w.attention !== null) { const a = w.attention; if (!a) fail('attention'); text(a.id, 'question id'); text(a.kind, 'question kind', 40); text(a.text, 'question text', 2000); }
    if (w.job !== null) {
      const j = w.job;
      if (!j || !own(JOBS, j.kind) || !ids.has(j.targetId) || targets.has(j.targetId) || j.duration !== JOBS[j.kind]) fail('care job');
      if (!legacy && !(['feed','collect'].includes(j.kind) ? animals : plots).has(j.targetId)) fail('care job target');
      targets.add(j.targetId); numeric(j.progress, 0, j.duration, 'job progress');
    }
  }
  array(s.events, 40, 'events');
  for (const event of s.events) { numeric(event.id, 0, 1e12, 'event id', true); numeric(event.time, 0, s.time, 'event time'); text(event.text, 'event text', 500); }
  if (!legacy && s.nextId <= allocatedId(s)) fail('next identifier is already allocated');
  return true;
}

function spatial(actor) {
  numeric(actor.x, 0, 608, 'actor x'); numeric(actor.y, 34, 358, 'actor y');
  if (!canStand(actor.x, actor.y) || !['up','down','left','right'].includes(actor.facing)) fail('actor position or facing');
  numeric(actor.cooldown, 0, 5, 'attack cooldown'); numeric(actor.strikeId, 0, 1e12, 'strike id', true);
  numeric(actor.strikeX, 0, 640, 'strike x'); numeric(actor.strikeY, 0, 390, 'strike y');
  if (actor.targetId !== null) text(actor.targetId, 'target identifier');
  if (actor.strikeTargetId !== null) text(actor.strikeTargetId, 'strike target identifier');
}
function allocatedId(s) {
  return Math.max(99, ...s.events.map(e=>e.id), ...[...s.guards,...s.monsters,...s.animals].flatMap(a=>[a.strikeId ?? 0, Number(/-(\d+)$/.exec(a.id)?.[1] ?? 0)]));
}

/** Validate before migrating; no defaults are applied to malformed version2 data. */
export function upgradeFarm(input) {
  validateFarm(input);
  if (input.version === 3) return input;
  const s = structuredClone(input);
  if (s.version === 2) { s.version = 3; s.balance = createBalance(); validateFarm(s); return s; }
  s.version = 3; s.balance = createBalance(); s.harvests = 0; s.remainder = 0;
  s.farmer ??= createFarmer(); s.farmer.action = 'idle'; s.farmer.actionTime = 0;
  for (const p of s.plots) { p.unlocked = true; p.growth = p.growth / LEGACY_CROPS[p.crop] * CROPS[p.crop].growTime; }
  for (const a of s.animals) a.production = a.production / 90 * ANIMALS[a.kind].productionTime;
  s.guards.forEach((g,i) => { const point = PATROLS.farm[i%4]; Object.assign(g,spatialFields(point.x,point.y),{post:'farm',level:1,patrolIndex:(i+1)%4,progress:g.progress/45*EXPEDITION_TIME}); });
  for (const m of s.monsters) { const point = monsterPosition(m); Object.assign(m,spatialFields(Math.min(608,point.x),point.y),{kind:'slime',spawn:'east'}); delete m.progress; }
  cleanReferences(s); s.nextId = Math.max(s.nextId, allocatedId(s)+1);
  validateFarm(s); return s;
}
