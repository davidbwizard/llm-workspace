import { CROPS, GOODS, GUARDS, SHOP, ANIMALS, JOBS, MONSTER_REWARD, own } from './definitions.mjs';
import { normalizeSnapshot } from './sessions.mjs';
import { WORLD, createFarmer, canStand, plotPosition, monsterPosition } from './world.mjs';
export { validateFarm } from './validation.mjs';

const STEP = 0.25;
const clamp = (n, max = 100) => Math.max(0, Math.min(max, n));
const lookup = (list, id, name) => { const found = list.find(item => item.id === id); if (!found) throw new Error(`${name} not found.`); return found; };
const log = (s, text) => { s.events.unshift({ id: s.nextId++, time: s.time, text }); s.events.length = Math.min(40, s.events.length); };
const freshPlot = (id, crop = 'parsnip') => ({ id, crop, stage: 'empty', growth: 0, water: 0, health: 100, neglect: 0, weeds: 0 });
const freshAnimal = (id, kind, name) => ({ id, kind, name, health: 100, hunger: 80, production: 0, produce: 0 });

export function createFarm() {
  return {
    version: 1, time: 0, remainder: 0, coins: 120, mainHealth: 100, mainCooldown: 0, farmer: createFarmer(),
    nextId: 100, raidTimer: 180, wave: 0, connected: true, sessionRevision: -1,
    plots: Array.from({ length: 12 }, (_, i) => freshPlot(`p${i + 1}`, i >= 8 ? 'wheat' : 'parsnip')),
    animals: [freshAnimal('cow-1', 'cow', 'Clover'), freshAnimal('sheep-1', 'sheep', 'Willow')],
    guards: [{ id: 'guard-1', kind: 'scout', health: 60, maxHealth: 60, mode: 'patrol', progress: 0 }],
    monsters: [], workers: [],
    inventory: { parsnip: 0, wheat: 0, milk: 0, wool: 0, meat: 0, hide: 0, seeds: 20, feed: 20, medicine: 3 },
    policy: { autoHarvest: false, autoSell: false, autoCollect: true, autoHeal: true },
    events: [{ id: 1, time: 0, text: 'Welcome home. Your workers will tend the farm while their sessions work.' }],
  };
}

export function applySessionSnapshot(s, input) {
  const snapshot = normalizeSnapshot(input);
  if (snapshot.revision <= s.sessionRevision) return false;
  const previous = new Map(s.workers.map(w => [w.id, w]));
  const workers = snapshot.roots.map(root => {
    const old = previous.get(root.id);
    const attention = root.attention ?? root.descendants.find(child => child.attention)?.attention ?? null;
    let activity = root.activity;
    if (attention) activity = attention.kind === 'permission' || root.activity === 'waiting_permission' ? 'waiting_permission' : 'waiting_input';
    else if (!activity.startsWith('waiting_') && root.descendants.some(child => child.activity === 'working')) activity = 'working';
    if (!snapshot.connected) activity = 'unknown';
    return { id: root.id, name: root.name, provider: root.provider, activity, attention,
      assignment: old?.assignment ?? 'auto', job: activity === 'working' ? old?.job ?? null : null,
      action: activity === 'working' ? old?.action ?? 'Looking for work' : attention ? 'Waiting for you' : activity === 'unknown' ? 'Reconnecting' : 'Resting' };
  });
  s.workers = workers; s.sessionRevision = snapshot.revision; s.connected = snapshot.connected;
  return true;
}

function harvest(s, plot) {
  if (plot.stage !== 'ready') throw new Error('This crop is not ready to harvest.');
  const crop = CROPS[plot.crop]; s.inventory[plot.crop] += crop.yield;
  log(s, `Harvested ${crop.yield} ${crop.name.toLowerCase()} from plot ${plot.id.slice(1)}.`);
  Object.assign(plot, freshPlot(plot.id, plot.crop));
}

