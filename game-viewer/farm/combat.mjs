import { GUARDS, MONSTERS, EXPEDITION_TIME, guardStats, raidProfile } from './definitions.mjs';
import { farmerStats, plotStats, animalStats, monsterStats, RECOVER_RATIO } from './balance.mjs';
import { PATROLS, guardHome, spatialFields, animalPosition, plotPosition, radius, distance, inReach, face, moveActor, canStand, clearPath } from './world.mjs';

export function createGuard(id, kind, index = 0, balance) {
  const point = PATROLS.farm[index % 4], max = guardStats({ kind, level: 1 }, balance).maxHealth;
  return { id, kind, health: max, maxHealth: max, mode: 'patrol', progress: 0,
    post: 'farm', level: 1, patrolIndex: (index + 1) % 4, ...spatialFields(point.x, point.y) };
}

export function spawnRaid(s, log) {
  const profile = raidProfile(s.harvests), count = Math.min(profile.count, 8 - s.monsters.length);
  if (!count) throw new Error('There are already eight creatures approaching.');
  s.wave++;
  const sides = ['west', 'north', 'east', 'south'];
  for (let i = 0; i < count; i++) {
    const side = sides[(s.wave - 1 + i) % 4], jitter = (s.wave * 37 + i * 61) % 100;
    const point = side === 'west' ? { x: 0, y: 145 + jitter } : side === 'north' ? { x: 240 + jitter * 2, y: 34 }
      : side === 'east' ? { x: 608, y: 145 + jitter } : { x: 200 + jitter * 3, y: 358 };
    const kind = profile.kinds[(s.wave - 1 + i) % profile.kinds.length], max = monsterStats(s, kind).maxHealth;
    s.monsters.push({ id: `monster-${s.nextId++}`, kind, spawn: side, health: max, maxHealth: max, ...spatialFields(point.x, point.y) });
  }
  log(s, `${count === 1 ? 'A creature approaches' : `${count} creatures approach`} from ${[...new Set(s.monsters.slice(-count).map(m => m.spawn))].join(' and ')}. Protect the farm!`);
}

export function rewardDefeats(s, log) {
  for (const m of s.monsters) if (m.health <= 0) {
    const definition = MONSTERS[m.kind]; s.coins += definition.reward;
    log(s, `${definition.name} defeated. Earned ${definition.reward} coins.`);
  }
  s.monsters = s.monsters.filter(m => m.health > 0);
}

function strike(s, attacker, target, power, armor = 0) {
  target.health = Math.max(0, target.health - Math.max(0, power - armor));
  face(attacker, target);
  attacker.strikeId = s.nextId++; attacker.strikeX = target.x; attacker.strikeY = target.y; attacker.strikeTargetId = target.id;
}

export function playerAttack(s, monster) {
  const damage = Math.max(0, farmerStats(s).power - monsterStats(s, monster.kind).armor);
  monster.health = Math.max(0, monster.health - damage);
  monster.targetId = 'main';
}

/** Same coordinates and body radii used by movement, rendering, and player reach.
 * Protectors fight to the death: only mode gates targeting, not remaining health. */
export function selectGuardTarget(guard, monsters, claimed = new Map(), balance) {
  if (guard.mode !== 'patrol') return null;
  const definition = guardStats(guard, balance);
  const current = monsters.find(m => m.id === guard.targetId && m.health > 0 && distance(guard, m) <= definition.vision);
  if (current) return current;
  let nearest = null, best = Infinity;
  for (const m of monsters) {
    const d = distance(guard, m), score = d + (claimed.get(m.id) ?? 0) * 65;
    if (m.health > 0 && d <= definition.vision && score < best) { nearest = m; best = score; }
  }
  return nearest;
}

function mainTarget(s) { return { id: 'main', x: s.farmer.x, y: s.farmer.y, health: s.mainHealth, type: 'main' }; }
function farmTargets(s) {
  return [
    ...s.plots.flatMap((p, i) => p.unlocked && p.stage !== 'dead' && p.health > 0 ? [{ ...p, ...plotPosition(i), type: 'crop' }] : []),
    ...s.animals.filter(a => a.health > 0).map((a, i) => ({ ...a, ...animalPosition(i), type: 'animal' })),
  ];
}
function selectMonsterTarget(s, monster) {
  const definition = MONSTERS[monster.kind];
  // Protectors fight to the death, so any living patrolling guard is a fair target.
  const nearby = s.guards.filter(g => g.mode === 'patrol' && g.health > 0 && distance(monster, g) <= 125)
    .map(g => ({ ...g, type: 'guard' }));
  if (s.mainHealth >= farmerStats(s).maxHealth * RECOVER_RATIO && distance(monster, s.farmer) <= 70) nearby.push(mainTarget(s));
  // The farmer can draw aggro with a sword. Livestock raiders otherwise favor stock.
  const provoked = monster.targetId === 'main' && nearby.find(target => target.id === 'main');
  if (provoked) return provoked;
  if (nearby.length) return nearby.sort((a, b) => distance(monster, a) - distance(monster, b))[0];
  const targets = farmTargets(s), preferred = targets.filter(t => t.type === definition.preference);
  const pool = preferred.length ? preferred : targets;
  if (pool.length) return pool.sort((a, b) => distance(monster, a) - distance(monster, b))[0];
  return s.mainHealth >= farmerStats(s).maxHealth * RECOVER_RATIO ? mainTarget(s) : null;
}

