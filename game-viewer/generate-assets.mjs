#!/usr/bin/env node
// Local PNG catalog generator. No dependencies, network requests, or AI calls.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspectPng, readAseprite } from './asset-readers.mjs';
import { classify, compileRules, matchSource, normalize } from './asset-classification.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const types = new Map(Object.entries({
  Character: 'character', Animals: 'animal', Crops: 'crop', Enemy: 'enemy',
  Icons: 'icon', Objects: 'object', Tileset: 'tileset', UI: 'ui',
}).map(([key, value]) => [key.toLowerCase(), value]));

// Frames PER animation, not the number of cells/directions/variants in a PNG.
// These counts apply to this pack's playable characters, not every asset.
const counts = new Map(Object.entries({
  idle: 4, walk: 6, run: 8, pickaxe: 6, hoe: 6, axe: 6, sickle: 6,
  'pickaxe hoe and catching insects': 6, 'catching insect': 6,
  'axe and sickle': 6, shovel: 5, watering: 8,
  sword: 10, swordattack: 10, damage: 4, dead: 4, death: 4,
  archer: 7, 'bow and arrow': 7, mage: 6,
  'fishing cast': 15, 'fishing wait': 4, 'fishing bite': 8,
  'fishing reel': 4, 'fishing catch': 4,
  'carrying idle': 4, 'carrying walk': 6, 'carrying run': 8,
  'carrying pick up': 4, 'carrying throwing items': 5,
  'horse idle': 2, 'horse run': 6,
  'bicycle idle': 4, 'bicycle run': 4, broomstick: 4,
  'umbrela idle': 4, 'umbrela walk': 6, 'umbrela run': 8,
  climbing: 5, sitting: 1, setting: 1, sleep: 2, petting: 4,
  'throwing items': 5, 'swim idle': 4, 'swim outwater': 3,
  'swim submerged': 4, 'swim swim': 4,
}));

export function animationFor(location) {
  const parts = location.split('/');
  const lower = parts.map(part => part.toLowerCase());
  const character = lower.indexOf('character');
  if (character < 0 || lower[character + 1] !== 'character') return null;
  const branch = lower[character + 2];
  if (branch === 'png') return normalize(parts[character + 3] ?? '');
  if (branch !== 'pre-made') return null;

  const rest = parts.slice(character + 4);
  const group = rest.length > 1 ? rest[0].toLowerCase() : '';
  const name = normalize(path.posix.basename(location, '.png'));
  // Colour/accessory variants inherit the action directory when present.
  const action = rest.slice(0, -1).map(normalize)
    .find(value => ['idle', 'walk', 'run'].includes(value))
    ?? ['idle', 'walk', 'run'].find(value => name.split(' ').includes(value));

  if (group === 'horse') return action ? `horse ${action}` : null;
  if (group === 'bicycle') return action ? `bicycle ${action}` : rest.some(part => part.toLowerCase() === 'colors') ? 'bicycle run' : null;
  if (group === 'broomstick') return action ? 'broomstick' : null;
  if (group === 'umbrella') return action ? `umbrela ${action}` : null;
  if (group === 'flute' && name === 'flute') return 'flute';
  if (group === 'magic') return name.startsWith('magic ') || name === 'healer' ? 'mage' : null;
  if (group === 'fishing') {
    if (name === 'casting') return 'fishing cast';
    if (name === 'wait idle') return 'fishing wait';
    if (name === 'hooked') return 'fishing bite';
    if (name === 'roll') return 'fishing reel';
    if (name.startsWith('captured ')) return 'fishing catch';
    return null;
  }
  if (group === 'swim') {
    if (name === 'coming out of the water') return 'swim outwater';
    return ['idle', 'swim', 'submerged'].includes(name) ? `swim ${name}` : null;
  }
  if (group === 'pick up itens') {
    if (action) return `carrying ${action}`;
    return name.startsWith('pick up itens') ? 'carrying pick up' : null;
  }
  return rest.length === 1 ? name : null;
}

export function pngSize(filename) {
  const { width, height } = inspectPng(fs.readFileSync(filename), filename);
  return { width, height };
}

// Keep full sprite records at their actual folder level, without duplicating them.
export function groupAssets(assets) {
  const folder = (path = '') => ({
    path,
    summary: { total: 0, knownFrames: 0, needsReview: 0 },
    folders: Object.create(null),
    assets: [],
  });
  const root = folder();
  function count(node, asset) {
    node.summary.total += 1;
    node.summary.knownFrames += Number(asset.frames !== null);
    node.summary.needsReview += Number(asset.needsReview);
  }
  for (const asset of assets) {
    let node = root;
    count(node, asset);
    for (const name of asset.location.split('/').slice(0, -1)) {
      node.folders[name] ??= folder(node.path ? `${node.path}/${name}` : name);
      node = node.folders[name];
      count(node, asset);
    }
    node.assets.push(asset);
  }
  return root;
}