function collect(s, animal) {
  if (animal.produce <= 0) throw new Error('No products are ready yet.');
  const product = ANIMALS[animal.kind].product;
  s.inventory[product] += animal.produce;
  log(s, `Collected ${animal.produce} ${product} from ${animal.name}.`); animal.produce = 0;
}

function plotJob(s, p) {
  if (p.stage === 'dead') return 'clear';
  if (p.stage === 'empty' && s.inventory.seeds > 0) return 'till';
  if (p.stage === 'tilled' && s.inventory.seeds > 0) return 'plant';
  if (p.stage === 'growing' || p.stage === 'ready') {
    if (p.water < 45) return 'water';
    if (p.weeds >= 30) return 'weed';
    if (p.stage === 'ready' && s.policy.autoHarvest) return 'harvest';
  }
  return null;
}

function completeCare(s, job) {
  const p = s.plots.find(p => p.id === job.targetId);
  if (p) {
    switch (job.kind) {
      case 'clear': if (p.stage === 'dead') Object.assign(p, freshPlot(p.id, p.crop)); break;
      case 'till': if (p.stage === 'empty') p.stage = 'tilled'; break;
      case 'plant': if (p.stage === 'tilled' && s.inventory.seeds > 0) { s.inventory.seeds--; p.stage = 'growing'; p.water = 70; } break;
      case 'water': if (['growing', 'ready'].includes(p.stage)) { p.water = 100; p.neglect = 0; p.health = clamp(p.health + 10); } break;
      case 'weed': p.weeds = 0; break;
      case 'harvest': if (p.stage === 'ready' && s.policy.autoHarvest) harvest(s, p); break;
    }
    return;
  }
  const a = s.animals.find(a => a.id === job.targetId);
  if (!a) return;
  if (job.kind === 'feed' && s.inventory.feed > 0) { s.inventory.feed--; a.hunger = 100; }
  if (job.kind === 'collect' && a.produce > 0 && s.policy.autoCollect) collect(s, a);
}

function chooseJob(s, worker, occupied) {
  const candidates = [];
  if (worker.assignment === 'auto' || worker.assignment === 'livestock') {
    for (const a of s.animals) {
      if (occupied.has(a.id)) continue;
      if (a.hunger < 50 && s.inventory.feed > 0) candidates.push({ targetId: a.id, kind: 'feed', priority: 200 - a.hunger });
      else if (a.produce > 0 && s.policy.autoCollect) candidates.push({ targetId: a.id, kind: 'collect', priority: 30 });
    }
  }
  if (worker.assignment !== 'livestock') {
    for (const p of s.plots) {
      if (occupied.has(p.id) || (worker.assignment !== 'auto' && worker.assignment !== p.id)) continue;
      const kind = plotJob(s, p);
      if (kind) candidates.push({ targetId: p.id, kind, priority: kind === 'water' ? 200 - p.water : kind === 'weed' ? 90 : kind === 'harvest' ? 50 : kind === 'clear' ? 40 : 10 });
    }
  }
  candidates.sort((a, b) => b.priority - a.priority);
  if (!candidates.length) return null;
  const { targetId, kind } = candidates[0];
  return { targetId, kind, progress: 0, duration: JOBS[kind] };
}

function stepWorkers(s) {
  const occupied = new Set(s.workers.filter(w => w.job).map(w => w.job.targetId));
  for (const worker of s.workers) {
    if (worker.activity !== 'working') continue;
    if (worker.job && !s.plots.some(p => p.id === worker.job.targetId) && !s.animals.some(a => a.id === worker.job.targetId)) { occupied.delete(worker.job.targetId); worker.job = null; }
    if (!worker.job) {
      worker.job = chooseJob(s, worker, occupied);
      if (worker.job) occupied.add(worker.job.targetId);
    }
    if (!worker.job) { worker.action = 'All caught up'; continue; }
    const job = worker.job;
    const verbs = { till: 'Hoeing', plant: 'Planting', water: 'Watering', weed: 'Weeding', clear: 'Clearing', harvest: 'Harvesting', feed: 'Feeding & watering', collect: 'Collecting' };
    worker.action = verbs[job.kind]; job.progress += STEP;
    if (job.progress >= job.duration) { completeCare(s, job); occupied.delete(job.targetId); worker.job = null; }
  }
}

