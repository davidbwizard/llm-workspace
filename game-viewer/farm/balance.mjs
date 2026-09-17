import { GUARDS, MONSTERS, ANIMALS, guardStats, own } from './definitions.mjs';

// Per-farm tuning for every damageable type. Names, costs, rewards, radii, vision,
// crop growth and harvest progression stay in definitions.mjs; only the stats a
// player can retune live here, so a tuned farm never rewrites shared definitions.
const COMBAT = Object.freeze(['maxHealth', 'armor', 'power', 'interval', 'reach', 'speed']);
const PASSIVE = Object.freeze(['maxHealth', 'armor']);

export const BALANCE_FIELDS = Object.freeze({
  maxHealth: { name: 'Max health', unit: 'HP', min: 1, max: 10000, integer: true },
  armor: { name: 'Defense', unit: 'damage blocked per hit', min: 0, max: 1000, integer: true },
  power: { name: 'Attack', unit: 'damage per hit', min: 0, max: 1000, integer: true },
  interval: { name: 'Attack interval', unit: 'seconds', min: .05, max: 10 },
  reach: { name: 'Reach', unit: 'pixels', min: 0, max: 250 },
  speed: { name: 'Speed', unit: 'pixels per second', min: 0, max: 250 },
});

const pick = (source, fields) => Object.fromEntries(fields.map(field => [field, source[field]]));
const named = (source, fields) => Object.fromEntries(Object.entries(source).map(([key, value]) => [key, { name: value.name, fields }]));

export const BALANCE_GROUPS = Object.freeze({
  farmer: { name: 'Farmer', kinds: Object.freeze({ main: { name: 'Main farmer', fields: COMBAT } }) },
  plots: { name: 'Land', kinds: Object.freeze({ land: { name: 'Plot of land', fields: PASSIVE } }) },
  animals: { name: 'Livestock', kinds: Object.freeze(named(ANIMALS, PASSIVE)) },
  guards: { name: 'Protectors', kinds: Object.freeze(named(GUARDS, COMBAT)) },
  monsters: { name: 'Monsters', kinds: Object.freeze(named(MONSTERS, COMBAT)) },
});

export const DEFAULT_BALANCE = Object.freeze({
  version: 1,
  farmer: { main: { maxHealth: 100, armor: 0, power: 12, interval: .65, reach: 30, speed: 80 } },
  plots: { land: { maxHealth: 100, armor: 0 } },
  animals: Object.fromEntries(Object.keys(ANIMALS).map(kind => [kind, { maxHealth: 100, armor: 0 }])),
  guards: Object.fromEntries(Object.entries(GUARDS).map(([kind, base]) => [kind, pick(base, COMBAT)])),
  monsters: Object.fromEntries(Object.entries(MONSTERS).map(([kind, base]) => [kind, pick(base, COMBAT)])),
});

export const fieldsFor = (group, kind) => BALANCE_GROUPS[group]?.kinds?.[kind]?.fields ?? null;

/** Bounds are checked before any farm state is touched, so an invalid edit is a no-op. */
export function validateBalanceValue(group, kind, field, value) {
  if (!own(BALANCE_GROUPS, group) || !own(BALANCE_GROUPS[group].kinds, kind)) throw new Error('Unknown balance entry.');
  const fields = fieldsFor(group, kind);
  if (!own(BALANCE_FIELDS, field) || !fields.includes(field)) throw new Error(`This type has no ${String(field)} setting.`);
  const rule = BALANCE_FIELDS[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < rule.min || value > rule.max || (rule.integer && !Number.isSafeInteger(value))) {
    throw new Error(`${rule.name} must be ${rule.integer ? 'a whole number' : 'a number'} between ${rule.min} and ${rule.max}.`);
  }
  return value;
}

export function validateBalance(config) {
  if (!config || typeof config !== 'object' || config.version !== 1) throw new Error('Invalid balance: unsupported version.');
  const groups = Object.keys(BALANCE_GROUPS);
  if (Object.keys(config).length !== groups.length + 1 || !groups.every(group => own(config, group))) throw new Error('Invalid balance: groups.');
  for (const group of groups) {
    const kinds = Object.keys(BALANCE_GROUPS[group].kinds), entries = config[group];
    if (!entries || typeof entries !== 'object' || Object.keys(entries).length !== kinds.length || !kinds.every(kind => own(entries, kind))) throw new Error(`Invalid balance: ${group}.`);
    for (const kind of kinds) {
      const fields = fieldsFor(group, kind), entry = entries[kind];
      if (!entry || typeof entry !== 'object' || Object.keys(entry).length !== fields.length) throw new Error(`Invalid balance: ${group} ${kind}.`);
      for (const field of fields) validateBalanceValue(group, kind, field, entry[field]);
    }
  }
  return true;
}

export function createBalance(input) {
  if (input === undefined || input === null) return structuredClone(DEFAULT_BALANCE);
  validateBalance(input);
  return structuredClone(input);
}

/** Live stats for types that do not carry their own maximum on the entity. */
export function statsFor(state, group, kind) {
  const config = state?.balance ?? DEFAULT_BALANCE;
  const entry = own(BALANCE_GROUPS, group) && own(BALANCE_GROUPS[group].kinds, kind) ? config[group]?.[kind] : null;
  return entry ?? DEFAULT_BALANCE[group][kind];
}

export const farmerStats = state => statsFor(state, 'farmer', 'main');
export const plotStats = state => statsFor(state, 'plots', 'land');
export const animalStats = (state, kind) => statsFor(state, 'animals', kind);
export const monsterStats = (state, kind) => statsFor(state, 'monsters', kind);
/** Below this fraction of maximum health the farmer stops acting and recovers. */
export const RECOVER_RATIO = .1;

// Rescaling only where a maximum actually moved: health * next / previous keeps
// exact ratios and avoids reintroducing float error on unrelated edits.
const rescale = (health, previous, next) => previous === next || previous <= 0 ? health : Math.max(0, Math.min(next, health * next / previous));

/**
 * Swap in a validated configuration and carry every living entity across by
 * percentage. Nothing is revived, healed, resurrected or rewarded.
 */
export function retuneFarm(s, next) {
  const previous = s.balance ?? DEFAULT_BALANCE;
  s.balance = next;
  s.mainHealth = rescale(s.mainHealth, previous.farmer.main.maxHealth, next.farmer.main.maxHealth);
  s.mainCooldown = Math.min(s.mainCooldown, next.farmer.main.interval);
  for (const p of s.plots) p.health = rescale(p.health, previous.plots.land.maxHealth, next.plots.land.maxHealth);
  for (const a of s.animals) a.health = rescale(a.health, previous.animals[a.kind].maxHealth, next.animals[a.kind].maxHealth);
  for (const g of s.guards) {
    const max = guardStats(g, next).maxHealth;
    g.health = rescale(g.health, g.maxHealth, max); g.maxHealth = max;
    g.cooldown = Math.min(g.cooldown, guardStats(g, next).interval);
  }
  for (const m of s.monsters) {
    const max = next.monsters[m.kind].maxHealth;
    m.health = rescale(m.health, m.maxHealth, max); m.maxHealth = max;
    m.cooldown = Math.min(m.cooldown, next.monsters[m.kind].interval);
  }
  return s;
}

export function setBalanceValue(s, group, kind, field, value) {
  validateBalanceValue(group, kind, field, value);
  const next = structuredClone(s.balance ?? DEFAULT_BALANCE);
  next[group][kind][field] = value;
  return retuneFarm(s, next);
}

export const resetBalance = s => retuneFarm(s, structuredClone(DEFAULT_BALANCE));
