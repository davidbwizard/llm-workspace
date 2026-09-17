import { loadArt, sprite, ART } from './art.mjs';
import { CROPS, MONSTERS } from './definitions.mjs';
import { statsFor } from './balance.mjs';
import { createCombatView } from './combat-view.mjs';

import { WORLD, plotPosition, animalPosition } from './world.mjs';
export { WORLD, plotPosition } from './world.mjs';

export function hitPlot(x, y) {
  for (let i = 0; i < 12; i++) { const p = plotPosition(i); if (x >= p.x && x < p.x + 37 && y >= p.y && y < p.y + 35) return `p${i + 1}`; }
  return null;
}
const fract = value => value - Math.floor(value);
const noise = n => fract(Math.sin(n * 78.233 + 1.2) * 43758.5453);

export function createScene(canvas, { getState, getSelected, isPaused, onSelect, onAttention, onArtError, assetLoader = loadArt }) {
  const ctx = canvas.getContext('2d'); const abort = new AbortController();
  let images = {}, frame = 0, disposed = false, last = 0, clock = 0;
  let combat = createCombatView(), previousState = null, bubbles = [];
  canvas.width = WORLD.width * 2; canvas.height = WORLD.height * 2;
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  Promise.resolve().then(() => disposed ? {} : assetLoader({ signal: abort.signal, onError: onArtError }))
    .then(result => { if (!disposed) images = result; })
    .catch(error => { if (!disposed) onArtError(`Asset loader failed: ${error.message}`); });
  if (!ctx) onArtError('Canvas 2D is unavailable in this browser');
  const rect = (x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y), w, h); };
  const text = (str, x, y, color = '#314c3c', size = 8) => { ctx.fillStyle = color; ctx.font = `600 ${size}px system-ui`; ctx.fillText(str, Math.round(x), Math.round(y)); };
  const shadow = (x, y, w = 18) => { ctx.fillStyle = '#243e3729'; ctx.beginPath(); ctx.ellipse(x, y, w, 5, 0, 0, Math.PI * 2); ctx.fill(); };
  function tree(x, y, variant = 6, scale = 1.5) {
    if (!sprite(ctx, images, 'tree', x, y, variant, 0, scale)) {
      rect(x + 19, y + 43, 7, 23, '#745744'); rect(x + 7, y + 11, 33, 36, '#477348'); rect(x, y + 23, 46, 25, '#517f4b');
    }
  }
  function fence(x, y, w) {
    rect(x, y + 3, w, 4, '#90754d'); rect(x, y + 12, w, 3, '#a6895b');
    for (let i = 0; i <= w; i += 17) { rect(x + i, y, 4, 21, '#725f43'); rect(x + i, y, 3, 17, '#ddc189'); }
  }
  function bar(x, y, value, color, width = 26) { rect(x, y, width, 3, '#283d35'); rect(x, y, Math.round(width * Math.max(0, Math.min(100, value)) / 100), 2, color); }
  function draw(t) {
    if (!ctx || disposed) return;
    const elapsed = last ? Math.min((t - last) / 1000, 0.05) : 0; last = t;
    if (!isPaused() && !document.hidden) clock += elapsed;
    const state = getState();
    if (previousState !== state) { combat = createCombatView(); clock = 0; previousState = state; }
    const motion = reduced?.matches ? 0 : clock;
    ctx.setTransform(2, 0, 0, 2, 0, 0); ctx.imageSmoothingEnabled = false;
    rect(0, 0, 640, 390, '#9fbd75');
    // A dark, layered tree line makes the open meadow feel sheltered.
    rect(0, 0, 640, 44, '#668858');
    for (let i = 0; i < 21; i++) { rect(i * 34 - 12, 13 + noise(i) * 13, 40, 41, '#789a5e'); tree(i * 35 - 10, -37 - noise(i + 9) * 14, 6, 1.7); }
    for (let i = 0; i < 900; i++) {
      const x = Math.floor(noise(i + 31) * 640), y = 64 + Math.floor(noise(i + 2001) * 326);
      rect(x, y, i % 7 ? 2 : 4, 1, i % 3 ? '#91ae68' : '#b4cc85');
      if (i % 11 === 0) rect(x + 2, y - 2, 1, 3, '#83a365');
    }
    // Paths have a stone edge and a quiet, irregular gravel texture.
    rect(137, 103, 45, 289, '#b6aa7b'); rect(142, 104, 35, 286, '#d5c593');
    rect(143, 119, 495, 30, '#b6aa7b'); rect(143, 123, 497, 22, '#d5c593');
    rect(172, 283, 307, 22, '#cbbd8b');
    for (let i = 0; i < 75; i++) { const x = 150 + noise(i + 74) * 483; rect(x, 126 + noise(i + 83) * 16, 2, 1, '#bcae7e'); }
    // Pond and reeds, away from the cultivated field.
    rect(20, 274, 100, 74, '#8ca46a'); rect(27, 268, 87, 85, '#728f68');
    rect(29, 274, 84, 72, '#77a6a1'); rect(38, 268, 65, 86, '#77a6a1'); rect(38, 282, 66, 57, '#84b6ac');
    for (let i = 0; i < 8; i++) { const x = 39 + noise(i + 61) * 55; rect(x, 285 + i * 7, 8 + (i % 3) * 3, 1, '#accdc0'); }
    for (let i = 0; i < 9; i++) { const x = 18 + noise(i + 29) * 106; rect(x, 341 + noise(i) * 10, 2, 12, '#587e55'); rect(x - 1, 338 + noise(i) * 10, 3, 5, '#a58c4c'); }
    // The full summer house is a single verified sprite.
    shadow(108, 119, 58);
    if (!sprite(ctx, images, 'house', 48, 24)) { rect(48, 62, 128, 55, '#d0b786'); rect(39, 34, 142, 35, '#865b44'); rect(99, 80, 22, 37, '#574e3a'); }
    tree(8, 62, 3, 1.5); tree(176, 37, 6, 1.5); tree(541, 47, 3, 1.6);
    // Kitchen garden: every visible bed maps to its own simulation plot.
    state.plots.forEach((plot, i) => {
      const { x, y } = plotPosition(i);
      rect(x - 1, y + 2, 39, 35, '#83955c');
      if (!plot.unlocked) {
        rect(x, y, 37, 33, '#8ba16b');
        for (let r = 0; r < 3; r++) { rect(x + 6 + r * 10, y + 7, 2, 10, '#668650'); rect(x + 3 + r * 10, y + 11, 8, 2, '#668650'); }
        rect(x + 3, y + 19, 31, 10, '#516744'); text('Locked', x + 6, y + 27, '#ede5c1', 7);
        if (getSelected() === plot.id) { ctx.strokeStyle = '#fff1bd'; ctx.lineWidth = 2; ctx.strokeRect(x - 3, y - 3, 43, 39); }
        text(String(i + 1), x + 2, y + 9, '#f2dfb3', 6);
        return;
      }
      const soil = plot.stage === 'empty' ? '#ac9c70' : plot.water > 45 ? '#735643' : '#98704d';
      rect(x, y, 37, 33, soil);
      for (let r = 0; r < 3; r++) rect(x + 3, y + 6 + r * 9, 31, 2, plot.water > 45 ? '#604b3e' : '#856447');
      if (['growing', 'ready'].includes(plot.stage)) {
        const key = plot.crop, stages = ART[key]?.stages ?? [0, 1, 2, 3, 4];
        const ratio = plot.growth / (CROPS[key]?.growTime ?? 75);
        const column = plot.stage === 'ready' ? stages.at(-1) : stages[Math.min(stages.length - 2, Math.floor(ratio * (stages.length - 1)))];
        for (const [dx, dy] of [[2, 0], [18, 1], [1, 15], [18, 15]]) {
          if (!sprite(ctx, images, key, x + dx, y + dy, column)) { rect(x + dx + 6, y + dy + 4, 3, 8, '#527d43'); rect(x + dx + 3, y + dy + 5, 9, 3, '#669847'); }
        }
      }
      if (plot.stage === 'dead') { text('×', x + 13, y + 22, '#d4bf89', 20); }
      if (plot.weeds > 25) { rect(x + 27, y + 23, 2, 7, '#638442'); rect(x + 24, y + 25, 8, 2, '#638442'); }
      if (plot.stage === 'ready') { rect(x + 29, y - 5, 6, 6, '#ffe29a'); }
      if (getSelected() === plot.id) { ctx.strokeStyle = '#fff1bd'; ctx.lineWidth = 2; ctx.strokeRect(x - 3, y - 3, 43, 39); }
      text(String(i + 1), x + 2, y + 9, '#f2dfb3', 6);
    });
    // Livestock pen, trough and hay.
    rect(460, 166, 142, 110, '#a9bc75'); fence(454, 158, 153);
    for (let y = 181; y < 268; y += 20) { fence(454, y, 3); fence(607, y, 3); }
    rect(567, 177, 26, 12, '#887451'); rect(569, 179, 22, 7, '#80b4b0'); rect(578, 244, 22, 16, '#d7bd68'); rect(582, 244, 3, 16, '#b69551');
    state.animals.forEach((animal, i) => {
      const { x, y } = animalPosition(i);
      shadow(x + 16, y + 26, 13); sprite(ctx, images, animal.kind, x, y, Math.floor(motion * 2 + i) % 4, 0);
      if (animal.produce) { rect(x + 22, y + 2, 5, 5, '#fff1bd'); }
      if (animal.hunger < 35 || animal.health < 60) bar(x + 3, y + 31, animal.health, '#e3a384');
    });
    fence(454, 274, 153);
    text('Pasture', 459, 302, '#587449'); text('Kitchen garden', 230, 317, '#587449');
    // The home farmer stays available even without sessions.
    const farmer = state.farmer;
    const mainKey = farmer.action === 'attack' && farmer.actionTime > 0 ? 'sword'
      : farmer.action === 'walk' ? 'josh' : farmer.action === 'harvest' && farmer.actionTime > 0 ? 'hoe' : 'idle';
    const mainRow = farmer.facing === 'up' ? 1 : ['left', 'right'].includes(farmer.facing) ? 2 : 0;
    shadow(farmer.x + 16, farmer.y + 27, 10);
    ctx.save();
    if (farmer.facing === 'left') { ctx.translate(Math.round(farmer.x + 32), 0); ctx.scale(-1, 1); }
    const mainDrawn = sprite(ctx, images, mainKey, farmer.facing === 'left' ? 0 : farmer.x, farmer.y, Math.floor(motion * 10) % ART[mainKey].frames, mainRow);
    ctx.restore();
    if (!mainDrawn) {
      rect(farmer.x + 12, farmer.y + 8, 8, 8, '#cba879'); rect(farmer.x + 11, farmer.y + 16, 10, 10, '#59748b');
      if (mainKey === 'sword') { rect(farmer.x + 23, farmer.y + 16, 13, 2, '#dbe4de'); rect(farmer.x + 25, farmer.y + 14, 2, 6, '#bc995a'); }
    }
    text('You', farmer.x + 9, farmer.y - 1);
    const mainMax = statsFor(state, 'farmer', 'main').maxHealth;
    if (state.mainHealth < mainMax) bar(farmer.x + 3, farmer.y + 31, state.mainHealth / mainMax * 100, '#e6b094');
    bubbles = [];
    // Positions are the model's own; this only picks a pose from them, never moves a helper.
    state.workers.forEach(worker => {
      const { x, y } = worker, moving = worker.moving && !isPaused();
      const key = moving ? 'josh' : worker.activity === 'working' && worker.job
        ? worker.job.kind === 'water' ? 'watering' : worker.job.kind === 'plant' ? 'throwing' : 'hoe' : 'idle';
      const row = worker.facing === 'up' ? 1 : ['left', 'right'].includes(worker.facing) ? 2 : 0;
      const left = worker.facing === 'left';
      shadow(x + 16, y + 27, 10);
      ctx.save();
      if (left) { ctx.translate(Math.round(x + 32), 0); ctx.scale(-1, 1); }
      sprite(ctx, images, key, left ? 0 : x, y, Math.floor(motion * 6) % ART[key].frames, row);
      ctx.restore();
      text(worker.name.slice(0, 12), x, y + 39, '#344c37', 7);
      if (worker.job && !moving) bar(x + 3, y + 31, worker.job.progress / worker.job.duration * 100, '#eedda2');
      if (worker.attention) {
        const bx = x + 9, by = y - 11;
        rect(bx, by, 25, 18, '#fff4cc'); rect(bx + 3, by + 17, 4, 4, '#fff4cc'); text('?', bx + 9, by + 13, '#6b593b', 13);
        bubbles.push({ x: bx, y: by, id: worker.id });
      }
    });
    const battle = combat.update(state, elapsed, { paused: isPaused(), reducedMotion: reduced?.matches });
    battle.guards.forEach(guard => {
      const { x, y, weapon, attacking } = guard;
      const phase = Math.min(.999, guard.strikeAge / guard.strikeDuration || 0);
      const column = attacking ? reduced?.matches ? 4 : Math.floor(phase * ART[weapon].frames) : 0;
      const left = guard.facing === 'left', row = guard.facing === 'up' ? 1 : ['left', 'right'].includes(guard.facing) ? 2 : 0;
      shadow(x + 16, y + 27, 10);
      ctx.save();
      if (left) { ctx.translate(Math.round(x + 32), 0); ctx.scale(-1, 1); }
      const drawn = sprite(ctx, images, weapon, left ? 0 : x, y, column, row);
      ctx.restore();
      if (!drawn) {
        if (!sprite(ctx, images, 'josh', x, y, 0, 2)) {
          rect(x + 12, y + 8, 8, 8, '#cba879'); rect(x + 11, y + 16, 10, 10, '#527c74');
        }
        if (weapon === 'sword') {
          rect(x + 23, y + 16, 13, 2, '#dbe4de'); rect(x + 25, y + 14, 2, 6, '#bc995a');
        } else {
          ctx.strokeStyle = '#b28e59'; ctx.lineWidth = 2; ctx.beginPath();
          ctx.moveTo(x + 25, y + 10); ctx.lineTo(x + 29, y + 17); ctx.lineTo(x + 25, y + 24); ctx.stroke();
          rect(x + 24, y + 11, 1, 13, '#d8d5ab');
        }
        text(weapon === 'bow' ? 'Bow' : 'Sword', x + 1, y - 2, '#40563c', 7);
      }
      if (guard.kind === 'knight') {
        rect(x + 7, y + 17, 7, 9, '#91adb8'); rect(x + 10, y + 17, 1, 9, '#e7ead0');
      }
      text(`${guard.post[0].toUpperCase() + guard.post.slice(1)} · ${guard.level}`, x - 1, y - 3, '#40563c', 6);
      if (guard.hit) { rect(x + 2, y + 12, 3, 3, '#f4dbb3'); rect(x + 28, y + 10, 3, 3, '#f4dbb3'); }
      bar(x + 3, y + 31, guard.health / guard.maxHealth * 100, '#99c5bb');
      if (attacking && !reduced?.matches) {
        if (weapon === 'bow') {
          const originX = x + 23, originY = y + 17;
          const dx = guard.targetX + 16 - originX, dy = guard.targetY + 18 - originY;
          const length = Math.hypot(dx, dy) || 1, ux = dx / length, uy = dy / length;
          const arrowX = originX + dx * phase, arrowY = originY + dy * phase;
          ctx.strokeStyle = '#dfcc8c'; ctx.lineWidth = 2; ctx.beginPath();
          ctx.moveTo(arrowX - ux * 9, arrowY - uy * 9); ctx.lineTo(arrowX, arrowY);
          ctx.moveTo(arrowX - ux * 4 - uy * 3, arrowY - uy * 4 + ux * 3); ctx.lineTo(arrowX, arrowY);
          ctx.lineTo(arrowX - ux * 4 + uy * 3, arrowY - uy * 4 - ux * 3); ctx.stroke();
        } else {
          const centerX = x + (left ? 7 : 25), centerY = y + 17;
          ctx.strokeStyle = '#f1dfad'; ctx.lineWidth = 2; ctx.beginPath();
          const angle = (left ? Math.PI : 0) - 1.1 + phase * .7;
          ctx.arc(centerX, centerY, 17, angle, angle + 1.45); ctx.stroke();
        }
      }
    });
    battle.monsters.forEach(monster => {
      const { x, y, hit, attacking } = monster, kind = monster.kind;
      const phase = Math.min(.999, monster.strikeAge / monster.strikeDuration || 0);
      const attackKey = `${kind}Attack`;
      // First damage cells keep each enemy's colors; later cells flash white.
      const key = hit ? `${kind}Damage` : attacking && ART[attackKey] ? attackKey : kind;
      const column = hit ? 0 : attacking && ART[attackKey] ? reduced?.matches ? 2 : Math.floor(phase * ART[key].frames) : Math.floor(motion * 5) % ART[key].frames;
      const row = monster.facing === 'up' ? 1 : ['left', 'right'].includes(monster.facing) ? 2 : 0;
      const left = monster.facing === 'left';
      shadow(x + 16, y + 27, 10);
      ctx.save(); if (left) { ctx.translate(Math.round(x + 32), 0); ctx.scale(-1, 1); }
      const drawn = sprite(ctx, images, key, left ? 0 : x, y, column, row);
      ctx.restore();
      if (!drawn) {
        const colors = { slime: '#598f55', raider: '#8b9844', spitter: '#a178a4', brute: '#585b60' };
        const color = hit ? '#77b56a' : colors[kind];
        rect(x + 7, y + 14, 19, 10, color); rect(x + 11, y + 11, 11, 4, color);
        rect(x + 12, y + 17, 2, 2, '#243e35'); rect(x + 20, y + 17, 2, 2, '#243e35');
      }
      if (kind !== 'slime') text(MONSTERS[kind].name, x - 7, y - 3, '#543e46', 6);
      if (hit) { rect(x + 2, y + 13, 3, 2, '#d9cd91'); rect(x + 28, y + 10, 2, 3, '#d9cd91'); }
      if (attacking && !reduced?.matches) {
        if (kind === 'spitter') {
          const sx = x + 16, sy = y + 16;
          rect(sx + (monster.targetX + 16 - sx) * phase, sy + (monster.targetY + 16 - sy) * phase, 5, 5, '#c6a6d9');
        } else {
          const angle = Math.atan2(monster.targetY - y, monster.targetX - x);
          ctx.strokeStyle = '#dbb187'; ctx.lineWidth = 2; ctx.beginPath();
          ctx.arc(x + 16, y + 18, 20, angle - .65, angle + .65); ctx.stroke();
        }
      }
      bar(x + 3, y + 28, monster.health / monster.maxHealth * 100, '#e4a190');
    });
    battle.defeats.forEach(defeat => {
      const key = `${defeat.kind}Dead`, frames = ART[key].frames;
      // Play the matching death once, holding its final cell until removal.
      const column = reduced?.matches ? frames - 1 : Math.min(frames - 1, Math.floor(defeat.age / .12));
      if (!sprite(ctx, images, key, defeat.x, defeat.y, column)) {
        const height = reduced?.matches ? 3 : Math.max(2, 9 - column * 2);
        const colors = { slime: '#6c9554', raider: '#8b9844', spitter: '#a178a4', brute: '#585b60' };
        rect(defeat.x + 5, defeat.y + 25 - height, 23, height, colors[defeat.kind]);
      }
      if (defeat.age >= .25 || reduced?.matches) {
        const rise = reduced?.matches ? 0 : Math.min(12, defeat.age * 9);
        rect(defeat.x - 8, defeat.y - 9 - rise, 62, 15, '#344b38');
        text(`+${defeat.reward} coins`, defeat.x - 3, defeat.y + 2 - rise, '#f5e3a1', 8);
      }
    });
    // Foreground orchard frames the open lane into the farm.
    tree(-7, 172, 6, 1.5); tree(605, 201, 6, 1.7); tree(198, 318, 3, 1.4); tree(560, 316, 6, 1.6); tree(16, 344, 6, 1.7);
    for (let i = 0; i < 24; i++) { const x = 270 + noise(i + 5) * 270, y = 333 + noise(i + 90) * 48; rect(x, y, 2, 4, '#61834b'); rect(x - 1, y, 4, 2, i % 3 ? '#eee6ae' : '#e3b9a5'); }
    if (isPaused()) { rect(238, 15, 164, 22, '#314c3cd9'); text(state.connected ? 'The meadow is paused' : 'Waiting for session connection', 250, 30, '#eef0d9', 9); }
  }
  function animate(t) { if (disposed) return; if (!document.hidden) draw(t); else last = 0; frame = requestAnimationFrame(animate); }
  if (ctx) frame = requestAnimationFrame(animate);
  const click = event => {
    canvas.focus({ preventScroll: true });
    const bounds = canvas.getBoundingClientRect(); if (!bounds.width || !bounds.height) return;
    const x = (event.clientX - bounds.left) / bounds.width * WORLD.width, y = (event.clientY - bounds.top) / bounds.height * WORLD.height;
    const bubble = bubbles.find(b => x >= b.x && x <= b.x + 25 && y >= b.y && y <= b.y + 22);
    if (bubble) onAttention(bubble.id); else { const plot = hitPlot(x, y); if (plot) onSelect(plot); }
  };
  canvas.addEventListener('click', click);
  return () => { disposed = true; abort.abort(); cancelAnimationFrame(frame); canvas.removeEventListener('click', click); images = {}; bubbles = []; };
}
