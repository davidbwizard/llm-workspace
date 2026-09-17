// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createScene } from '../farm/scene.mjs';
import { createFarm } from '../farm/model.mjs';
import { spatialFields } from '../farm/world.mjs';
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
  let state = createFarm(); state.workers = [];
  state.guards = [
    { ...state.guards[0], ...spatialFields(390, 145), facing: 'right', id: 'scout', kind: 'scout', mode: 'patrol', health: 60, maxHealth: 60, progress: 0 },
    { ...state.guards[0], ...spatialFields(400, 160), facing: 'right', id: 'knight', kind: 'knight', mode: 'patrol', health: 130, maxHealth: 130, progress: 0 },
    { ...state.guards[0], ...spatialFields(350, 150), facing: 'right', id: 'ranger', kind: 'ranger', mode: 'patrol', health: 80, maxHealth: 80, progress: 0 },
  ];
  const images = missing ? {} : Object.fromEntries(Object.keys(ART).map(key => [key, { key }]));
  dispose = createScene(canvas, { getState: () => state, getSelected: () => 'p1', isPaused: () => paused, onSelect() {}, onAttention() {}, onArtError() {}, assetLoader: async () => images });
  await new Promise(resolve => setTimeout(resolve, 0));
  const frame = (ms = 50) => { time += ms; marks.length = 0; callback!(time); return marks.slice(); };
  const frames = (count: number) => { let result: Mark[] = []; for (let i = 0; i < count; i++) result = frame(); return result; };
  frame();
  return { state, frame, frames, replaceState(next) { state = next; }, pause(value = true) { paused = value; } };
}
const sprites = (marks: Mark[], key: string) => marks.filter(mark => mark.kind === 'image' && mark.args[0] === key);
const captions = (marks: Mark[]) => marks.filter(mark => mark.kind === 'fillText').map(mark => mark.args[0]);
const monster = () => ({ ...spatialFields(430, 150), kind: 'slime', id: 'slime-1', health: 22, maxHealth: 22, spawn: 'east' });

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
  scene.state.guards.forEach(guard => { guard.strikeId++; guard.strikeX = 430; guard.strikeY = 150; guard.strikeTargetId = 'slime-1'; });
  const drawn = scene.frames(3);
  expect(sprites(drawn, 'sword').some(mark => mark.args[1] > 0)).toBe(true);
  expect(sprites(drawn, 'bow').some(mark => mark.args[1] > 0)).toBe(true);
  expect(drawn.some(mark => mark.kind === 'stroke' && mark.color === '#dfcc8c')).toBe(true);
  expect(drawn.some(mark => mark.kind === 'stroke' && mark.color === '#f1dfad')).toBe(true);
  const before = JSON.stringify(scene.state); scene.frame(); expect(JSON.stringify(scene.state)).toBe(before);
});

it('shows a green hit pose, plays death once, and displays the actual defeat reward', async () => {
  const scene = await meadow(); scene.state.monsters = [monster()]; scene.frame();
  scene.state.monsters[0].health = 14;
  const hit = scene.frame(); expect(sprites(hit, 'slimeDamage')[0]?.args.slice(1, 5)).toEqual([0, 0, 32, 32]);
  expect(sprites(scene.frames(8), 'slimeDamage')).toHaveLength(0);
  scene.state.monsters = []; scene.state.coins += 2;
  const first = scene.frame(); expect(sprites(first, 'slimeDead')[0]?.args.slice(1, 5)).toEqual([0, 0, 32, 32]);
  const sourceColumns: number[] = [];
  let sawReward = captions(first).includes('+2 coins');
  for (let i = 0; i < 26; i++) {
    const drawn = scene.frame(); const death = sprites(drawn, 'slimeDead')[0]; if (death) sourceColumns.push(death.args[1]);
    sawReward ||= captions(drawn).includes('+2 coins');
  }
  expect(sawReward).toBe(true); expect(new Set(sourceColumns).size).toBeGreaterThan(1);
  expect(sourceColumns).toEqual([...sourceColumns].sort((a, b) => a - b)); expect(Math.max(...sourceColumns)).toBe(96);
  const after = scene.frames(8); expect(sprites(after, 'slimeDead')).toHaveLength(0); expect(captions(after)).not.toContain('+2 coins');
});

it('freezes the death frame and reward position while paused', async () => {
  const scene = await meadow(); scene.state.monsters = [monster()]; scene.frame(); scene.state.monsters = []; scene.state.coins += 2; scene.frame();
  const before = scene.frames(9); expect(sprites(before, 'slimeDead')).toHaveLength(1); expect(captions(before)).toContain('+2 coins'); scene.pause(); const paused = scene.frames(50);
  expect(sprites(paused, 'slimeDead')).toEqual(sprites(before, 'slimeDead'));
  expect(paused.filter(mark => mark.kind === 'fillText' && mark.args[0] === '+2 coins')).toEqual(before.filter(mark => mark.kind === 'fillText' && mark.args[0] === '+2 coins'));
  scene.pause(false); expect(sprites(scene.frames(30), 'slimeDead')).toHaveLength(0);
});

it('keeps reduced-motion combat legible without moving projectiles or looping poses', async () => {
  const scene = await meadow({ reduced: true }); scene.state.monsters = [monster()];
  scene.state.guards.forEach(guard => { guard.strikeId++; guard.strikeX = 430; guard.strikeY = 150; guard.strikeTargetId = 'slime-1'; });
  const first = scene.frames(3), next = scene.frames(2);
  expect(sprites(first, 'sword').map(mark => mark.args.slice(1))).toEqual(sprites(next, 'sword').map(mark => mark.args.slice(1)));
  expect(first.filter(mark => mark.kind === 'stroke' && mark.color === '#dfcc8c')).toHaveLength(0);
  scene.state.monsters = []; scene.state.coins += 2;
  expect(captions(scene.frame())).toContain('+2 coins');
  expect(captions(scene.frames(30))).not.toContain('+2 coins');
});

