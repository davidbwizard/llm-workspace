export const WORLD = Object.freeze({ width: 640, height: 390 });
export function plotPosition(index) { return { x: 230 + (index % 4) * 43, y: 160 + Math.floor(index / 4) * 43 }; }
export function monsterPosition(monster) {
  // Identity keeps a slime in its lane when another slime is removed.
  const lane = [...monster.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 3;
  return { x: 624 - monster.progress * 195, y: 114 + lane * 8 };
}
export function createFarmer() { return { x: 166, y: 105, facing: 'down', action: 'idle', actionTime: 0 }; }

/** Collision is at the character's feet; crop beds and paths remain walkable. */
export function canStand(x, y) {
  if (x < 0 || x > WORLD.width - 32 || y < 34 || y > WORLD.height - 32) return false;
  const footX = x + 16, footY = y + 27;
  return ![
    { left: 48, top: 24, right: 176, bottom: 120 },
    { left: 27, top: 268, right: 114, bottom: 354 },
  ].some(area => footX > area.left && footX < area.right && footY > area.top && footY < area.bottom);
}
