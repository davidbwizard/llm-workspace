// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createScene } from '../farm/scene.mjs';
import { createFarm } from '../farm/model.mjs';
import { ART } from '../farm/art.mjs';

let dispose: (() => void) | undefined;
beforeEach(() => { vi.spyOn(document, 'hidden', 'get').mockReturnValue(false); });
afterEach(() => { dispose?.(); dispose = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

type Mark = { kind: string; args: any[]; color: string };
async function meadow({ missing = false, reduced = false } = {}) {
  const marks: Mark[] = [];
  const ctx: any = { fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', imageSmoothingEnabled: false };
  // This records the actual Canvas drawing boundary, not simulated game behavior.
  for (const kind of ['fillRect', 'fillText', 'beginPath', 'ellipse', 'fill', 'strokeRect', 'setTransform', 'save', 'restore', 'translate', 'scale', 'moveTo', 'lineTo', 'stroke', 'arc', 'closePath']) {
    ctx[kind] = (...args: any[]) => marks.push({ kind, args, color: kind === 'stroke' ? ctx.strokeStyle : ctx.fillStyle });
  }
  ctx.drawImage = (image: { key: string }, ...args: any[]) => marks.push({ kind: 'image', args: [image.key, ...args], color: '' });
  const canvas = document.createElement('canvas');
  vi.spyOn(canvas, 'getContext').mockReturnValue(ctx);
  let callback: FrameRequestCallback | undefined, time = 1000, paused = false;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { callback = cb; return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => { callback = undefined; });
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
  const state = createFarm(); state.workers = [];
  state.guards = [
    { id: 'scout', kind: 'scout', mode: 'patrol', health: 60, maxHealth: 60, progress: 0 },
    { id: 'knight', kind: 'knight', mode: 'patrol', health: 130, maxHealth: 130, progress: 0 },
    { id: 'ranger', kind: 'ranger', mode: 'patrol', health: 80, maxHealth: 80, progress: 0 },
  ];
  const images = missing ? {} : Object.fromEntries(Object.keys(ART).map(key => [key, { key }]));
  dispose = createScene(canvas, { getState: () => state, getSelected: () => 'p1', isPaused: () => paused, onSelect() {}, onAttention() {}, onArtError() {}, assetLoader: async () => images });
  await new Promise(resolve => setTimeout(resolve, 0));
  const frame = (ms = 50) => { time += ms; marks.length = 0; callback!(time); return marks.slice(); };
  const frames = (count: number) => { let result: Mark[] = []; for (let i = 0; i < count; i++) result = frame(); return result; };
  frame();
  return { state, frame, frames, pause(value = true) { paused = value; } };
}
const sprites = (marks: Mark[], key: string) => marks.filter(mark => mark.kind === 'image' && mark.args[0] === key);
const captions = (marks: Mark[]) => marks.filter(mark => mark.kind === 'fillText').map(mark => mark.args[0]);
const monster = () => ({ id: 'slime-1', health: 30, maxHealth: 30, progress: .7 });

it('shows carried swords, a knight shield and a ranger bow before an encounter', async () => {
  const scene = await meadow(); const drawn = scene.frame();
  expect(sprites(drawn, 'sword')).toHaveLength(2); expect(sprites(drawn, 'bow')).toHaveLength(1);
  for (const armed of [...sprites(drawn, 'sword'), ...sprites(drawn, 'bow')]) expect(armed.args.slice(1, 5)).toEqual([0, 64, 32, 32]);
  expect(drawn.filter(mark => mark.kind === 'fillRect' && mark.color === '#91adb8')).toHaveLength(1);
  scene.state.guards.forEach(guard => { guard.mode = 'home'; });
  const atHome = scene.frame(); expect(sprites(atHome, 'sword')).toHaveLength(2); expect(sprites(atHome, 'bow')).toHaveLength(1);
});

it('animates armed attackers and draws a traveling arrow toward an actual slime', async () => {
  const scene = await meadow(); scene.state.monsters = [monster()];
  const drawn = scene.frames(31);
  expect(sprites(drawn, 'sword').some(mark => mark.args[1] > 0)).toBe(true);
  expect(sprites(drawn, 'bow').some(mark => mark.args[1] > 0)).toBe(true);
  expect(drawn.some(mark => mark.kind === 'stroke' && mark.color === '#dfcc8c')).toBe(true);
  expect(drawn.some(mark => mark.kind === 'stroke' && mark.color === '#f1dfad')).toBe(true);
  const before = JSON.stringify(scene.state); scene.frame(); expect(JSON.stringify(scene.state)).toBe(before);
});

it('shows a green hit pose, plays death once, and displays the actual defeat reward', async () => {
  const scene = await meadow(); scene.state.monsters = [monster()]; scene.frame();
  scene.state.monsters[0].health = 22;
  const hit = scene.frame(); expect(sprites(hit, 'slimeDamage')[0]?.args.slice(1, 5)).toEqual([0, 0, 32, 32]);
  expect(sprites(scene.frames(8), 'slimeDamage')).toHaveLength(0);
  scene.state.monsters = []; scene.state.coins += 12;
  const first = scene.frame(); expect(sprites(first, 'slimeDead')[0]?.args.slice(1, 5)).toEqual([0, 0, 32, 32]);
  const sourceColumns: number[] = [];
  let sawReward = captions(first).includes('+12 coins');
  for (let i = 0; i < 26; i++) {
    const drawn = scene.frame(); const death = sprites(drawn, 'slimeDead')[0]; if (death) sourceColumns.push(death.args[1]);
    sawReward ||= captions(drawn).includes('+12 coins');
  }
  expect(sawReward).toBe(true); expect(new Set(sourceColumns).size).toBeGreaterThan(1);
  expect(sourceColumns).toEqual([...sourceColumns].sort((a, b) => a - b)); expect(Math.max(...sourceColumns)).toBe(96);
  const after = scene.frames(8); expect(sprites(after, 'slimeDead')).toHaveLength(0); expect(captions(after)).not.toContain('+12 coins');
});

it('freezes the death frame and reward position while paused', async () => {
  const scene = await meadow(); scene.state.monsters = [monster()]; scene.frame(); scene.state.monsters = []; scene.state.coins += 12; scene.frame();
  const before = scene.frames(9); expect(sprites(before, 'slimeDead')).toHaveLength(1); expect(captions(before)).toContain('+12 coins'); scene.pause(); const paused = scene.frames(50);
  expect(sprites(paused, 'slimeDead')).toEqual(sprites(before, 'slimeDead'));
  expect(paused.filter(mark => mark.kind === 'fillText' && mark.args[0] === '+12 coins')).toEqual(before.filter(mark => mark.kind === 'fillText' && mark.args[0] === '+12 coins'));
  scene.pause(false); expect(sprites(scene.frames(30), 'slimeDead')).toHaveLength(0);
});

it('keeps reduced-motion combat legible without moving projectiles or looping poses', async () => {
  const scene = await meadow({ reduced: true }); scene.state.monsters = [monster()];
  const first = scene.frames(4), next = scene.frames(12);
  expect(sprites(first, 'sword').map(mark => mark.args.slice(1))).toEqual(sprites(next, 'sword').map(mark => mark.args.slice(1)));
  expect(first.filter(mark => mark.kind === 'stroke' && mark.color === '#dfcc8c')).toHaveLength(0);
  scene.state.monsters = []; scene.state.coins += 12;
  expect(captions(scene.frame())).toContain('+12 coins');
  expect(captions(scene.frames(30))).not.toContain('+12 coins');
});

it('still identifies weapons, hits and defeat rewards with unavailable image assets', async () => {
  const scene = await meadow({ missing: true }); scene.state.monsters = [monster()]; scene.frame(); scene.state.monsters[0].health = 22;
  const hit = scene.frame(); expect(captions(hit)).toContain('Sword'); expect(captions(hit)).toContain('Bow');
  expect(hit.some(mark => mark.kind === 'fillRect' && mark.color === '#77b56a')).toBe(true);
  scene.state.monsters = []; scene.state.coins += 12;
  const defeat = scene.frames(10); expect(captions(defeat)).toContain('+12 coins');
  expect(defeat.some(mark => mark.kind === 'fillRect' && mark.color === '#6c9554')).toBe(true);
});


it('draws the main farmer at the model position with walking and sword poses', async () => {
  const scene = await meadow(); scene.state.guards = [];
  Object.assign(scene.state.farmer, { x: 280, y: 240, facing: 'right', action: 'walk', actionTime: 0 });
  const walking = sprites(scene.frame(), 'josh');
  expect(walking).toHaveLength(1); expect(walking[0].args.slice(2, 5)).toEqual([64, 32, 32]);
  expect(walking[0].args.slice(5)).toEqual([280, 240, 32, 32]);
  Object.assign(scene.state.farmer, { action: 'attack', actionTime: .3 });
  const attacking = sprites(scene.frame(), 'sword');
  expect(attacking).toHaveLength(1); expect(attacking[0].args.slice(5)).toEqual([280, 240, 32, 32]);
});

it('does not show a hoe during the cooldown after a sword attack ends', async () => {
  const scene = await meadow(); scene.state.guards = [];
  Object.assign(scene.state.farmer, { action: 'idle', actionTime: 0 }); scene.state.mainCooldown = .25;
  const afterAttack = scene.frame(); expect(sprites(afterAttack, 'hoe')).toHaveLength(0); expect(sprites(afterAttack, 'idle')).toHaveLength(1);
});
