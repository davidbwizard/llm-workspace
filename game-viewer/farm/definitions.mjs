export const CROPS = Object.freeze({
  parsnip: { name: 'Parsnip', growTime: 180, price: 4, yield: 2 },
  wheat: { name: 'Wheat', growTime: 240, price: 5, yield: 3 },
});
export const GOODS = Object.freeze({
  parsnip: { name: 'Parsnips', price: 4 }, wheat: { name: 'Wheat', price: 5 },
  milk: { name: 'Milk', price: 6 }, wool: { name: 'Wool', price: 8 },
  meat: { name: 'Meat', price: 5 }, hide: { name: 'Hides', price: 7 },
});
export const GUARDS = Object.freeze({
  scout: { name: 'Scout', cost: 60, maxHealth: 60, power: 7, interval: .8, reach: 14, speed: 50, armor: 0, vision: 220, weapon: 'sword', weaponLabel: 'Sword', upgrade: 45 },
  knight: { name: 'Knight', cost: 125, maxHealth: 130, power: 13, interval: 1.1, reach: 16, speed: 36, armor: 3, vision: 200, weapon: 'sword', weaponLabel: 'Sword & shield', upgrade: 85 },
  ranger: { name: 'Ranger', cost: 105, maxHealth: 80, power: 7, interval: .9, reach: 100, speed: 44, armor: 0, vision: 250, weapon: 'bow', weaponLabel: 'Bow', upgrade: 70 },
});
/** The optional per-farm balance retunes base stats; upgrades still multiply them. */
export function guardStats(guard, balance) {
  const base = GUARDS[guard.kind], level = guard.level ?? 1;
  const tuned = { ...base, ...(balance?.guards?.[guard.kind] ?? null) };
  return { ...tuned, power: Math.round(tuned.power * (1 + (level - 1) * .35)), maxHealth: Math.round(tuned.maxHealth * (1 + (level - 1) * .25)) };
}
export function upgradeCost(guard) { return guard.level >= 3 ? null : GUARDS[guard.kind].upgrade * (guard.level ?? 1); }
export const POSTS = Object.freeze({ farm: { name: 'Farm circuit' }, garden: { name: 'Kitchen garden' }, pasture: { name: 'Livestock pasture' } });
export const MONSTERS = Object.freeze({
  slime: { name: 'Bog slime', maxHealth: 22, power: 3, speed: 16, interval: 1.3, reach: 14, armor: 0, radius: 10, reward: 2, preference: 'crop', description: 'Slow crop grazer' },
  raider: { name: 'Spear goblin', maxHealth: 28, power: 5, speed: 32, interval: .9, reach: 16, armor: 0, radius: 10, reward: 3, preference: 'animal', description: 'Fast livestock raider' },
  spitter: { name: 'Spore spitter', maxHealth: 40, power: 5, speed: 20, interval: 1.8, reach: 90, armor: 0, radius: 10, reward: 4, preference: 'crop', description: 'Attacks from a distance' },
  brute: { name: 'Armored brute', maxHealth: 90, power: 12, speed: 12, interval: 1.7, reach: 16, armor: 2, radius: 14, reward: 6, preference: 'crop', description: 'Slow, armored and destructive' },
});
// Kept for integrations that display the base slime reward.
export const MONSTER_REWARD = MONSTERS.slime.reward;
const RAIDS = [
  { tier: 1, name: 'Quiet meadow', at: 0, nextAt: 6, count: 1, interval: 180, kinds: ['slime'] },
  { tier: 2, name: 'Raiding parties', at: 6, nextAt: 18, count: 2, interval: 160, kinds: ['slime', 'raider'] },
  { tier: 3, name: 'Spore incursions', at: 18, nextAt: 36, count: 3, interval: 140, kinds: ['slime', 'raider', 'spitter'] },
  { tier: 4, name: 'Heavy raids', at: 36, nextAt: null, count: 4, interval: 120, kinds: ['slime', 'raider', 'spitter', 'brute'] },
];
export function raidProfile(harvests) { return RAIDS.findLast(tier => harvests >= tier.at) ?? RAIDS[0]; }
export function landCost(state) { return 50 + Math.max(0, state.plots.filter(p => p.unlocked).length - 3) * 25; }
export const ANIMALS = Object.freeze({
  cow: { name: 'Cow', cost: 80, product: 'milk', meat: 5, hide: 2, productionTime: 180 },
  sheep: { name: 'Sheep', cost: 65, product: 'wool', meat: 3, hide: 1, productionTime: 180 },
});
export const SHOP = Object.freeze({
  seeds: { name: '6 seeds', cost: 12, quantity: 6 },
  feed: { name: '6 feed', cost: 12, quantity: 6 },
  medicine: { name: 'Healing tonic', cost: 18, quantity: 1 },
  cow: { name: 'Cow', cost: 80, quantity: 1 },
  sheep: { name: 'Sheep', cost: 65, quantity: 1 },
});
export const EXPEDITION_TIME = 180;
export const ACTIVITIES = Object.freeze(['working', 'idle', 'waiting_input', 'waiting_permission', 'error', 'unknown']);
export const JOBS = Object.freeze({ till: 2, plant: 2, water: 3, weed: 3, clear: 2, harvest: 3, feed: 3, collect: 3 });
export const own = (object, key) => typeof key === 'string' && Object.hasOwn(object, key);
