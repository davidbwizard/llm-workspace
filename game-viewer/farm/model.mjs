import { CROPS, GOODS, GUARDS, SHOP, ANIMALS, JOBS, MONSTERS, POSTS, guardStats, upgradeCost, landCost, raidProfile, own } from './definitions.mjs';
import { normalizeSnapshot } from './sessions.mjs';
import { WORLD, createFarmer, canStand, plotPosition, monsterPosition, animalPosition, inReach, distance, face, radius, clearPath, moveActor } from './world.mjs';
import { createGuard, spawnRaid, stepCombat, playerAttack, rewardDefeats, cleanReferences } from './combat.mjs';
import { createBalance, setBalanceValue, resetBalance, farmerStats, plotStats, animalStats, RECOVER_RATIO } from './balance.mjs';
export { selectGuardTarget } from './combat.mjs';
export { validateFarm, upgradeFarm } from './validation.mjs';
export { statsFor, BALANCE_FIELDS, BALANCE_GROUPS, DEFAULT_BALANCE, fieldsFor } from './balance.mjs';

const STEP = 0.05;
// The player's own Space-key/nearby-action reach (getInteractionTarget, single-plot
// buttons); distinct from the tunable sword reach in balance.mjs.
const COLLECTION_REACH = 30;
const WORKER_SPEED = 63;
const clamp = (n, max = 100) => Math.max(0, Math.min(max, n));
const lookup = (list, id, name) => { const found = list.find(item => item.id === id); if (!found) throw new Error(`${name} not found.`); return found; };
const log = (s, text) => { s.events.unshift({ id: s.nextId++, time: s.time, text }); s.events.length = Math.min(40, s.events.length); };
const freshPlot = (id, crop = 'parsnip', unlocked = true, max = 100) => ({ id, crop, unlocked, stage: 'empty', growth: 0, water: 0, health: max, neglect: 0, weeds: 0 });
const freshAnimal = (id, kind, name, max = 100) => ({ id, kind, name, health: max, hunger: 80, production: 0, produce: 0 });
// A worker's rest spot when idle or between jobs; also its position before a first job.
const workerHome = i => ({ x: 61 + (i % 6) * 25, y: 154 + Math.floor(i / 6) * 28 });
/** Whether the farmer is within collection reach of an arbitrary point. */
function nearFarmer(s, x, y) { return inReach(s.farmer ?? createFarmer(), { x, y }, COLLECTION_REACH); }
/** Player-only proximity gates for command(); automation and helpers are unaffected. */
export function nearPlot(s, plotId) {
  const i = s.plots.findIndex(p => p.id === plotId);
  if (i < 0) return false;
  const { x, y } = plotPosition(i); return nearFarmer(s, x, y);
}
export function nearAnimal(s, animalId) {
  const i = s.animals.findIndex(a => a.id === animalId);
  if (i < 0) return false;
  const { x, y } = animalPosition(i); return nearFarmer(s, x, y);
}

/** An optional validated configuration seeds a new farm; it is copied, never shared. */
export function createFarm(balance) {
  const config = createBalance(balance);
  return {
    version: 3, balance: config, time: 0, remainder: 0, harvests: 0, coins: 35,
    mainHealth: config.farmer.main.maxHealth, mainCooldown: 0, farmer: createFarmer(),
    nextId: 100, raidTimer: 150, wave: 0, connected: true, sessionRevision: -1,
    plots: Array.from({ length: 12 }, (_, i) => freshPlot(`p${i + 1}`, i >= 8 ? 'wheat' : 'parsnip', i < 3, config.plots.land.maxHealth)),
    animals: [freshAnimal('cow-1', 'cow', 'Clover', config.animals.cow.maxHealth), freshAnimal('sheep-1', 'sheep', 'Willow', config.animals.sheep.maxHealth)],
    guards: [createGuard('guard-1', 'scout', 0, config)],
    monsters: [], workers: [],
    inventory: { parsnip: 0, wheat: 0, milk: 0, wool: 0, meat: 0, hide: 0, seeds: 6, feed: 8, medicine: 1 },
    policy: { autoHarvest: false, autoSell: false, autoCollect: true, autoHeal: true },
    events: [{ id: 1, time: 0, text: 'Welcome home. Your workers will tend the farm while their sessions work.' }],
  };
}

