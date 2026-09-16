import { MONSTERS } from './definitions.mjs';
export const WORLD = Object.freeze({ width: 640, height: 390 });
// Right now one pen. Set the position on the canvas
export const PEN = Object.freeze({ left: 462, top: 168, right: 570, bottom: 244 });
export function plotPosition(index) { return { x: 230 + (index % 4) * 43, y: 160 + Math.floor(index / 4) * 43 }; }
export function monsterPosition(monster) {
  if (Number.isFinite(monster.x) && Number.isFinite(monster.y)) return { x: monster.x, y: monster.y };
  // Identity keeps a slime in its lane when another slime is removed.
  const lane = [...monster.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 3;
  return { x: 624 - monster.progress * 195, y: 114 + lane * 8 };
}
export function animalPosition(index) { return { x: 471 + (index % 4) * 29, y: 181 + Math.floor(index / 4) * 24 }; }
export const PATROLS = Object.freeze({
  farm: [{ x: 190, y: 135 }, { x: 420, y: 135 }, { x: 420, y: 290 }, { x: 190, y: 290 }],
  garden: [{ x: 210, y: 135 }, { x: 404, y: 135 }, { x: 404, y: 285 }, { x: 210, y: 285 }],
  pasture: [{ x: 440, y: 150 }, { x: 590, y: 150 }, { x: 590, y: 285 }, { x: 440, y: 285 }],
});
export function guardHome(index) { return { x: 185 + (index % 6) * 24, y: 96 + Math.floor(index / 6) * 30 }; }
export function spatialFields(x, y) { return { x, y, facing: 'down', cooldown: 0, targetId: null, strikeId: 0, strikeX: x, strikeY: y, strikeTargetId: null }; }
export const radius = actor => MONSTERS[actor.kind]?.radius ?? 10;
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const inReach = (a, b, reach) => distance(a, b) <= radius(a) + radius(b) + reach + 1e-6;
export function face(actor, target) {
  const dx = target.x - actor.x, dy = target.y - actor.y;
  actor.facing = Math.abs(dx) > Math.abs(dy) ? dx >= 0 ? 'right' : 'left' : dy >= 0 ? 'down' : 'up';
}
export function moveActor(actor, target, speed, seconds, stop = 0) {
  if (!clearPath(actor, target)) { target = navigationPoint(actor, target); stop = 0; }
  const gap = distance(actor, target); if (gap <= stop || !gap) return false;
  face(actor, target);
  const travel = Math.min(gap - stop, speed * seconds), dx = (target.x - actor.x) / gap, dy = (target.y - actor.y) / gap;
  const count = Math.max(1, Math.ceil(travel / 4)), ox = actor.x, oy = actor.y;
  for (let i = 0; i < count; i++) {
    const x = Math.max(0, Math.min(608, actor.x + dx * travel / count)), y = Math.max(34, Math.min(358, actor.y + dy * travel / count));
    if (canStand(x, actor.y)) actor.x = x;
    if (canStand(actor.x, y)) actor.y = y;
  }
  return actor.x !== ox || actor.y !== oy;
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

// Expanded to the actor's foot origin, matching canStand exactly.
const OBSTACLES = [{ left: 32, right: 160, top: -3, bottom: 93 }, { left: 11, right: 98, top: 241, bottom: 327 }];
export function clearPath(a, b) {
  for (const box of OBSTACLES) {
    let enter = 0, leave = 1;
    for (const [axis, low, high] of [['x',box.left,box.right],['y',box.top,box.bottom]]) {
      const delta = b[axis]-a[axis];
      if (Math.abs(delta) < 1e-9) { if (a[axis] <= low || a[axis] >= high) { enter=2; break; } }
      else {
        const first=(low+1e-6-a[axis])/delta, second=(high-1e-6-a[axis])/delta;
        enter=Math.max(enter,Math.min(first,second)); leave=Math.min(leave,Math.max(first,second));
      }
    }
    if (enter <= leave) return false;
  }
  return true;
}
const CORNERS = [{x:30,y:95},{x:162,y:95},{x:9,y:239},{x:100,y:239},{x:100,y:329},{x:9,y:329}];
const ROUTES = CORNERS.map((a,i)=>CORNERS.flatMap((b,j)=>i!==j&&clearPath(a,b)?[{to:j,cost:distance(a,b)}]:[]));
function navigationPoint(origin, target) {
  // Six static corners plus start/end: bounded shortest-path search, no grid scans.
  const points=[...CORNERS,target,origin], end=CORNERS.length, start=end+1;
  const costs=points.map(()=>Infinity), parents=points.map(()=>-1), visited=new Set(); costs[start]=0;
  for (let n=0;n<points.length;n++) {
    let current=-1;
    for (let i=0;i<points.length;i++) if(!visited.has(i)&&(current<0||costs[i]<costs[current])) current=i;
    if(current<0||!Number.isFinite(costs[current])||current===end) break;
    visited.add(current);
    const edges=current===start?CORNERS.flatMap((p,i)=>clearPath(origin,p)?[{to:i,cost:distance(origin,p)}]:[]):ROUTES[current];
    const candidates=clearPath(points[current],target)?[...edges,{to:end,cost:distance(points[current],target)}]:edges;
    for(const edge of candidates) if(costs[current]+edge.cost<costs[edge.to]) { costs[edge.to]=costs[current]+edge.cost; parents[edge.to]=current; }
  }
  if(parents[end]<0) return origin;
  let next=end; while(parents[next]!==start) next=parents[next];
  return points[next];
}

export function wanderPoint(seed) {
  const pick = n => Math.abs(Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453) % 1;
  return { x: PEN.left + pick(1) * (PEN.right - PEN.left),
            y: PEN.top  + pick(2) * (PEN.bottom - PEN.top) };
}

export function animalSpot(animals, animal) {
  return Number.isFinite(animal.x) ? { x: animal.x, y: animal.y }
                                    : animalPosition(animals.indexOf(animal));
}