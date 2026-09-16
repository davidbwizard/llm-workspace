import { GUARDS, MONSTERS } from './definitions.mjs';

/** Transient effects only. Model positions and strike IDs are authoritative. */
export function createCombatView() {
  const previous = new Map(), defeats = new Map(), hits = new Map(), strikes = new Map();
  return {
    update(state, elapsed, { paused = false } = {}) {
      const dt = paused || !Number.isFinite(elapsed) ? 0 : Math.max(0, Math.min(2, elapsed));
      for (const effects of [defeats, strikes]) for (const [id, effect] of effects) {
        effect.age += dt; if (effect.age >= effect.duration) effects.delete(id);
      }
      for (const [id, remaining] of hits) { if (remaining <= dt) hits.delete(id); else hits.set(id, remaining - dt); }
      const present = new Set([...state.guards, ...state.monsters].map(actor => actor.id));
      for (const [id, actor] of previous) if (!present.has(id)) {
        if (actor.enemy) defeats.set(id, { id, kind: actor.kind, x: actor.x, y: actor.y, age: 0, duration: 1.4, reward: MONSTERS[actor.kind].reward });
        previous.delete(id); hits.delete(id); strikes.delete(id);
      }
      const observe = (actor, enemy) => {
        const old = previous.get(actor.id);
        if (old && old.health > actor.health) hits.set(actor.id, .18);
        if (old && actor.strikeId !== old.strikeId && actor.strikeId > 0) {
          strikes.set(actor.id, { age: 0, duration: .35, x: actor.strikeX, y: actor.strikeY, targetId: actor.strikeTargetId });
        }
        previous.set(actor.id, { ...actor, enemy });
        const strike = strikes.get(actor.id);
        return { ...actor, hit: hits.has(actor.id), attacking: Boolean(strike),
          strikeAge: strike?.age ?? 0, strikeDuration: strike?.duration ?? .35,
          targetId: strike?.targetId ?? actor.targetId, targetX: strike?.x ?? actor.strikeX, targetY: strike?.y ?? actor.strikeY,
          ...(enemy ? {} : { weapon: GUARDS[actor.kind].weapon }) };
      };
      return { guards: state.guards.map(g => observe(g, false)), monsters: state.monsters.map(m => observe(m, true)), defeats: [...defeats.values()].map(effect => ({ ...effect })) };
    },
  };
}