export function applySessionSnapshot(s, input) {
  const snapshot = normalizeSnapshot(input);
  if (snapshot.revision <= s.sessionRevision) return false;
  const previous = new Map(s.workers.map(w => [w.id, w]));
  const workers = snapshot.roots.map((root, i) => {
    const old = previous.get(root.id);
    const attention = root.attention ?? root.descendants.find(child => child.attention)?.attention ?? null;
    let activity = root.activity;
    if (attention) activity = attention.kind === 'permission' || root.activity === 'waiting_permission' ? 'waiting_permission' : 'waiting_input';
    else if (!activity.startsWith('waiting_') && root.descendants.some(child => child.activity === 'working')) activity = 'working';
    if (!snapshot.connected) activity = 'unknown';
    // Position/facing are transient (never saved); a returning worker keeps its spot,
    // a new one starts at its home spot and walks to its first job like any other.
    const home = workerHome(i);
    return { id: root.id, name: root.name, provider: root.provider, activity, attention,
      assignment: old?.assignment ?? 'auto', job: activity === 'working' ? old?.job ?? null : null,
      action: activity === 'working' ? old?.action ?? 'Looking for work' : attention ? 'Waiting for you' : activity === 'unknown' ? 'Reconnecting' : 'Resting',
      x: old?.x ?? home.x, y: old?.y ?? home.y, facing: old?.facing ?? 'down', moving: old?.moving ?? false };
  });
  s.workers = workers; s.sessionRevision = snapshot.revision; s.connected = snapshot.connected;
  return true;
}

function harvest(s, plot) {
  if (!plot.unlocked) throw new Error('Unlock this land before farming it.');
  if (plot.stage !== 'ready') throw new Error('This crop is not ready to harvest.');
  const crop = CROPS[plot.crop]; s.inventory[plot.crop] += crop.yield;
  log(s, `Harvested ${crop.yield} ${crop.name.toLowerCase()} from plot ${plot.id.slice(1)}.`);
  const oldTier = raidProfile(s.harvests).tier; s.harvests++;
  if (raidProfile(s.harvests).tier > oldTier) log(s, `The harvest has attracted new threats: ${raidProfile(s.harvests).name}. Improve your defenses.`);
  Object.assign(plot, freshPlot(plot.id, plot.crop, plot.unlocked));
  for (const worker of s.workers) if (worker.job?.targetId === plot.id) worker.job = null;
}

function collect(s, animal) {
  if (animal.produce <= 0) throw new Error('No products are ready yet.');
  const product = ANIMALS[animal.kind].product;
  s.inventory[product] += animal.produce;
  log(s, `Collected ${animal.produce} ${product} from ${animal.name}.`); animal.produce = 0;
}