export function catalog(root, overrides = {}, { flat = false, rulesFile = path.join(here, 'asset-rules.json') } = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('Overrides must be an object keyed by asset-relative PNG path.');
  }
  const rules = compileRules(JSON.parse(fs.readFileSync(rulesFile, 'utf8')));
  const files = [];
  const sourceFiles = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile() && /\.png$/i.test(entry.name)) files.push(filename);
      else if (entry.isFile() && /\.aseprite$/i.test(entry.name)) sourceFiles.push(filename);
      // Do not follow symlinks outside the asset tree or into directory cycles.
    }
  }
  walk(root);
  files.sort(); sourceFiles.sort();
  const relative = filename => path.relative(root, filename).split(path.sep).join('/');
  const sources = sourceFiles.map(filename => ({ location: relative(filename), ...readAseprite(filename) }));
  const pixelCache = new Map();
  const seen = new Set();
  const assets = files.map(filename => {
    const location = relative(filename);
    seen.add(location);
    const action = animationFor(location);
    const source = matchSource(location, sources, action);
    const data = fs.readFileSync(filename);
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (!pixelCache.has(sha256)) pixelCache.set(sha256, inspectPng(data, filename));
    const entry = {
      name: path.basename(filename, path.extname(filename)), location,
      type: location.split('/').map(part => types.get(part.toLowerCase())).find(Boolean) ?? 'unknown',
      ...pixelCache.get(sha256), sha256,
    };
    const hasOverride = Object.hasOwn(overrides, location);
    if (hasOverride && !overrides[location]) throw new Error(`Invalid override: ${location}`);
    return classify(entry, { source, action: action ?? (source ? normalize(source.location.split('/').at(-1)) : null),
      documentedFrames: counts.get(action) ?? null, rules, override: hasOverride ? overrides[location] : null });
  }).sort((a, b) => a.location < b.location ? -1 : a.location > b.location ? 1 : 0);
  for (const location of Object.keys(overrides)) {
    if (!seen.has(location)) throw new Error(`Override does not match a PNG: ${location}`);
  }
  return {
    schemaVersion: 3,
    layout: flat ? 'flat' : 'folders',
    framesMeaning: 'Animation frames per direction; 1 for a verified static image. Null means unverified or not applicable; see kind and metadataNeeded. Cell counts include blank cells.',
    sources,
    ...(flat ? {
      summary: { total: assets.length, knownFrames: assets.filter(asset => asset.frames !== null).length,
        needsReview: assets.filter(asset => asset.needsReview).length },
      assets,
    } : groupAssets(assets)),
  };
}

export function irregularities(root, assets) {
  const unknownFrames = [];
  const metadataNeeded = [];
  const emptyImages = [];
  const layoutConflicts = [];
  const metadataConflicts = [];
  const unsupportedPixelInspection = [];
  const unknownTypes = [];
  const nonGridDimensions = [];
  const hashes = new Map();
  for (const asset of assets) {
    const { location, width, height } = asset;
    if (asset.kind === 'animation' && asset.frames === null) unknownFrames.push({ location, width, height });
    if (asset.metadataNeeded.length) metadataNeeded.push({ location, kind: asset.kind, missing: asset.metadataNeeded });
    if (asset.empty === true) emptyImages.push({ location, width, height });
    if (asset.pixelInspection !== 'complete') unsupportedPixelInspection.push({ location });
    for (const issue of asset.warnings) {
      (issue.code === 'layout-conflict' ? layoutConflicts : metadataConflicts).push({ location, ...issue });
    }
    if (asset.type === 'unknown') unknownTypes.push({ location });
    if (width % 16 !== 0 || height % 16 !== 0) nonGridDimensions.push({ location, width, height });
    const hash = asset.sha256;
    if (!hashes.has(hash)) hashes.set(hash, []);
    hashes.get(hash).push(location);
  }
  const identicalFiles = [...hashes.entries()]
    .filter(([, locations]) => locations.length > 1)
    .map(([sha256, locations]) => ({ sha256, locations }));
  return {
    schemaVersion: 2,
    status: 'complete',
    summary: {
      assetsScanned: assets.length,
      unknownFrames: unknownFrames.length,
      metadataNeeded: metadataNeeded.length,
      emptyImages: emptyImages.length,
      layoutConflicts: layoutConflicts.length,
      metadataConflicts: metadataConflicts.length,
      unsupportedPixelInspection: unsupportedPixelInspection.length,
      unknownTypes: unknownTypes.length,
      nonGridDimensions: nonGridDimensions.length,
      identicalFileGroups: identicalFiles.length,
      filesInIdenticalGroups: identicalFiles.reduce((sum, group) => sum + group.locations.length, 0),
    },
    checks: {
      metadataNeeded: { severity: 'metadata', description: 'Classification, animation regions, frame size, or stage roles still need a mapping. This does not indicate damaged assets.', items: metadataNeeded },
      unknownFrames: { severity: 'metadata', description: 'An animation lacks a verified count. Static images and non-animation sheets are excluded.', items: unknownFrames },
      emptyImages: { severity: 'warning', description: 'Every pixel is fully transparent. The file may be an intentional placeholder.', items: emptyImages },
      layoutConflicts: { severity: 'warning', description: 'The PNG export does not fit its proposed frame size or source animation layout. Conflicting frame counts are withheld.', items: layoutConflicts },
      metadataConflicts: { severity: 'warning', description: 'Source metadata disagrees with the pack description. Source values are used only when the PNG layout also fits.', items: metadataConflicts },
      unsupportedPixelInspection: { severity: 'metadata', description: 'Pixel inspection supports non-interlaced 8-bit RGBA PNGs only; this image was not checked for transparency.', items: unsupportedPixelInspection },
      unknownTypes: { severity: 'warning', description: 'No recognized category folder was found in the path.', items: unknownTypes },
      nonGridDimensions: { severity: 'info', description: 'Image width or height is not divisible by 16. This may be intentional; pixels per unit does not require grid-aligned image sizes.', items: nonGridDimensions },
      identicalFiles: { severity: 'info', description: 'PNG files have identical bytes. Shared modular parts and copies may be intentional. Nothing is removed.', items: identicalFiles },
    },
  };
}

