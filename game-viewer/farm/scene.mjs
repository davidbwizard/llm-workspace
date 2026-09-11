import { loadArt, sprite, ART } from './art.mjs';
import { CROPS } from './definitions.mjs';
import { createCombatView } from './combat-view.mjs';

import { WORLD, plotPosition } from './world.mjs';
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
  const positions = new Map(); const combat = createCombatView(); let bubbles = [];
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
    const state = getState(); const motion = reduced?.matches ? 0 : clock;
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
      const x = 471 + (i % 4) * 29 + Math.sin(motion * .4 + i) * 3, y = 181 + Math.floor(i / 4) * 24;
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
    if (state.mainHealth < 100) bar(farmer.x + 3, farmer.y + 31, state.mainHealth, '#e6b094');
    bubbles = [];
    const ids = new Set(state.workers.map(w => w.id)); for (const id of positions.keys()) if (!ids.has(id)) positions.delete(id);
    state.workers.forEach((worker, i) => {
      let destination = { x: 61 + (i % 6) * 25, y: 154 + Math.floor(i / 6) * 28 };
      if (worker.activity === 'working' && worker.job) {
        const pi = state.plots.findIndex(p => p.id === worker.job.targetId);
        destination = pi >= 0 ? { x: plotPosition(pi).x - 9, y: plotPosition(pi).y + 12 } : { x: 453 + (i % 4) * 26, y: 220 };
      }
      const position = positions.get(worker.id) ?? { x: 145, y: 126 }; positions.set(worker.id, position);
      const dx = destination.x - position.x, dy = destination.y - position.y, distance = Math.hypot(dx, dy);
      if (!isPaused() && distance > 1) { const step = Math.min(distance, elapsed * 63); position.x += dx / distance * step; position.y += dy / distance * step; }
      const moving = distance > 3 && !isPaused();
      let key = moving ? 'josh' : worker.activity === 'working' && worker.job ? worker.job.kind === 'water' ? 'watering' : 'hoe' : 'idle';
      const row = moving ? Math.abs(dx) > Math.abs(dy) ? 2 : dy < 0 ? 1 : 0 : 0;
      shadow(position.x + 16, position.y + 27, 10);
      ctx.save(); if (moving && dx < 0 && row === 2) { ctx.translate(Math.round(position.x + 32), 0); ctx.scale(-1, 1); sprite(ctx, images, key, 0, position.y, Math.floor(motion * 6) % ART[key].frames, row); } else sprite(ctx, images, key, position.x, position.y, Math.floor(motion * 6) % ART[key].frames, row); ctx.restore();
      text(worker.name.slice(0, 12), position.x, position.y + 39, '#344c37', 7);
      if (worker.job && !moving) bar(position.x + 3, position.y + 31, worker.job.progress / worker.job.duration * 100, '#eedda2');
      if (worker.attention) {
        const bx = position.x + 9, by = position.y - 11;
        rect(bx, by, 25, 18, '#fff4cc'); rect(bx + 3, by + 17, 4, 4, '#fff4cc'); text('?', bx + 9, by + 13, '#6b593b', 13);
        bubbles.push({ x: bx, y: by, id: worker.id });
      }
    });
    const battle = combat.update(state, elapsed, { paused: isPaused(), reducedMotion: reduced?.matches });
    battle.guards.forEach((guard, i) => {
      const { x, y, weapon, attacking } = guard;
      const phase = fract(motion * 1.65 + i * .11);
      const column = attacking ? reduced?.matches ? 4 : Math.floor(phase * ART[weapon].frames) : 0;
      const left = attacking && guard.targetX < x;
      shadow(x + 16, y + 27, 10);
      ctx.save();
      if (left) { ctx.translate(Math.round(x + 32), 0); ctx.scale(-1, 1); }
      const drawn = sprite(ctx, images, weapon, left ? 0 : x, y, column, 2);
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
      const { x, y, hit } = monster;
      // The other damage cells flash white: use only the verified green pose.
      const key = hit ? 'slimeDamage' : 'slime', column = hit ? 0 : Math.floor(motion * 5) % 4;
      if (!sprite(ctx, images, key, x, y, column)) {
        if (!sprite(ctx, images, 'slime', x, y, 0)) {
          rect(x + 7, y + 14, 19, 10, hit ? '#77b56a' : '#598f55');
          rect(x + 11, y + 11, 11, 4, hit ? '#77b56a' : '#598f55'); rect(x + 12, y + 17, 2, 2, '#243e35'); rect(x + 20, y + 17, 2, 2, '#243e35');
        }
      }
      if (hit) { rect(x + 2, y + 13, 3, 2, '#d9cd91'); rect(x + 28, y + 10, 2, 3, '#d9cd91'); }
      bar(x + 3, y + 28, monster.health / monster.maxHealth * 100, '#e4a190');
    });
    battle.defeats.forEach(defeat => {
      // Clamp once to the final dissolve cell; never wrap a death back to life.
      const column = reduced?.matches ? 2 : Math.min(3, Math.floor(defeat.age / .16));
      if (!sprite(ctx, images, 'slimeDead', defeat.x, defeat.y, column)) {
        const height = reduced?.matches ? 3 : Math.max(2, 9 - column * 2);
        rect(defeat.x + 5, defeat.y + 25 - height, 23, height, '#6c9554');
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
  return () => { disposed = true; abort.abort(); cancelAnimationFrame(frame); canvas.removeEventListener('click', click); positions.clear(); images = {}; bubbles = []; };
}