function plotJob(s, p) {
  if (!p.unlocked) return null;
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
      case 'clear': if (p.stage === 'dead') Object.assign(p, freshPlot(p.id, p.crop, p.unlocked, plotStats(s).maxHealth)); break;
      case 'till': if (p.stage === 'empty') p.stage = 'tilled'; break;
      case 'plant': if (p.stage === 'tilled' && s.inventory.seeds > 0) { s.inventory.seeds--; p.stage = 'growing'; p.water = 70; } break;
      case 'water': if (['growing', 'ready'].includes(p.stage)) { p.water = 100; p.neglect = 0; p.health = clamp(p.health + 10, plotStats(s).maxHealth); } break;
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

// A job's physical destination: the plot's edge, or the specific animal a worker
// feeds/collects from (never a generic spot by the pen).
function jobTarget(s, job) {
  if (['feed', 'collect'].includes(job.kind)) {
    const i = s.animals.findIndex(a => a.id === job.targetId);
    return i < 0 ? null : animalPosition(i);
  }
  const i = s.plots.findIndex(p => p.id === job.targetId);
  return i < 0 ? null : { x: plotPosition(i).x - 9, y: plotPosition(i).y + 12 };
}

function stepWorkers(s) {
  const occupied = new Set(s.workers.filter(w => w.job).map(w => w.job.targetId));
  s.workers.forEach((worker, i) => {
    const home = workerHome(i);
    worker.x ??= home.x; worker.y ??= home.y; worker.facing ??= 'down';
    if (worker.activity !== 'working') { worker.moving = moveActor(worker, home, WORKER_SPEED, STEP, 2); return; }
    if (worker.job && !s.plots.some(p => p.id === worker.job.targetId) && !s.animals.some(a => a.id === worker.job.targetId)) { occupied.delete(worker.job.targetId); worker.job = null; }
    if (!worker.job) {
      worker.job = chooseJob(s, worker, occupied);
      if (worker.job) occupied.add(worker.job.targetId);
    }
    if (!worker.job) { worker.action = 'All caught up'; worker.moving = moveActor(worker, home, WORKER_SPEED, STEP, 2); return; }
    const job = worker.job, target = jobTarget(s, job);
    if (!target) { occupied.delete(job.targetId); worker.job = null; worker.moving = moveActor(worker, home, WORKER_SPEED, STEP, 2); return; }
    moveActor(worker, target, WORKER_SPEED, STEP, 2);
    // A job only progresses once its helper has actually walked over to the target.
    const arrived = distance(worker, target) <= 3;
    worker.moving = !arrived;
    const verbs = { till: 'Hoeing', plant: 'Planting', water: 'Watering', weed: 'Weeding', clear: 'Clearing', harvest: 'Harvesting', feed: 'Feeding & watering', collect: 'Collecting' };
    worker.action = arrived ? verbs[job.kind] : 'Walking over';
    if (!arrived) return;
    job.progress += STEP;
    if (job.progress >= job.duration) { completeCare(s, job); occupied.delete(job.targetId); worker.job = null; }
  });
}

function stepCrops(s) {
  for (const p of s.plots) {
    if (!p.unlocked || !['growing', 'ready'].includes(p.stage)) continue;
    p.water = clamp(p.water - STEP * 0.5); p.weeds = clamp(p.weeds + STEP * 0.15);
    if (p.water <= 0) {
      p.neglect += STEP;
      if (p.neglect > 15) p.health = clamp(p.health - STEP, plotStats(s).maxHealth);
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
    if (a.hunger === 0) a.health = clamp(a.health - STEP * 0.3, animalStats(s, a.kind).maxHealth);
    else if (a.hunger > 20 && a.health > 0 && a.produce < 10) {
      a.production += STEP;
      if (a.production + 1e-8 >= ANIMALS[a.kind].productionTime) { a.production = Math.max(0, a.production - ANIMALS[a.kind].productionTime); a.produce++; log(s, `${a.name} has ${ANIMALS[a.kind].product} ready.`); }
    }
  }
  for (const a of s.animals.filter(a => a.health <= 0)) {
    log(s, `${a.name} died. Keep animals fed and protected.`);
    for (const worker of s.workers) if (worker.job?.targetId === a.id) worker.job = null;
  }
  s.animals = s.animals.filter(a => a.health > 0);
}

function heal(s, id) {
  const target = id === 'main' ? null : s.guards.find(g => g.id === id) ?? s.animals.find(a => a.id === id);
  if (id !== 'main' && !target) throw new Error('Healing target not found.');
  const health = target ? target.health : s.mainHealth;
  const max = !target ? farmerStats(s).maxHealth : target.maxHealth ?? animalStats(s, target.kind).maxHealth;
  if (health >= max) throw new Error('Already at full health.');
  if (s.inventory.medicine < 1) throw new Error('Buy a healing tonic first.');
  s.inventory.medicine--;
  if (target) target.health = clamp(health + 45, max); else s.mainHealth = clamp(health + 45, max);
  log(s, 'Used a healing tonic.');
}

export function advanceFarm(s, seconds) {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new Error('Advance must be between 0 and 60 seconds.');
  if (!s.connected) return;
  const total = s.remainder + seconds, steps = Math.floor((total + 1e-9) / STEP);
  s.remainder = Math.round(Math.max(0, total - steps * STEP) * 1e9) / 1e9;
  for (let i = 0; i < steps; i++) {
    s.time = Math.round((s.time + STEP) * 1e9) / 1e9; s.mainCooldown = Math.max(0, s.mainCooldown - STEP);
    if (s.farmer?.actionTime > 0) {
      s.farmer.actionTime = Math.max(0, s.farmer.actionTime - STEP);
      if (!s.farmer.actionTime && s.farmer.action !== 'walk') s.farmer.action = 'idle';
    }
    stepWorkers(s); stepCrops(s); stepAnimals(s); stepCombat(s, STEP, log);
    for (const p of s.plots) if (p.health <= 0 && p.unlocked && p.stage !== 'dead') { p.stage = 'dead'; log(s, `Monsters ruined plot ${p.id.slice(1)}. Tend it to repair the ground.`); }
    for (const a of s.animals.filter(a => a.health <= 0)) log(s, `${a.name} was killed by a monster.`);
    s.animals = s.animals.filter(a => a.health > 0);
    // Protectors fight to the death: only a patrolling guard can reach zero health,
    // and doing so kills it permanently, upgrades included, same as an animal dying.
    for (const g of s.guards.filter(g => g.mode === 'patrol' && g.health <= 0)) log(s, `${GUARDS[g.kind].name} was killed by a monster.`);
    s.guards = s.guards.filter(g => g.mode !== 'patrol' || g.health > 0);
    cleanReferences(s);
    if (s.policy.autoHeal && s.inventory.medicine > 0) {
      const target = [{ id: 'main', health: s.mainHealth, maxHealth: farmerStats(s).maxHealth }, ...s.guards,
        ...s.animals.map(a => ({ ...a, maxHealth: animalStats(s, a.kind).maxHealth }))].find(t => t.health < t.maxHealth * .4);
      if (target) heal(s, target.id);
    }
    if (s.policy.autoSell) for (const [key, good] of Object.entries(GOODS)) {
      s.coins += s.inventory[key] * good.price; s.inventory[key] = 0;
    }
  }
}

/** Direction is bounded input, movement uses real seconds, independent of game speed. */
export function moveFarmer(s, dx, dy, seconds) {
  if (![dx, dy].every(n => Number.isFinite(n) && n >= -1 && n <= 1) || !Number.isFinite(seconds) || seconds < 0 || seconds > 2) throw new Error('Invalid farmer movement.');
  const stats = farmerStats(s);
  if (!s.connected || s.mainHealth < stats.maxHealth * RECOVER_RATIO) return false;
  const farmer = s.farmer ??= createFarmer();
  const length = Math.hypot(dx, dy);
  if (!length || !seconds) { if (farmer.action === 'walk') farmer.action = 'idle'; return false; }
  const beforeX = farmer.x, beforeY = farmer.y;
  const canMove = (x,y) => canStand(x,y) && s.monsters.every(m => {
    const next=distance({x,y},m); return next>=radius(farmer)+radius(m) || next>distance(farmer,m);
  });
  const steps = Math.ceil(seconds / .05), travel = stats.speed * seconds / steps;
  // Short collision steps prevent jumping through a building on a delayed frame.
  for (let n = 0; n < steps; n++) {
    const x = Math.max(0, Math.min(WORLD.width - 32, farmer.x + dx / Math.max(1, length) * travel));
    if (canMove(x, farmer.y)) farmer.x = x;
    const y = Math.max(34, Math.min(WORLD.height - 32, farmer.y + dy / Math.max(1, length) * travel));
    if (canMove(farmer.x, y)) farmer.y = y;
  }
  farmer.facing = Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 'right' : 'left' : dy > 0 ? 'down' : 'up';
  const moved = farmer.x !== beforeX || farmer.y !== beforeY;
  if (farmer.actionTime === 0) farmer.action = moved ? 'walk' : 'idle';
  return moved;
}

export function getInteractionTarget(s) {
  const farmer = s.farmer ?? createFarmer();
  const monster = s.monsters.filter(m => m.health > 0 && inReach(farmer, m, farmerStats(s).reach) && clearPath(farmer,m)).sort((a,b) => distance(farmer,a)-distance(farmer,b))[0];
  if (monster) return { type: 'attack', id: monster.id, ...monsterPosition(monster), name: MONSTERS[monster.kind].name };
  const targets = [
    ...s.plots.flatMap((p,i) => p.unlocked && p.stage === 'ready' ? [{ type: 'harvest', id: p.id, ...plotPosition(i), name: CROPS[p.crop].name }] : []),
    ...s.animals.flatMap((a,i) => a.produce > 0 ? [{ type: 'collect', id: a.id, ...animalPosition(i), name: ANIMALS[a.kind].product }] : []),
  ];
  return targets.filter(t => inReach(farmer,t,COLLECTION_REACH)).sort((a,b)=>distance(farmer,a)-distance(farmer,b))[0] ?? null;
}

function interact(s) {
  const stats = farmerStats(s);
  if (!s.connected) throw new Error('Wait for the farm to reconnect.');
  if (s.mainHealth < stats.maxHealth * RECOVER_RATIO) throw new Error('The main farmer needs time to recover.');
  if (s.mainCooldown > 1e-8) return;
  const farmer = s.farmer ??= createFarmer(), target = getInteractionTarget(s);
  if (!target || target.type === 'attack') {
    if (target) { face(farmer,target); playerAttack(s,s.monsters.find(m=>m.id===target.id)); rewardDefeats(s,log); }
    farmer.action = 'attack'; farmer.actionTime = .5; s.mainCooldown = stats.interval;
  } else {
    if (target.type === 'harvest') harvest(s, s.plots.find(p=>p.id===target.id));
    else collect(s, s.animals.find(a=>a.id===target.id));
    face(farmer,target); farmer.action = 'harvest'; farmer.actionTime = .5; s.mainCooldown = .5;
  }
}

/** Player actions other than movement. Definitions, not callers, set prices/yields. */
export function command(s, action) {
  if (!action || typeof action !== 'object' || typeof action.type !== 'string') throw new Error('A farm command is required.');
  switch (action.type) {
    case 'interact': interact(s); break;
    case 'harvest': {
      const p = lookup(s.plots, action.plotId, 'Plot');
      if (!nearPlot(s, p.id)) throw new Error('Walk closer to harvest this plot.');
      harvest(s, p); break;
    }
    case 'harvestAll': for (const p of s.plots) if (p.unlocked && p.stage === 'ready') harvest(s, p); break;
    case 'crop': {
      const p = lookup(s.plots, action.plotId, 'Plot');
      if (!p.unlocked) throw new Error('Unlock this land before farming it.');
      if (!own(CROPS, action.crop)) throw new Error('Unknown crop.');
      if (!['empty', 'dead', 'tilled'].includes(p.stage)) throw new Error('Harvest or clear this plot before changing its crop.');
      p.crop = action.crop; p.growth = 0; break;
    }
    case 'tend': {
      const p = lookup(s.plots, action.plotId, 'Plot');
      if (!p.unlocked) throw new Error('Unlock this land before farming it.');
      if (!nearPlot(s, p.id)) throw new Error('Walk closer to tend this plot.');
      if (s.mainHealth < farmerStats(s).maxHealth * RECOVER_RATIO) throw new Error('The main farmer needs time to recover.');
      if (s.mainCooldown > 0) throw new Error('The main farmer is finishing the last action.');
      const kind = plotJob(s, p);
      if (!kind) throw new Error('This plot needs no care right now.');
      if (s.workers.some(w => w.job?.targetId === p.id)) throw new Error('A worker is already tending this plot.');
      completeCare(s, { targetId: p.id, kind }); s.mainCooldown = 3;
      const farmer = s.farmer ??= createFarmer(); farmer.action = 'harvest'; farmer.actionTime = 3; break;
    }
    case 'assign': {
      const worker = lookup(s.workers, action.workerId, 'Worker');
      if (!['auto', 'livestock', ...s.plots.filter(p => p.unlocked).map(p => p.id)].includes(action.targetId)) throw new Error('Unknown work assignment.');
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
      if (own(ANIMALS, action.item)) { const n = s.nextId++; s.animals.push(freshAnimal(`animal-${n}`, action.item, `${ANIMALS[action.item].name} ${n}`, animalStats(s, action.item).maxHealth)); }
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
    case 'collect': {
      const a = lookup(s.animals, action.animalId, 'Animal');
      if (!nearAnimal(s, a.id)) throw new Error('Walk closer to collect from this animal.');
      collect(s, a); break;
    }
    case 'slaughter': {
      const animal = lookup(s.animals, action.animalId, 'Animal'), definition = ANIMALS[animal.kind];
      if (!nearAnimal(s, animal.id)) throw new Error('Walk closer to slaughter this animal.');
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
      s.coins -= g.cost; s.guards.push(createGuard(`guard-${s.nextId++}`, action.kind, s.guards.length, s.balance));
      log(s, `Hired a ${g.name.toLowerCase()}.`); break;
    }
    case 'unlockPlot': {
      const plot = lookup(s.plots, action.plotId, 'Plot');
      if (plot.unlocked) throw new Error('This plot is already unlocked.');
      const cost = landCost(s); if (s.coins < cost) throw new Error(`You need ${cost} coins to unlock land.`);
      s.coins -= cost; plot.unlocked = true; log(s, `Unlocked plot ${plot.id.slice(1)} for ${cost} coins.`); break;
    }
    case 'guardPost': {
      const guard = lookup(s.guards, action.guardId, 'Protector');
      if (!own(POSTS, action.post)) throw new Error('Unknown patrol post.');
      guard.post = action.post; guard.patrolIndex = 0; guard.targetId = null; break;
    }
    case 'upgradeGuard': {
      const guard = lookup(s.guards, action.guardId, 'Protector'), cost = upgradeCost(guard);
      if (cost === null) throw new Error('This protector is fully upgraded.');
      if (s.coins < cost) throw new Error(`You need ${cost} coins.`);
      const oldMax = guard.maxHealth; s.coins -= cost; guard.level++;
      guard.maxHealth = guardStats(guard, s.balance).maxHealth; guard.health += guard.maxHealth - oldMax;
      log(s, `${GUARDS[guard.kind].name} upgraded to level ${guard.level}.`); break;
    }
    case 'guardMode': {
      const g = lookup(s.guards, action.guardId, 'Protector');
      if (!['home', 'patrol', 'expedition'].includes(action.mode)) throw new Error('Unknown protector order.');
      // Protectors fight to the death; sending a wounded one onto patrol is the player's call.
      g.mode = action.mode; g.progress = 0; break;
    }
    case 'balance': setBalanceValue(s, action.group, action.kind, action.field, action.value); break;
    case 'resetBalance': resetBalance(s); break;
    case 'heal': {
      // Only an animal needs the farmer nearby; healing yourself or a protector works from anywhere.
      if (s.animals.some(a => a.id === action.targetId) && !nearAnimal(s, action.targetId)) throw new Error('Walk closer to heal this animal.');
      heal(s, action.targetId); break;
    }
    case 'raid': spawnRaid(s, log); break;
    case 'recover':
      if (s.inventory.seeds > 0 || s.coins >= SHOP.seeds.cost) throw new Error('Starter seeds are for when you cannot afford to replant.');
      s.inventory.seeds = 6; log(s, 'A neighbor left six starter seeds so you can begin again.'); break;
    default: throw new Error('Unknown farm command.');
  }
  cleanReferences(s);
}
