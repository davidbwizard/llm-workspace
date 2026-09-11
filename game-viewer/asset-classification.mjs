export const kinds = ['animation', 'static', 'growth-stages', 'variants', 'tileset', 'mixed', 'unknown'];

export function normalize(value) {
  return value.replace(/\.aseprite$|\.png$/i, '').replace(/^\d+[\d.]*\s*/, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const aliases = new Map(Object.entries({
  axe: 'axe and scythe', sickle: 'axe and scythe', 'axe and sickle': 'axe and scythe',
  pickaxe: 'pickaxe hoe and catching insects', hoe: 'pickaxe hoe and catching insects',
  'catching insect': 'pickaxe hoe and catching insects', sword: 'swordattack',
  'bow and arrow': 'archer', dead: 'death', sitting: 'setting',
  'throwing items': 'carrying throwing items',
}));

export function matchSource(location, sources, action) {
  const lower = location.toLowerCase();
  const player = lower.indexOf('character/character/');
  if (player >= 0 && action) {
    const prefix = `${lower.slice(0, player)}character/character/aseprite/`;
    const key = aliases.get(action) ?? action;
    return sources.find(source => source.location.toLowerCase().startsWith(prefix)
      && normalize(source.location.split('/').at(-1)) === key) ?? null;
  }
  const npc = lower.match(/^(.*character\/npc's\/[^/]+\/)/);
  if (!npc || lower.includes('portrait')) return null;
  const segments = location.split('/').map(normalize);
  const candidates = sources.filter(source => source.location.toLowerCase().startsWith(npc[1])
    && !source.location.toLowerCase().includes('portrait') && source.timelineFrames > 1);
  return candidates.find(source => {
    const key = normalize(source.location.split('/').at(-1));
    return ['idle', 'walk', 'jump rope', 'play soccer'].some(action =>
      (key === action || key.endsWith(` ${action}`))
      && segments.some(segment => segment === action || segment.endsWith(` ${action}`)));
  }) ?? null;
}

export function sourceAnimation(source, action) {
  // Direction tags may be CamelCase (IdleDown); the action "Pick Up" is not Up.
  const direction = name => name.trim().toLowerCase().match(/^[a-z]*(down|up|right|left)$/)?.[1];
  let tags = source.tags.filter(tag => direction(tag.name));
  // Some source files named for one action actually include several actions.
  const parents = source.tags.filter(tag => !direction(tag.name));
  const parent = parents.find(tag => action === normalize(tag.name) || action?.endsWith(` ${normalize(tag.name)}`));
  if (parent) tags = tags.filter(tag => tag.from >= parent.from && tag.to <= parent.to);
  if (tags.length && new Set(tags.map(tag => direction(tag.name))).size !== tags.length) return null;
  if (!tags.length) {
    // Unlabelled tags can establish cycle lengths, but never direction names.
    tags = source.tags.filter(tag => !source.tags.some(other => other !== tag && other.from >= tag.from
      && other.to <= tag.to && (other.from > tag.from || other.to < tag.to)));
  }
  if (!tags.length) return { frames: source.timelineFrames, totalCells: source.timelineFrames, directionCount: 1 };
  if (new Set(tags.map(tag => tag.frames)).size !== 1) return null;
  const sorted = [...tags].sort((a, b) => a.from - b.from);
  if (sorted.some((tag, index) => index && tag.from <= sorted[index - 1].to)) return null;
  return { frames: tags[0].frames, totalCells: tags.reduce((total, tag) => total + tag.frames, 0), directionCount: tags.length };
}

function glob(pattern) {
  if (typeof pattern !== 'string' || !pattern || pattern.length > 512) throw new Error('Rule match must be a glob of 1–512 characters.');
  let result = '^';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      index++;
      if (pattern[index + 1] === '/') { result += '(?:.*/)?'; index++; }
      else result += '.*';
    } else if (char === '*') result += '[^/]*';
    else result += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${result}$`, 'i');
}

export function compileRules(document) {
  if (!document || document.schemaVersion !== 1 || !Array.isArray(document.rules)) throw new Error('Invalid rules file.');
  const ids = new Set();
  return document.rules.map(rule => {
    const allowed = ['id', 'match', 'exclude', 'widths', 'heights', 'kind', 'frames', 'animation', 'frameSize', 'cellSize', 'stageCount', 'metadataNeeded'];
    if (!rule || typeof rule.id !== 'string' || !rule.id || ids.has(rule.id) || !kinds.includes(rule.kind)
      || Object.keys(rule).some(key => !allowed.includes(key))) throw new Error('Invalid or duplicate classification rule.');
    ids.add(rule.id);
    for (const key of ['frames', 'stageCount']) {
      if (Object.hasOwn(rule, key) && rule[key] !== null && (!Number.isSafeInteger(rule[key]) || rule[key] < 1)) throw new Error(`Invalid ${key} in ${rule.id}`);
    }
    if (Object.hasOwn(rule, 'animation') && rule.animation !== null && typeof rule.animation !== 'string') throw new Error(`Invalid animation in ${rule.id}`);
    if (rule.frames != null && !['animation', 'static'].includes(rule.kind)) throw new Error(`Only animation/static rules accept frames: ${rule.id}`);
    for (const key of ['widths', 'heights']) {
      if (rule[key] !== undefined && (!Array.isArray(rule[key]) || !rule[key].length
        || rule[key].some(value => !Number.isSafeInteger(value) || value < 1))) throw new Error(`Invalid ${key} in ${rule.id}`);
    }
    for (const key of ['frameSize', 'cellSize']) {
      if (rule[key] !== undefined && rule[key] !== 'image' && (!Array.isArray(rule[key]) || rule[key].length !== 2
        || rule[key].some(value => !['width', 'height'].includes(value) && (!Number.isSafeInteger(value) || value < 1)))) {
        throw new Error(`Invalid ${key} in ${rule.id}`);
      }
    }
    if (rule.metadataNeeded !== undefined && (!Array.isArray(rule.metadataNeeded)
      || rule.metadataNeeded.some(value => typeof value !== 'string'))) throw new Error(`Invalid metadataNeeded in ${rule.id}`);
    return { ...rule, pattern: glob(rule.match), excluded: rule.exclude ? glob(rule.exclude) : null };
  });
}

function applyLayout(entry) {
  const size = entry.frameSize ?? entry.cellSize;
  entry.cellCount = null;
  entry.columns = null;
  entry.rows = null;
  if (!size) return;
  if (entry.width % size[0] || entry.height % size[1]) {
    entry.warnings.push({ code: 'layout-conflict', imageSize: entry.imageSize, cellSize: size });
    return;
  }
  entry.columns = entry.width / size[0];
  entry.rows = entry.height / size[1];
  entry.cellCount = entry.columns * entry.rows;
  if (entry.kind === 'static' && entry.cellCount !== 1) entry.warnings.push({ code: 'layout-conflict', expectedCells: 1, actualCells: entry.cellCount });
}

export function classify(entry, { source, action, documentedFrames, rules, override }) {
  Object.assign(entry, {
    kind: 'unknown', frameSize: null, cellSize: null, cellCount: null, stageCount: null,
    frames: null, framesSource: 'unknown', frameSizeSource: 'unknown', animation: action,
    source: source?.location ?? null, metadataNeeded: [], warnings: [],
  });
  let sourceCycle = null;
  if (source) {
    entry.kind = 'animation';
    entry.frameSize = [...source.canvasSize];
    entry.frameSizeSource = 'aseprite';
    sourceCycle = sourceAnimation(source, action);
    if (sourceCycle) {
      entry.frames = sourceCycle.frames;
      entry.framesSource = 'aseprite';
      if (documentedFrames && documentedFrames !== entry.frames) {
        entry.warnings.push({ code: 'documented-frame-conflict', documentedFrames, sourceFrames: entry.frames });
      }
    } else entry.metadataNeeded.push('source-animation-ranges');
    const lower = entry.location.toLowerCase();
    // Verified export differences: cropped modular layers, padded carrying frames,
    // and the taller mounted-character canvas used by premade horse sheets.
    if (lower.includes('/character/character/png/') && sourceCycle && entry.height === 32
      && entry.width === sourceCycle.totalCells * 32) {
      entry.frameSize = [32, 32]; entry.frameSizeSource = 'modular-32px-strip';
    }
    if (lower.includes('/character/character/png/') && action?.startsWith('horse ')
      && entry.height === 48 && sourceCycle && entry.width === sourceCycle.totalCells * 32) {
      entry.frameSize = [32, 48]; entry.frameSizeSource = 'modular-horse-export';
    }
    if (lower.includes('/pre-made/') && action?.startsWith('carrying ') && lower.includes('/pick up itens/')) {
      entry.frameSize = [64, 64]; entry.frameSizeSource = 'premade-carrying-export';
    }
    if (lower.includes('/pre-made/') && action?.startsWith('horse ')) {
      entry.frameSize = [32, 48]; entry.frameSizeSource = 'premade-horse-export';
    }
  } else if (action && documentedFrames) {
    entry.kind = 'animation'; entry.frames = documentedFrames; entry.framesSource = 'pack-documentation';
    entry.metadataNeeded.push('frame-size');
  }
  const rule = rules.find(rule => rule.pattern.test(entry.location) && !rule.excluded?.test(entry.location)
    && (!rule.widths || rule.widths.includes(entry.width)) && (!rule.heights || rule.heights.includes(entry.height)));
  if (rule) {
    entry.rule = rule.id;
    entry.kind = rule.kind;
    entry.animation = rule.animation ?? null;
    entry.metadataNeeded = [...(rule.metadataNeeded ?? [])];
    for (const key of ['frameSize', 'cellSize']) {
      entry[key] = rule[key] === 'image' ? entry.imageSize : rule[key]?.map(value => typeof value === 'string' ? entry[value] : value) ?? null;
    }
    entry.frameSizeSource = 'folder-rule';
    entry.frames = rule.frames ?? (rule.kind === 'static' ? 1 : null);
    entry.framesSource = entry.frames !== null ? 'folder-rule' : ['animation', 'unknown'].includes(rule.kind) ? 'unknown' : 'not-applicable';
    entry.stageCount = rule.stageCount ?? null;
    sourceCycle = null;
  }
  if (override) {
    const allowed = ['frames', 'animation', 'kind', 'frameSize', 'cellSize', 'stageCount'];
    if (typeof override !== 'object' || Array.isArray(override) || !Object.keys(override).length
      || Object.keys(override).some(key => !allowed.includes(key))
      || (Object.hasOwn(override, 'kind') && !kinds.includes(override.kind))
      || (Object.hasOwn(override, 'animation') && override.animation !== null && typeof override.animation !== 'string')) throw new Error(`Invalid override: ${entry.location}`);
    for (const key of ['frames', 'stageCount']) {
      if (Object.hasOwn(override, key) && override[key] !== null && (!Number.isSafeInteger(override[key]) || override[key] < 1)) throw new Error(`Invalid override ${key}: ${entry.location}`);
    }
    for (const key of ['frameSize', 'cellSize']) {
      if (Object.hasOwn(override, key) && override[key] !== null && (!Array.isArray(override[key]) || override[key].length !== 2
        || override[key].some(value => !Number.isSafeInteger(value) || value < 1))) throw new Error(`Invalid override ${key}: ${entry.location}`);
    }
    if (Object.hasOwn(override, 'kind')) {
      entry.metadataNeeded = [];
      entry.frameSize = null; entry.cellSize = null;
      if (override.kind !== 'animation') entry.animation = null;
      if (override.kind === 'static') {
        entry.frames = 1; entry.frameSize = entry.imageSize;
      }
    }
    Object.assign(entry, override);
    if (Object.hasOwn(override, 'frames')) entry.framesSource = 'override';
    if (override.kind === 'static') entry.framesSource = 'override';
    if (Object.hasOwn(override, 'frameSize') || Object.hasOwn(override, 'cellSize') || override.kind === 'static') entry.frameSizeSource = 'override';
    if (Object.hasOwn(override, 'kind') && !['animation', 'static'].includes(entry.kind)) {
      if (override.frames !== undefined && override.frames !== null) throw new Error(`Only animations/static assets accept frames: ${entry.location}`);
      entry.frames = null; entry.framesSource = 'not-applicable';
    }
    sourceCycle = null; // Explicit per-file rules supersede the source export layout.
  }
  if (entry.frameSize && entry.cellSize) throw new Error(`Use either frameSize or cellSize: ${entry.location}`);
  applyLayout(entry);
  if (entry.stageCount !== null && entry.cellCount !== null && entry.stageCount > entry.cellCount) throw new Error(`stageCount exceeds cellCount: ${entry.location}`);
  if (entry.kind === 'animation' && entry.frames !== null && entry.cellCount !== null) {
    const groups = entry.cellCount / entry.frames;
    const isModular = /\/png\//i.test(entry.location) && !/\/pre-made\//i.test(entry.location);
    if (!Number.isInteger(groups) || groups < 1 || (sourceCycle && (isModular
      ? entry.cellCount !== sourceCycle.totalCells : groups > sourceCycle.directionCount))) {
      entry.warnings.push({ code: 'layout-conflict', expectedFrames: entry.frames, actualCells: entry.cellCount,
        sourceCells: sourceCycle?.totalCells ?? null });
    }
  }
  if (entry.kind === 'static' && entry.frames !== 1) throw new Error(`Static asset must have frames: 1: ${entry.location}`);
  if (entry.warnings.some(warning => warning.code === 'layout-conflict')) {
    entry.frames = null;
    entry.metadataNeeded.push('export-layout');
    if (entry.cellCount === null && entry.frameSize) {
      entry.frameSize = null;
      entry.frameSizeSource = 'unverified';
    }
  }
  if (entry.kind === 'unknown') entry.metadataNeeded.push('content-kind');
  if (entry.kind === 'animation' && entry.frames === null) entry.metadataNeeded.push('animation-frames');
  if (entry.kind === 'animation' && !entry.frameSize) entry.metadataNeeded.push('frame-size');
  if (['mixed', 'variants', 'tileset', 'growth-stages'].includes(entry.kind) && !entry.cellSize) entry.metadataNeeded.push('cell-size');
  if (entry.kind === 'growth-stages' && entry.stageCount === null) entry.metadataNeeded.push('stage-roles');
  if (entry.kind === 'growth-stages' && entry.stageCount !== null) entry.metadataNeeded = entry.metadataNeeded.filter(value => value !== 'stage-roles');
  if (entry.frameSize) entry.metadataNeeded = entry.metadataNeeded.filter(value => value !== 'frame-size');
  entry.metadataNeeded = [...new Set(entry.metadataNeeded)];
  entry.needsReview = entry.metadataNeeded.length > 0 || entry.warnings.length > 0 || entry.empty === true
    || entry.pixelInspection === 'unsupported' || entry.type === 'unknown';
  return entry;
}