it('still identifies weapons, hits and defeat rewards with unavailable image assets', async () => {
  const scene = await meadow({ missing: true }); scene.state.monsters = [monster()]; scene.frame(); scene.state.monsters[0].health = 14;
  const hit = scene.frame(); expect(captions(hit)).toContain('Sword'); expect(captions(hit)).toContain('Bow');
  expect(hit.some(mark => mark.kind === 'fillRect' && mark.color === '#77b56a')).toBe(true);
  scene.state.monsters = []; scene.state.coins += 2;
  const defeat = scene.frames(10); expect(captions(defeat)).toContain('+2 coins');
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

it('draws different enemies at exact model coordinates without visual travel', async () => {
  const scene = await meadow(); scene.state.guards = [];
  scene.state.monsters = ['slime', 'raider', 'spitter', 'brute'].map((kind, index) => ({ ...monster(), id: kind, kind, x: 270 + index * 40, y: 230, facing: 'right', strikeId: 0 }));
  const first = scene.frame();
  for (const [index, kind] of ['slime', 'raider', 'spitter', 'brute'].entries()) {
    expect(sprites(first, kind)[0]?.args.slice(5)).toEqual([270 + index * 40, 230, 32, 32]);
  }
  const after = scene.frames(20);
  for (const [index, kind] of ['slime', 'raider', 'spitter', 'brute'].entries()) expect(sprites(after, kind)[0]?.args.slice(5)).toEqual([270 + index * 40, 230, 32, 32]);
});

it('marks unclaimed plots and draws livestock at the shared interaction coordinates', async () => {
  const { animalPosition } = await import('../farm/world.mjs');
  const scene = await meadow(); const drawn = scene.frame();
  expect(captions(drawn).filter(text => text === 'Locked')).toHaveLength(9);
  for (const [index, animal] of scene.state.animals.entries()) {
    const { x, y } = animalPosition(index);
    expect(sprites(drawn, animal.kind)[0]?.args.slice(5)).toEqual([x, y, 32, 32]);
  }
});


it('clears combat effects when a new farm replaces the current state', async () => {
  const scene = await meadow(); scene.state.monsters = [monster()]; scene.frame();
  scene.replaceState(createFarm());
  const next = scene.frames(8);
  expect(sprites(next, 'slimeDead')).toHaveLength(0);
  expect(captions(next).some(text => String(text).includes('coins'))).toBe(false);
});

it('keeps protector rendering on model coordinates through movement and facing changes', async () => {
  const scene = await meadow();
  const drawn = scene.frame();
  expect(sprites(drawn, 'sword').map(mark => mark.args.slice(5, 7))).toEqual([[390, 145], [400, 160]]);
  expect(sprites(drawn, 'bow')[0].args.slice(5, 7)).toEqual([350, 150]);
  Object.assign(scene.state.guards[0], { x: 310, y: 220, facing: 'up' });
  const moved = scene.frames(10);
  expect(sprites(moved, 'sword')[0].args.slice(1, 7)).toEqual([0, 32, 32, 32, 310, 220]);
});

it('renders a working farmer straight from its model position and job, never a local walk animation', async () => {
  const scene = await meadow(); scene.state.guards = [];
  scene.state.workers = [{ id: 'w1', name: 'Rowan', provider: 'demo', activity: 'working', attention: null,
    assignment: 'auto', action: 'Hoeing', job: { targetId: 'p1', kind: 'till', progress: 1, duration: 2 },
    x: 300, y: 220, facing: 'down', moving: false }];
  const still = scene.frame();
  expect(sprites(still, 'hoe')[0]?.args.slice(5, 7)).toEqual([300, 220]);
  expect(sprites(still, 'josh')).toHaveLength(0);
  // The model jumped the worker to a new spot and marked it walking: the renderer
  // must reflect that instantly, with no interpolation of its own.
  Object.assign(scene.state.workers[0], { x: 150, y: 90, moving: true });
  const walking = scene.frame();
  expect(sprites(walking, 'josh')[0]?.args.slice(5, 7)).toEqual([150, 90]);
  // Planting (seeding) uses the throwing-items pose instead of the hoe.
  Object.assign(scene.state.workers[0], { moving: false, job: { targetId: 'p1', kind: 'plant', progress: 0, duration: 2 } });
  expect(sprites(scene.frame(), 'throwing')).toHaveLength(1);
});

it('uses matching colored hit/death sprites and rewards for every enemy kind', async () => {
  const scene = await meadow(); scene.state.guards = [];
  const kinds = ['slime', 'raider', 'spitter', 'brute'];
  scene.state.monsters = kinds.map((kind, index) => ({ ...monster(), id: kind, kind, x: 250 + index * 50, y: 250 }));
  scene.frame(); scene.state.monsters.forEach(enemy => { enemy.health -= 1; });
  const hit = scene.frame();
  for (const kind of kinds) expect(sprites(hit, `${kind}Damage`)[0]?.args.slice(1, 5)).toEqual([0, 0, 32, 32]);
  scene.state.monsters = []; const first = scene.frame();
  for (const [index, kind] of kinds.entries()) expect(sprites(first, `${kind}Dead`)[0]?.args.slice(5, 7)).toEqual([250 + index * 50, 250]);
  const after = scene.frames(15);
  expect(sprites(after, 'spitterDead')[0]?.args[1]).toBe(160);
  for (const reward of [2, 3, 4, 6]) expect(captions(after)).toContain(`+${reward} coins`);
});
