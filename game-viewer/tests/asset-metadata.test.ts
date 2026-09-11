import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { crc32, deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { inspectPng, readAseprite } from '../asset-readers.mjs';
import { classify, compileRules, sourceAnimation } from '../asset-classification.mjs';
import { catalog, groupAssets, irregularities } from '../generate-assets.mjs';

const root = fileURLToPath(new URL('../assets/', import.meta.url));
const pack = 'Farm RPG - Tiny Asset Pack - (All in One)/';
const player = `${pack}Character/Character/`;
const ase = (name: string) => path.join(root, player, 'Aseprite', name);
const temporary: string[] = [];
function temp() { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-metadata-test-')); temporary.push(directory); return directory; }
afterEach(() => { for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true }); });

function png(filter: number, pixels: number[]) {
  function chunk(type: string, data: Buffer) {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    result.write(type, 4);
    data.copy(result, 8);
    result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
    return result;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([filter, ...pixels]))), chunk('IEND', Buffer.alloc(0))]);
}

describe('source metadata and PNG validation', () => {
  it('reads source canvas sizes independently of the 16px editor grid', () => {
    expect(readAseprite(ase('1. Idle.aseprite')).canvasSize).toEqual([32, 32]);
    const cast = readAseprite(ase('12. Fishing - Cast.aseprite'));
    expect(cast.canvasSize).toEqual([64, 64]);
    expect(cast.tags.find(tag => tag.name === 'Right').frames).toBe(15);
  });
  it.each([0, 1, 2, 3, 4])('decodes filter %s and checks alpha, not RGB colour', filter => {
    expect(inspectPng(png(filter, [10, 20, 30, 0])).empty).toBe(true);
    expect(inspectPng(png(filter, [0, 0, 0, 255])).empty).toBe(false);
  });
  it('rejects truncated PNGs, checksum damage and invalid filters', () => {
    const data = png(0, [0, 0, 0, 255]);
    expect(() => inspectPng(data.subarray(0, -1))).toThrow();
    data[20] ^= 1;
    expect(() => inspectPng(data)).toThrow(/checksum/);
    expect(() => inspectPng(png(5, [0, 0, 0, 0]))).toThrow(/filter/);
  });
  it('rejects invalid Aseprite file sizes and frame boundaries', () => {
    const filename = path.join(temp(), 'bad.aseprite');
    const data = fs.readFileSync(ase('1. Idle.aseprite'));
    fs.writeFileSync(filename, data.subarray(0, -1));
    expect(() => readAseprite(filename)).toThrow(/file length/);
    data.writeUInt32LE(0, 128);
    fs.writeFileSync(filename, data);
    expect(() => readAseprite(filename)).toThrow(/frame boundary/);
  });
  it('does not turn a combined multi-action timeline into one frame count', () => {
    const source = readAseprite(ase('13.2 Carrying - Run.aseprite'));
    expect(sourceAnimation(source, 'carrying run').frames).toBe(8);
    expect(sourceAnimation(source, 'unknown')).toBeNull();
  });
  it('does not confuse the Pick Up action tag with the Up direction', () => {
    expect(sourceAnimation(readAseprite(ase('13.3 Carrying - Pick Up.aseprite')), 'carrying pick up'))
      .toMatchObject({ frames: 4, totalCells: 16, directionCount: 4 });
  });
});