function stepCrops(s) {
  for (const p of s.plots) {
    if (!['growing', 'ready'].includes(p.stage)) continue;
    p.water = clamp(p.water - STEP * 0.5); p.weeds = clamp(p.weeds + STEP * 0.15);
    if (p.water <= 0) {
      p.neglect += STEP;
      if (p.neglect > 15) p.health = clamp(p.health - STEP);
    } else {
      p.neglect = 0;
      if (p.stage === 'growing') p.growth = Math.min(CROPS[p.crop].growTime, p.growth + STEP * (p.weeds >= 60 ? 0.5 : 1));
    }
    if (p.health <= 0) { p.stage = 'dead'; log(s, `Plot ${p.id.slice(1)} withered. Clear it and plant again.`); }
    else if (p.stage === 'growing' && p.growth >= CROPS[p.crop].growTime) { p.stage = 'ready'; log(s, `Plot ${p.id.slice(1)} is ready to harvest.`); }
  }
}

function stepAnimals(s) {
  for (const a of s.animals) {
    a.hunger = clamp(a.hunger - STEP * 0.12);
    if (a.hunger === 0) a.health = clamp(a.health - STEP * 0.3);
    else if (a.hunger > 20 && a.health > 0 && a.produce < 10) {
      a.production += STEP;
      if (a.production >= 90) { a.production -= 90; a.produce++; log(s, `${a.name} has ${ANIMALS[a.kind].product} ready.`); }
    }
  }
  for (const a of s.animals.filter(a => a.health <= 0)) {
    log(s, `${a.name} died. Keep animals fed and protected.`);
    for (const worker of s.workers) if (worker.job?.targetId === a.id) worker.job = null;
  }
  s.animals = s.animals.filter(a => a.health > 0);
}

function spawnRaid(s) {
  if (s.monsters.length >= 8) throw new Error('There are already eight creatures approaching.');
  s.wave++; const health = Math.min(120, 24 + s.wave * 6);
  s.monsters.push({ id: `monster-${s.nextId++}`, health, maxHealth: health, progress: 0 });
  log(s, 'A slime is approaching the farm. Protectors on patrol will intercept it.');
}

/** Start intercepting before attack range; each guard focuses one threat. */
export function selectGuardTarget(guard, monsters) {
  if (guard.mode !== 'patrol' || guard.health <= guard.maxHealth * .2) return null;
  let target = null;
  for (const monster of monsters) {
    if (monster.health > 0 && monster.progress >= .2 && (!target || monster.progress > target.progress)) target = monster;
  }
  return target;
}

function rewardDefeats(s) {
  for (const monster of s.monsters) if (monster.health <= 0) {
    s.coins += MONSTER_REWARD; log(s, `The slime was driven off. Earned ${MONSTER_REWARD} coins.`);
  }
  s.monsters = s.monsters.filter(monster => monster.health > 0);
}