function writeJson(output, result) {
  const temporary = fs.mkdtempSync(path.join(path.dirname(output), '.asset-manifest-'));
  const pending = path.join(temporary, 'manifest.json');
  try {
    fs.writeFileSync(pending, `${JSON.stringify(result, null, 2)}\n`);
    fs.renameSync(pending, output);
  } finally {
    if (fs.existsSync(pending)) fs.unlinkSync(pending);
    fs.rmdirSync(temporary);
  }
}

function main(args) {
  const options = {
    '--assets': path.join(here, 'assets'), '--out': path.join(here, 'assets-manifest.json'),
    '--report': path.join(here, 'assets-irregularities.json'),
    '--rules': path.join(here, 'asset-rules.json'),
  };
  if (args.length === 1 && args[0] === '--help') {
    console.log('node game-viewer/generate-assets.mjs [--assets DIRECTORY] [--out FILE.json] [--report FILE.json] [--rules FILE.json] [--overrides FILE.json] [--flat]');
    return;
  }
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--flat') { options[key] = true; continue; }
    if (!['--assets', '--out', '--report', '--rules', '--overrides'].includes(key) || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error(`Invalid argument: ${key}. Use --help.`);
    }
    options[key] = path.resolve(args[++index]);
  }
  const output = options['--out'];
  const reportPath = options['--report'];
  if ([output, reportPath].some(filename => path.extname(filename).toLowerCase() !== '.json')) {
    throw new Error('Manifest and report outputs must be .json files.');
  }
  if (output === reportPath || [output, reportPath].some(filename => [options['--overrides'], options['--rules']].includes(filename))) {
    throw new Error('Manifest, report, rules, and overrides must use different paths.');
  }
  let result;
  let report;
  try {
    const overrides = options['--overrides'] ? JSON.parse(fs.readFileSync(options['--overrides'], 'utf8')) : {};
    const flat = catalog(options['--assets'], overrides, { flat: true, rulesFile: options['--rules'] });
    report = irregularities(options['--assets'], flat.assets);
    result = options['--flat'] ? flat : { ...flat, layout: 'folders', ...groupAssets(flat.assets) };
  } catch (error) {
    try { writeJson(reportPath, { schemaVersion: 2, status: 'failed', error: error.message }); }
    catch (reportError) { throw new Error(`${error.message}; also unable to write report: ${reportError.message}`); }
    throw error;
  }
  // Publish only after a complete successful scan; preserve old manifest on failure.
  writeJson(reportPath, report);
  writeJson(output, result);
  console.log(`Wrote ${output}: ${result.summary.total} PNGs, ${result.summary.knownFrames} known frame counts, ${result.summary.needsReview} need review.`);
  console.log(`Wrote ${reportPath}: ${report.summary.metadataNeeded} need metadata, ${report.summary.emptyImages} empty images, ${report.summary.layoutConflicts} layout conflicts, ${report.summary.metadataConflicts} source/documentation conflicts, ${report.summary.identicalFileGroups} identical-file groups.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`Asset scan failed: ${error.message}`); process.exitCode = 1; }
}
