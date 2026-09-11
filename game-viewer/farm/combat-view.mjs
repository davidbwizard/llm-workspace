import { GUARDS, MONSTER_REWARD } from './definitions.mjs';
import { selectGuardTarget } from './model.mjs';
import { monsterPosition } from './world.mjs';

/** Transient presentation only. Damage, defeat and rewards belong to the model. */
export function createCombatView() {
  const previous = new Map(), positions = new Map(), defeats = new Map(), hits = new Map();
  const previousGuards = new Map(), finishingStrikes = new Map();
  let clock = 0;
  return {
    update(state, elapsed, { paused = false, reducedMotion = false } = {}) {
      const dt = paused || !Number.isFinite(elapsed) ? 0 : Math.max(0, Math.min(2, elapsed));
      clock += dt;
      for (const [id, strike] of finishingStrikes) {
        strike.remaining -= dt;
        if (strike.remaining <= 0) finishingStrikes.delete(id);
      }
      for (const [id, effect] of defeats) {
        effect.age += dt;
        if (effect.age >= effect.duration) defeats.delete(id);
      }
      for (const [id, duration] of hits) {
        if (duration <= dt) hits.delete(id); else hits.set(id, duration - dt);
      }
      const present = new Set(state.monsters.map(monster => monster.id));
      for (const [id, monster] of previous) if (!present.has(id)) {
        defeats.set(id, { id, x: monster.x, y: monster.y, age: 0, duration: 1.4, reward: MONSTER_REWARD });
        previous.delete(id); hits.delete(id);
      }
      const monsters = state.monsters.map(monster => {
        if (previous.has(monster.id) && previous.get(monster.id).health > monster.health) hits.set(monster.id, .18);
        const current = { ...monster, ...monsterPosition(monster), hit: hits.has(monster.id) };
        previous.set(monster.id, current);
        return current;
      });
      const guardIds = new Set(state.guards.map(guard => guard.id));
      for (const id of positions.keys()) if (!guardIds.has(id)) { positions.delete(id); previousGuards.delete(id); finishingStrikes.delete(id); }
      const guards = state.guards.map((guard, i) => {
        const weapon = GUARDS[guard.kind].weapon;
        const liveTarget = selectGuardTarget(guard, state.monsters), prior = previousGuards.get(guard.id);
        const defeatedTarget = prior?.target && defeats.get(prior.target.id);
        // A lethal engine tick can remove the target before a frame sees its hit.
        // Retaliatory damage proves this guard struck it; retain that exact target.
        if (defeatedTarget?.age === 0 && guard.health < prior.health && guard.mode === 'patrol') {
          finishingStrikes.set(guard.id, { target: { ...prior.target, progress: Math.max(.4, prior.target.progress) }, position: { x: defeatedTarget.x, y: defeatedTarget.y }, remaining: .4 });
        }
        previousGuards.set(guard.id, { health: guard.health, target: liveTarget ? { ...liveTarget } : null });
        if (guard.mode !== 'patrol') finishingStrikes.delete(guard.id);
        const finishing = finishingStrikes.get(guard.id);
        const target = finishing?.target ?? liveTarget, targetPosition = finishing?.position ?? (target ? monsterPosition(target) : null);
        const motion = reducedMotion ? 0 : clock;
        const rest = guard.mode === 'home' ? { x: 201 + i * 17, y: 96 } : guard.mode === 'expedition'
          ? { x: 584 + Math.sin(motion + i) * 12, y: 105 + i % 3 * 10 }
          : { x: 401 + Math.sin(motion * .7 + i) * 27, y: 115 + Math.cos(motion * .7 + i) * 14 };
        const destination = targetPosition ? { x: targetPosition.x - (weapon === 'bow' ? 64 : 24), y: targetPosition.y + (i % 3 - 1) * 5 } : rest;
        const position = positions.get(guard.id) ?? { ...rest };
        const dx = destination.x - position.x, dy = destination.y - position.y, distance = Math.hypot(dx, dy);
        const ratio = reducedMotion ? 1 : distance ? Math.min(1, dt * 120 / distance) : 0;
        if (!paused) { position.x += dx * ratio; position.y += dy * ratio; }
        positions.set(guard.id, position);
        return { ...guard, ...position, weapon,
          attacking: Boolean(target && target.progress >= .4 && Math.hypot(destination.x - position.x, destination.y - position.y) < 9),
          targetId: target?.id ?? null, targetX: targetPosition?.x ?? null, targetY: targetPosition?.y ?? null };
      });
      // Copies keep downstream drawing from changing this helper's effect timers.
      return { guards, monsters, defeats: [...defeats.values()].map(effect => ({ ...effect })) };
    },
  };
}