function stepCombat(s) {
  s.raidTimer = Math.max(0, s.raidTimer - STEP);
  if (s.raidTimer === 0) { if (s.monsters.length < 8) spawnRaid(s); s.raidTimer = Math.max(80, 180 - s.wave * 5); }
  for (const guard of s.guards) {
    if (guard.mode === 'home') { guard.health = clamp(guard.health + STEP * 0.8, guard.maxHealth); continue; }
    if (guard.health <= guard.maxHealth * 0.2) { guard.mode = 'home'; guard.progress = 0; log(s, `${GUARDS[guard.kind].name} retreated home to recover.`); continue; }
    if (guard.mode === 'expedition') {
      guard.progress += STEP;
      if (guard.progress >= 45) {
        const reward = Math.round(GUARDS[guard.kind].power * 5 + 10);
        s.coins += reward; guard.health = clamp(guard.health - 18, guard.maxHealth); guard.mode = 'home'; guard.progress = 0;
        log(s, `${GUARDS[guard.kind].name} returned with ${reward} coins.`);
      }
    }
  }
  for (const monster of s.monsters) monster.progress = clamp(monster.progress + STEP / 30, 1);
  const targets = new Map(s.guards.map(guard => [guard.id, selectGuardTarget(guard, s.monsters)?.id]));
  for (const monster of s.monsters) {
    const defenders = s.guards.filter(g => targets.get(g.id) === monster.id);
    if (monster.progress >= 0.4 && defenders.length) {
      monster.health = clamp(monster.health - defenders.reduce((sum, g) => sum + GUARDS[g.kind].power, 0) * STEP, monster.maxHealth);
      for (const g of defenders) g.health = clamp(g.health - STEP * 2 / defenders.length, g.maxHealth);
    } else if (monster.progress >= 1) {
      s.mainHealth = clamp(s.mainHealth - STEP * 1.5);
      const crop = s.plots.find(p => p.stage === 'growing' || p.stage === 'ready');
      if (crop) crop.health = clamp(crop.health - STEP * 2);
      const animal = s.animals[0]; if (animal) animal.health = clamp(animal.health - STEP);
      // The main farmer eventually repels an intruder, so losing defenders is recoverable.
      monster.health = clamp(monster.health - STEP * 1.5, monster.maxHealth);
    }
  }
  rewardDefeats(s);
  if (!s.monsters.some(m => m.progress >= 1)) s.mainHealth = clamp(s.mainHealth + STEP * 0.3);
  if (s.policy.autoHeal && s.inventory.medicine > 0) {
    const target = [{ id: 'main', health: s.mainHealth, maxHealth: 100 }, ...s.guards, ...s.animals.map(a => ({ ...a, maxHealth: 100 }))].find(t => t.health < t.maxHealth * 0.4);
    if (target) heal(s, target.id);
  }
}

function heal(s, id) {
  const target = id === 'main' ? null : s.guards.find(g => g.id === id) ?? s.animals.find(a => a.id === id);
  if (id !== 'main' && !target) throw new Error('Healing target not found.');
  const health = target ? target.health : s.mainHealth, max = target?.maxHealth ?? 100;
  if (health >= max) throw new Error('Already at full health.');
  if (s.inventory.medicine < 1) throw new Error('Buy a healing tonic first.');
  s.inventory.medicine--;
  if (target) target.health = clamp(health + 45, max); else s.mainHealth = clamp(health + 45);
  log(s, 'Used a healing tonic.');
}

export function advanceFarm(s, seconds) {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new Error('Advance must be between 0 and 60 seconds.');
  if (!s.connected) return;
  const total = s.remainder + seconds, steps = Math.floor((total + 1e-9) / STEP);
  s.remainder = Math.round(Math.max(0, total - steps * STEP) * 1e9) / 1e9;
  for (let i = 0; i < steps; i++) {
    s.time += STEP; s.mainCooldown = Math.max(0, s.mainCooldown - STEP);
    if (s.farmer?.actionTime > 0) {
      s.farmer.actionTime = Math.max(0, s.farmer.actionTime - STEP);
      if (!s.farmer.actionTime && s.farmer.action !== 'walk') s.farmer.action = 'idle';
    }
    stepWorkers(s); stepCrops(s); stepAnimals(s); stepCombat(s);
    if (s.policy.autoSell) for (const [key, good] of Object.entries(GOODS)) {
      s.coins += s.inventory[key] * good.price; s.inventory[key] = 0;
    }
  }
}

