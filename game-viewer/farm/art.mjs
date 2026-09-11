// Regions below were inspected in the original PNGs. Crop columns are visual
// stages, never timing metadata. All game timing comes from definitions.mjs.
const base = 'Farm RPG - Tiny Asset Pack - (All in One)/';
export const ART = {
  josh: { path: 'Character/Character/Pre-made/Josh/Walk.png', cell: [32, 32], frames: 6 },
  idle: { path: 'Character/Character/Pre-made/Josh/Idle.png', cell: [32, 32], frames: 4 },
  hoe: { path: 'Character/Character/Pre-made/Josh/Hoe.png', cell: [32, 32], frames: 6 },
  watering: { path: 'Character/Character/Pre-made/Josh/Watering.png', cell: [32, 32], frames: 8 },
  sword: { path: 'Character/Character/Pre-made/Josh/Sword.png', cell: [32, 32], frames: 10 },
  bow: { path: 'Character/Character/Pre-made/Josh/Bow and Arrow.png', cell: [32, 32], frames: 8 },
  parsnip: { path: 'Crops/Spring/Parsnip.png', cell: [16, 16], stages: [0, 1, 2, 3, 4] },
  wheat: { path: 'Crops/Summer/Wheat.png', cell: [16, 16], stages: [0, 1, 2, 3, 4, 5] },
  house: { path: 'Objects/Exterior/Houses/7.png', cell: [128, 96] },
  tree: { path: 'Crops/Fruits Tree/Spring/Cherry Tree.png', cell: [32, 48] },
  cow: { path: 'Animals/Farm/Cow/Common Cow/Female Cow Black.png', cell: [32, 32], frames: 4 },
  sheep: { path: 'Animals/Farm/Sheep/Sheep Female.png', cell: [32, 32], frames: 4 },
  slimeDead: { path: 'Enemy/Slimes/Green/Slime/Dead.png', cell: [32, 32], frames: 4 },
  slimeDamage: { path: 'Enemy/Slimes/Green/Slime/Damage.png', cell: [32, 32], frames: 4 },
  slime: { path: 'Enemy/Slimes/Green/Slime/Walk.png', cell: [32, 32], frames: 4 },
};

export async function loadArt({ signal, onError = () => {} } = {}) {
  const images = {};
  await Promise.all(Object.entries(ART).map(async ([key, spec]) => {
    try {
      const path = base + spec.path;
      const response = await fetch(`/api/assets?q=${encodeURIComponent(spec.path)}&limit=12`, { signal });
      if (!response.ok) throw new Error(`catalog returned ${response.status}`);
      const catalog = await response.json();
      const asset = catalog.items.find(item => item.location === path);
      if (!asset || !/^[a-f0-9]{24}$/.test(asset.id)) throw new Error('asset missing from catalog');
      const img = new Image();
      await new Promise((resolve, reject) => {
        const abort = () => { img.src = ''; reject(new DOMException('Aborted', 'AbortError')); };
        img.onload = () => { signal?.removeEventListener('abort', abort); resolve(); };
        img.onerror = () => { signal?.removeEventListener('abort', abort); reject(new Error('image failed to load')); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) return abort();
        img.src = `/images/${asset.id}.png`;
      });
      images[key] = img;
    } catch (error) {
      if (!signal?.aborted) onError(`${key}: ${error.message}`);
    }
  }));
  return images;
}

export function sprite(ctx, images, key, x, y, column = 0, row = 0, scale = 1) {
  const img = images[key]; const spec = ART[key];
  if (!img || !spec) return false;
  const [w, h] = spec.cell;
  ctx.drawImage(img, column * w, row * h, w, h, Math.round(x), Math.round(y), w * scale, h * scale);
  return true;
}