function harmTarget(s, monster, target, definition) {
  const victim = target.type === 'main' ? target : target.type === 'guard' ? s.guards.find(g => g.id === target.id)
    : target.type === 'crop' ? s.plots.find(p => p.id === target.id) : s.animals.find(a => a.id === target.id);
  if (!victim) return;
  const armor = target.type === 'guard' ? guardStats(victim, s.balance).armor
    : target.type === 'main' ? farmerStats(s).armor
    : target.type === 'crop' ? plotStats(s).armor : animalStats(s, victim.kind).armor;
  // Some targets derive positions (crops/livestock); damage still reaches the real entity.
  const hit = { ...target, health: victim.health };
  strike(s, monster, hit, definition.power, armor);
  if (target.type === 'main') s.mainHealth = hit.health; else victim.health = hit.health;
}

function separateFighters(s) {
  for (const g of [...s.guards, s.farmer]) for (const m of s.monsters) {
    const d = distance(g, m), minimum = radius(g) + radius(m) + 1;
    if (d >= minimum) continue;
    const dx = d ? (g.x - m.x) / d : 1, dy = d ? (g.y - m.y) / d : 0, shift = (minimum - d) / 2;
    if (canStand(g.x + dx * shift, g.y + dy * shift)) { g.x += dx * shift; g.y += dy * shift; }
    if (canStand(m.x - dx * shift, m.y - dy * shift)) { m.x -= dx * shift; m.y -= dy * shift; }
  }
}

export function stepCombat(s, dt, log) {
  s.raidTimer = Math.max(0, s.raidTimer - dt);
  if (s.raidTimer < 1e-8) { if (s.monsters.length < 8) spawnRaid(s, log); s.raidTimer = raidProfile(s.harvests).interval; }
  const claimed = new Map();
  for (const [index, guard] of s.guards.entries()) {
    const definition = guardStats(guard, s.balance); guard.cooldown = Math.max(0, guard.cooldown - dt);
    // Protectors fight to the death: no automatic retreat. Home only heals; a fully
    // healed guard resumes patrol on its own once it actually arrives home.
    if (guard.mode === 'home') {
      guard.targetId = null; const home = guardHome(index);
      moveActor(guard, home, definition.speed, dt, 3);
      if (distance(guard, home) <= 5) {
        guard.health = Math.min(guard.maxHealth, guard.health + dt * .8);
        if (guard.health >= guard.maxHealth) { guard.mode = 'patrol'; guard.progress = 0; }
      }
      continue;
    }
    if (guard.mode === 'expedition') {
      guard.targetId = null; moveActor(guard, { x: 598, y: 120 + index % 3 * 20 }, definition.speed, dt, 4);
      guard.progress += dt;
      if (guard.progress + 1e-8 >= EXPEDITION_TIME) {
        const reward = 10 + Math.round(definition.power * 1.5);
        // Expedition wear is not combat: it can leave a guard critical but never kill it.
        s.coins += reward; guard.health = Math.max(1, guard.health - 18); guard.mode = 'home'; guard.progress = 0;
        log(s, `${definition.name} returned with ${reward} coins.`);
      }
      continue;
    }
    const target = selectGuardTarget(guard, s.monsters, claimed, s.balance); guard.targetId = target?.id ?? null;
    if (target) {
      claimed.set(target.id, (claimed.get(target.id) ?? 0) + 1);
      moveActor(guard, target, definition.speed, dt, radius(guard) + radius(target) + definition.reach - 1);
      if (inReach(guard, target, definition.reach) && clearPath(guard, target) && guard.cooldown <= 1e-8) {
        strike(s, guard, target, definition.power, monsterStats(s, target.kind).armor); guard.cooldown = definition.interval;
      }
    } else {
      const route = PATROLS[guard.post], point = route[guard.patrolIndex];
      moveActor(guard, point, definition.speed, dt, 2);
      if (distance(guard, point) <= 3) guard.patrolIndex = (guard.patrolIndex + 1) % route.length;
    }
  }
  for (const monster of s.monsters) {
    if (monster.health <= 0) continue;
    const definition = { ...MONSTERS[monster.kind], ...monsterStats(s, monster.kind) }; monster.cooldown = Math.max(0, monster.cooldown - dt);
    const target = selectMonsterTarget(s, monster); monster.targetId = target?.id ?? null;
    if (!target) continue;
    moveActor(monster, target, definition.speed, dt, radius(monster) + radius(target) + definition.reach - 1);
    if (inReach(monster, target, definition.reach) && clearPath(monster, target) && monster.cooldown <= 1e-8) {
      harmTarget(s, monster, target, definition); monster.cooldown = definition.interval;
    }
  }
  separateFighters(s); rewardDefeats(s, log);
  if (!s.monsters.some(m => m.targetId === 'main' && inReach(m, s.farmer, monsterStats(s, m.kind).reach))) s.mainHealth = Math.min(farmerStats(s).maxHealth, s.mainHealth + dt * .3);
}

/** Active IDs must remain valid; strikeTargetId intentionally records history. */
export function cleanReferences(s) {
  const enemies = new Set(s.monsters.filter(m => m.health > 0).map(m => m.id));
  const cropIds = new Set(s.plots.filter(p => p.unlocked && ['growing', 'ready'].includes(p.stage) && p.health > 0).map(p => p.id));
  const animalIds = new Set(s.animals.filter(a => a.health > 0).map(a => a.id));
  const targets = new Set(['main', ...cropIds, ...animalIds, ...s.guards.filter(g => g.health > 0).map(g => g.id)]);
  for (const g of s.guards) if (!enemies.has(g.targetId)) g.targetId = null;
  for (const m of s.monsters) if (!targets.has(m.targetId)) m.targetId = null;
  for (const w of s.workers) if (w.job) {
    const valid = ['feed', 'collect'].includes(w.job.kind) ? animalIds.has(w.job.targetId) : s.plots.some(p => p.id === w.job.targetId && p.unlocked);
    if (!valid) w.job = null;
  }
}