/** Direction is bounded input, movement uses real seconds, independent of game speed. */
export function moveFarmer(s, dx, dy, seconds) {
  if (![dx, dy].every(n => Number.isFinite(n) && n >= -1 && n <= 1) || !Number.isFinite(seconds) || seconds < 0 || seconds > 2) throw new Error('Invalid farmer movement.');
  if (!s.connected || s.mainHealth < 10) return false;
  const farmer = s.farmer ??= createFarmer();
  const length = Math.hypot(dx, dy);
  if (!length || !seconds) { if (farmer.action === 'walk') farmer.action = 'idle'; return false; }
  const beforeX = farmer.x, beforeY = farmer.y;
  const steps = Math.ceil(seconds / .05), travel = 80 * seconds / steps;
  // Short collision steps prevent jumping through a building on a delayed frame.
  for (let n = 0; n < steps; n++) {
    const x = Math.max(0, Math.min(WORLD.width - 32, farmer.x + dx / Math.max(1, length) * travel));
    if (canStand(x, farmer.y)) farmer.x = x;
    const y = Math.max(34, Math.min(WORLD.height - 32, farmer.y + dy / Math.max(1, length) * travel));
    if (canStand(farmer.x, y)) farmer.y = y;
  }
  farmer.facing = Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 'right' : 'left' : dy > 0 ? 'down' : 'up';
  const moved = farmer.x !== beforeX || farmer.y !== beforeY;
  if (farmer.actionTime === 0) farmer.action = moved ? 'walk' : 'idle';
  return moved;
}

function interact(s) {
  if (!s.connected) throw new Error('Wait for the farm to reconnect.');
  if (s.mainHealth < 10) throw new Error('The main farmer needs time to recover.');
  if (s.mainCooldown > 0) throw new Error('The main farmer is finishing the last action.');
  const farmer = s.farmer ?? createFarmer();
  const distance = position => Math.hypot(position.x - farmer.x, position.y - farmer.y);
  const monster = s.monsters.filter(m => m.health > 0 && distance(monsterPosition(m)) <= 44)
    .sort((a, b) => distance(monsterPosition(a)) - distance(monsterPosition(b)))[0];
  if (monster) {
    const target = monsterPosition(monster), dx = target.x - farmer.x, dy = target.y - farmer.y;
    farmer.facing = Math.abs(dx) > Math.abs(dy) ? dx >= 0 ? 'right' : 'left' : dy >= 0 ? 'down' : 'up';
    monster.health = Math.max(0, monster.health - 12);
    farmer.action = 'attack'; farmer.actionTime = .5; s.mainCooldown = .75;
    rewardDefeats(s);
  } else {
    const nearby = s.plots.map((plot, index) => ({ plot, distance: distance(plotPosition(index)) }))
      .filter(entry => entry.plot.stage === 'ready' && entry.distance <= 44).sort((a, b) => a.distance - b.distance)[0];
    if (!nearby) throw new Error('Move closer to a ripe crop or a monster, then press Space.');
    harvest(s, nearby.plot); farmer.action = 'harvest'; farmer.actionTime = .5; s.mainCooldown = .5;
  }
  s.farmer = farmer;
}

