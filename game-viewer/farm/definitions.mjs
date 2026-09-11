export const CROPS = Object.freeze({
  parsnip: { name: 'Parsnip', growTime: 75, price: 6, yield: 3 },
  wheat: { name: 'Wheat', growTime: 120, price: 9, yield: 4 },
});
export const GOODS = Object.freeze({
  parsnip: { name: 'Parsnips', price: 6 }, wheat: { name: 'Wheat', price: 9 },
  milk: { name: 'Milk', price: 12 }, wool: { name: 'Wool', price: 16 },
  meat: { name: 'Meat', price: 9 }, hide: { name: 'Hides', price: 14 },
});
export const GUARDS = Object.freeze({
  scout: { name: 'Scout', cost: 45, maxHealth: 60, power: 5, weapon: 'sword', weaponLabel: 'Sword' },
  knight: { name: 'Knight', cost: 100, maxHealth: 130, power: 11, weapon: 'sword', weaponLabel: 'Sword & shield' },
  ranger: { name: 'Ranger', cost: 80, maxHealth: 80, power: 9, weapon: 'bow', weaponLabel: 'Bow' },
});
export const MONSTER_REWARD = 12;
export const ANIMALS = Object.freeze({
  cow: { name: 'Cow', cost: 80, product: 'milk', meat: 5, hide: 2 },
  sheep: { name: 'Sheep', cost: 65, product: 'wool', meat: 3, hide: 1 },
});
export const SHOP = Object.freeze({
  seeds: { name: '10 seeds', cost: 8, quantity: 10 },
  feed: { name: '10 feed', cost: 10, quantity: 10 },
  medicine: { name: 'Healing tonic', cost: 15, quantity: 1 },
  cow: { name: 'Cow', cost: 80, quantity: 1 },
  sheep: { name: 'Sheep', cost: 65, quantity: 1 },
});
export const ACTIVITIES = Object.freeze(['working', 'idle', 'waiting_input', 'waiting_permission', 'error', 'unknown']);
export const JOBS = Object.freeze({ till: 2, plant: 2, water: 3, weed: 3, clear: 2, harvest: 3, feed: 3, collect: 3 });
export const own = (object, key) => typeof key === 'string' && Object.hasOwn(object, key);