describe('pack classification', () => {
  const manifest = catalog(root, {}, { flat: true });
  const get = (suffix: string) => manifest.assets.find(asset => asset.location === pack + suffix);
  it('maps 32px idle and 64px casting without counting directions as frames', () => {
    const idle = get('Character/Character/Pre-made/Josh/Idle.png');
    expect(idle).toMatchObject({ kind: 'animation', frames: 4, frameSize: [32, 32], cellCount: 12 });
    expect(get('Character/Character/Pre-made/Josh/Fishing/Casting.png'))
      .toMatchObject({ frames: 15, frameSize: [64, 64], cellCount: 45 });
  });
  it('resolves flute, cropped bear accessories, and action ranges inside combined source timelines', () => {
    expect(get('Character/Character/PNG/22. Flute/Acc/Beret.png')).toMatchObject({ frames: 6, frameSize: [32, 32], cellCount: 18 });
    expect(get('Character/Character/PNG/16. Bear - Idle/Acc/Beard/Black.png')).toMatchObject({ frames: 2, frameSize: [32, 32] });
    expect(get('Character/Character/PNG/13.2 Carrying - Run/Acc/Beard/Black.png')).toMatchObject({ frames: 8, cellCount: 32 });
    expect(get('Character/Character/PNG/13.3 Carrying - Pick Up/Acc/Beret.png')).toMatchObject({ frames: 4, cellCount: 16 });
    expect(get('Character/Character/Pre-made/Josh/Pick Up Itens/Pick Up Itens.png')).toMatchObject({ frames: 4, frameSize: [64, 64], cellCount: 12 });
    expect(get('Character/Character/PNG/12. Fishing - Cast/Acc/Beard/Black.png')).toMatchObject({ frames: 15, frameSize: [32, 32], cellCount: 60 });
    expect(get('Character/Character/PNG/14. Horse - Idle/Horse/1.png')).toMatchObject({ frames: 2, frameSize: [32, 48], cellCount: 8 });
    expect(get('Character/Character/Pre-made/Lyria/bicycle/Colors/Green.png')).toMatchObject({ frames: 4, frameSize: [32, 32] });
  });
  it('uses NPC source counts and does not apply playable-character idle to children', () => {
    const child = manifest.assets.find(asset => asset.location.includes("NPC'S/Child/PNG/Idle/"));
    expect(child.frames).toBe(2);
  });
  it('separates static images, variants, growth states, and mixed animation sheets', () => {
    expect(get('UI/Clock/Clock.png')).toMatchObject({ kind: 'static', frames: 1, frameSize: [32, 32], needsReview: false });
    expect(get('Icons/Bugs/Bee.png')).toMatchObject({ kind: 'variants', frames: null, cellSize: [16, 16], cellCount: 4 });
    expect(get('Crops/Fall/Beetroot.png')).toMatchObject({ kind: 'growth-stages', frames: null, cellCount: 8, stageCount: null });
    expect(get('Animals/Farm/Chicken/Baby Chicken Black.png')).toMatchObject({ kind: 'mixed', frames: null, cellSize: [16, 16], cellCount: 28 });
  });
  it('records source/documentation disagreement and genuine transparent sheets', () => {
    const bicycle = manifest.assets.find(asset => asset.location.includes('/PNG/15. Bicycle - Idle/'));
    expect(bicycle.frames).toBe(2);
    expect(bicycle.warnings.some(issue => issue.code === 'documented-frame-conflict')).toBe(true);
    expect(get('Character/Character/PNG/18. Setting/Acc/Bloco de mapa 1.png').empty).toBe(true);
    const petting = get('Character/Character/Pre-made/Josh/Petting.png');
    expect(petting.frames).toBeNull();
    expect(petting.warnings.some(issue => issue.code === 'layout-conflict')).toBe(true);
    expect(get('Character/Character/Pre-made/Alex/Fishing/Hooked.png').frameSize).toBeNull();
  });
  it('preserves every asset once in the folder hierarchy and separates report categories', () => {
    function flatten(node) { return [...node.assets, ...Object.values(node.folders).flatMap(flatten)]; }
    const tree = groupAssets(manifest.assets);
    const all = flatten(tree);
    expect(tree.path).toBe('');
    const characters = tree.folders[pack.slice(0, -1)].folders.Character;
    expect(characters.path).toBe(`${pack}Character`);
    expect(characters.folders.Character.folders.PNG.folders['1. Idle'].folders["Hair's"].path)
      .toBe(`${player}PNG/1. Idle/Hair's`);
    expect(all).toHaveLength(5747);
    expect(new Set(all.map(asset => asset.location)).size).toBe(5747);
    const report = irregularities(root, manifest.assets);
    expect(report.checks.emptyImages.items.length).toBeGreaterThan(0);
    expect(report.checks.metadataNeeded.severity).toBe('metadata');
    expect(report.checks.metadataNeeded.items.some(asset => asset.location.endsWith('/UI/Clock/Clock.png'))).toBe(false);
    expect(report.summary.identicalFileGroups).toBe(144);
  });
});

describe('rules, overrides, and CLI safety', () => {
  const base = () => ({ location: 'Pack/UI/Clock.png', imageSize: [32, 32], width: 32, height: 32, empty: false });
  const classifyOverride = override => classify(base(), { source: null, action: null, documentedFrames: null, rules: [], override });
  it('accepts explicit static and tile metadata and rejects invalid overrides', () => {
    expect(classifyOverride({ kind: 'static' })).toMatchObject({ frames: 1, frameSize: [32, 32], cellCount: 1, needsReview: false });
    expect(classifyOverride({ kind: 'tileset', cellSize: [16, 16] })).toMatchObject({ frames: null, cellCount: 4, needsReview: false });
    expect(() => classifyOverride({ frames: 0 })).toThrow(/Invalid override/);
    expect(() => classifyOverride({ frameSize: [0, 32] })).toThrow(/Invalid override/);
    expect(() => classifyOverride({ kind: 'static', frames: 2 })).toThrow(/Static asset/);
    expect(() => classifyOverride({ kind: 'growth-stages', cellSize: [16, 16], stageCount: 5 })).toThrow(/stageCount/);
  });
  it('applies specific folder rules before broader rules and validates rule files', () => {
    const rules = compileRules({ schemaVersion: 1, rules: [
      { id: 'specific', match: '**/UI/Clock.png', kind: 'static', frameSize: 'image' },
      { id: 'general', match: '**/*.png', kind: 'unknown' },
    ] });
    expect(classify(base(), { rules, source: null, action: null, documentedFrames: null, override: null }).kind).toBe('static');
    expect(() => compileRules({ schemaVersion: 1, rules: [{ id: 'bad', match: '**', kind: 'made-up' }] })).toThrow();
  });
  it('writes nested/flat manifests and a separate failure report without replacing good output', () => {
    const directory = temp(), assets = path.join(directory, 'assets');
    fs.mkdirSync(path.join(assets, 'UI', 'Clock'), { recursive: true });
    fs.copyFileSync(path.join(root, pack, 'UI/Clock/Clock.png'), path.join(assets, 'UI/Clock/Clock.png'));
    const output = path.join(directory, 'manifest.json'), report = path.join(directory, 'report.json');
    const script = fileURLToPath(new URL('../generate-assets.mjs', import.meta.url));
    const args = [script, '--assets', assets, '--out', output, '--report', report];
    const run = extra => spawnSync(process.execPath, [...args, ...extra], { encoding: 'utf8' });
    expect(run([]).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).folders.UI.folders.Clock.assets[0].frames).toBe(1);
    expect(run(['--flat']).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).assets).toHaveLength(1);
    const saved = fs.readFileSync(output, 'utf8');
    fs.writeFileSync(path.join(assets, 'broken.png'), 'invalid png');
    expect(run([]).status).toBe(1);
    expect(fs.readFileSync(output, 'utf8')).toBe(saved);
    expect(JSON.parse(fs.readFileSync(report, 'utf8'))).toMatchObject({ status: 'failed' });
    expect(run(['--report', output]).status).toBe(1);
    expect(fs.readFileSync(output, 'utf8')).toBe(saved);
  });
});