/** Player actions other than movement. Definitions, not callers, set prices/yields. */
export function command(s, action) {
  if (!action || typeof action !== 'object' || typeof action.type !== 'string') throw new Error('A farm command is required.');
  switch (action.type) {
    case 'interact': interact(s); break;
    case 'harvest': harvest(s, lookup(s.plots, action.plotId, 'Plot')); break;
    case 'harvestAll': for (const p of s.plots) if (p.stage === 'ready') harvest(s, p); break;
    case 'crop': {
      const p = lookup(s.plots, action.plotId, 'Plot');
      if (!own(CROPS, action.crop)) throw new Error('Unknown crop.');
      if (!['empty', 'dead', 'tilled'].includes(p.stage)) throw new Error('Harvest or clear this plot before changing its crop.');
      p.crop = action.crop; p.growth = 0; break;
    }
    case 'tend': {
      const p = lookup(s.plots, action.plotId, 'Plot');
      if (s.mainHealth < 10) throw new Error('The main farmer needs time to recover.');
      if (s.mainCooldown > 0) throw new Error('The main farmer is finishing the last action.');
      const kind = plotJob(s, p);
      if (!kind) throw new Error('This plot needs no care right now.');
      if (s.workers.some(w => w.job?.targetId === p.id)) throw new Error('A worker is already tending this plot.');
      completeCare(s, { targetId: p.id, kind }); s.mainCooldown = 3;
      const farmer = s.farmer ??= createFarmer(); farmer.action = 'harvest'; farmer.actionTime = 3; break;
    }
    case 'assign': {
      const worker = lookup(s.workers, action.workerId, 'Worker');
      if (!['auto', 'livestock', ...s.plots.map(p => p.id)].includes(action.targetId)) throw new Error('Unknown work assignment.');
      worker.assignment = action.targetId; worker.job = null; break;
    }
    case 'policy':
      if (!['autoHarvest', 'autoSell', 'autoCollect', 'autoHeal'].includes(action.key) || typeof action.value !== 'boolean') throw new Error('Invalid automation policy.');
      s.policy[action.key] = action.value; break;
    case 'buy': {
      if (!own(SHOP, action.item)) throw new Error('Unknown shop item.');
      const item = SHOP[action.item];
      if (s.coins < item.cost) throw new Error(`You need ${item.cost} coins.`);
      if (own(ANIMALS, action.item) && s.animals.length >= 12) throw new Error('The animal pen is full (12 animals).');
      s.coins -= item.cost;
      if (own(ANIMALS, action.item)) { const n = s.nextId++; s.animals.push(freshAnimal(`animal-${n}`, action.item, `${ANIMALS[action.item].name} ${n}`)); }
      else s.inventory[action.item] += item.quantity;
      log(s, `Bought ${item.name.toLowerCase()} for ${item.cost} coins.`); break;
    }
    case 'sell': {
      if (!own(GOODS, action.item)) throw new Error('This item cannot be sold.');
      const quantity = action.quantity ?? s.inventory[action.item];
      if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > s.inventory[action.item]) throw new Error('Choose a quantity you own.');
      const total = quantity * GOODS[action.item].price;
      s.inventory[action.item] -= quantity; s.coins += total;
      log(s, `Sold ${quantity} ${GOODS[action.item].name.toLowerCase()} for ${total} coins.`); break;
    }
    case 'collect': collect(s, lookup(s.animals, action.animalId, 'Animal')); break;
    case 'slaughter': {
      const animal = lookup(s.animals, action.animalId, 'Animal'), definition = ANIMALS[animal.kind];
      s.inventory.meat += definition.meat; s.inventory.hide += definition.hide;
      s.animals = s.animals.filter(a => a.id !== animal.id);
      for (const w of s.workers) if (w.job?.targetId === animal.id) w.job = null;
      log(s, `Processed ${animal.name}: ${definition.meat} meat and ${definition.hide} hides.`); break;
    }
    case 'hire': {
      if (!own(GUARDS, action.kind)) throw new Error('Unknown protector.');
      const g = GUARDS[action.kind];
      if (s.coins < g.cost) throw new Error(`You need ${g.cost} coins.`);
      if (s.guards.length >= 12) throw new Error('Your protector roster is full.');
      s.coins -= g.cost; s.guards.push({ id: `guard-${s.nextId++}`, kind: action.kind, health: g.maxHealth, maxHealth: g.maxHealth, mode: 'patrol', progress: 0 });
      log(s, `Hired a ${g.name.toLowerCase()}.`); break;
    }
    case 'guardMode': {
      const g = lookup(s.guards, action.guardId, 'Protector');
      if (!['home', 'patrol', 'expedition'].includes(action.mode)) throw new Error('Unknown protector order.');
      if (action.mode !== 'home' && g.health <= g.maxHealth * 0.2) throw new Error('This protector needs to recover at home.');
      g.mode = action.mode; g.progress = 0; break;
    }
    case 'heal': heal(s, action.targetId); break;
    case 'raid': spawnRaid(s); break;
    case 'recover':
      if (s.inventory.seeds > 0 || s.coins >= SHOP.seeds.cost) throw new Error('Starter seeds are for when you cannot afford to replant.');
      s.inventory.seeds = 6; log(s, 'A neighbor left six starter seeds so you can begin again.'); break;
    default: throw new Error('Unknown farm command.');
  }
}
