import { CROPS, GOODS, ANIMALS, GUARDS, JOBS, ACTIVITIES, own } from './definitions.mjs';
import { WORLD, canStand } from './world.mjs';

const fail = field => { throw new Error(`Invalid farm save: ${field}.`); };
const numeric = (value, min, max, field, integer = false) => { if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) fail(field); };
const text = (value, field, max = 160) => { if (typeof value !== 'string' || !value.length || value.length > max) fail(field); };
const array = (value, max, field) => { if (!Array.isArray(value) || value.length > max) fail(field); };

/** Validates all state consumed by the engine, including arrays and references. */
export function validateFarm(s) {
  if (!s || typeof s !== 'object' || s.version !== 1) fail('unsupported version');
  numeric(s.time, 0, 1e12, 'time'); numeric(s.remainder, 0, 0.25, 'clock remainder');
  numeric(s.coins, 0, 1e9, 'coins', true); numeric(s.mainHealth, 0, 100, 'main farmer health');
  numeric(s.nextId, 100, 1e12, 'next identifier', true); numeric(s.wave, 0, 1e9, 'wave', true);
  numeric(s.raidTimer, 0, 1e9, 'encounter timer'); numeric(s.mainCooldown, 0, 10, 'farmer cooldown');
  // Additive v1 field: legacy saves restore the farmer at home.
  if (s.farmer !== undefined) {
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
  const identify = entity => { if (!entity || typeof entity !== 'object') fail('entity'); text(entity.id, 'entity identifier'); if (ids.has(entity.id)) fail('duplicate identifier'); ids.add(entity.id); };
  s.plots.forEach((p, i) => {
    identify(p); if (p.id !== `p${i + 1}` || !own(CROPS, p.crop) || !['empty', 'tilled', 'growing', 'ready', 'dead'].includes(p.stage)) fail('plot');
    numeric(p.growth, 0, CROPS[p.crop].growTime, 'growth');
    for (const k of ['water', 'health', 'weeds']) numeric(p[k], 0, 100, k);
    numeric(p.neglect, 0, 1e12, 'neglect');
  });
  array(s.animals, 12, 'animals');
  for (const a of s.animals) {
    identify(a); text(a.name, 'animal name', 80); if (!own(ANIMALS, a.kind)) fail('animal kind');
    numeric(a.health, 0, 100, 'animal health'); numeric(a.hunger, 0, 100, 'animal hunger');
    numeric(a.production, 0, 90, 'animal production'); numeric(a.produce, 0, 10, 'animal products', true);
  }
  array(s.guards, 12, 'protectors');
  for (const g of s.guards) {
    identify(g); if (!own(GUARDS, g.kind) || g.maxHealth !== GUARDS[g.kind].maxHealth || !['home', 'patrol', 'expedition'].includes(g.mode)) fail('protector');
    numeric(g.health, 0, g.maxHealth, 'protector health'); numeric(g.progress, 0, 45, 'expedition');
  }
  array(s.monsters, 8, 'monsters');
  for (const m of s.monsters) { identify(m); numeric(m.maxHealth, 1, 200, 'monster maximum health'); numeric(m.health, 0, m.maxHealth, 'monster health'); numeric(m.progress, 0, 1, 'monster position'); }
  array(s.workers, 64, 'workers'); const workerIds = new Set(); const targets = new Set();
  for (const w of s.workers) {
    text(w.id, 'worker identifier'); if (workerIds.has(w.id)) fail('duplicate worker'); workerIds.add(w.id);
    text(w.name, 'worker name', 80); text(w.provider, 'provider', 32); text(w.action, 'action');
    if (!ACTIVITIES.includes(w.activity) || !['auto', 'livestock', ...s.plots.map(p => p.id)].includes(w.assignment)) fail('worker');
    if (w.attention !== null) { const a = w.attention; if (!a) fail('attention'); text(a.id, 'question id'); text(a.kind, 'question kind', 40); text(a.text, 'question text', 2000); }
    if (w.job !== null) {
      const j = w.job;
      if (!j || !own(JOBS, j.kind) || !ids.has(j.targetId) || targets.has(j.targetId) || j.duration !== JOBS[j.kind]) fail('care job');
      targets.add(j.targetId); numeric(j.progress, 0, j.duration, 'job progress');
    }
  }
  array(s.events, 40, 'events');
  for (const event of s.events) { numeric(event.id, 0, 1e12, 'event id', true); numeric(event.time, 0, s.time, 'event time'); text(event.text, 'event text', 500); }
  return true;
}
