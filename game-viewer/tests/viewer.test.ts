import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIndex, createViewer, queryAssets, queryFolders } from '../serve-viewer.mjs';

const asset = (name, extra = {}) => ({ name, location: `Pack/${name}.png`, type: 'character', kind: 'animation',
  imageSize: [128, 96], frameSize: [32, 32], cellSize: null, frames: 4, empty: false,
  needsReview: false, metadataNeeded: [], warnings: [], ...extra });
const manifest = assets => ({ schemaVersion: 3, assets, sources: [] });
const temporary: string[] = [];
const servers = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true });
});

describe('viewer catalog', () => {
  const folderAssets = () => [
    asset('Hair', { location: "Pack/Character/PNG/Idle/Hair's/One.png" }),
    asset('Nested hair', { location: "Pack/Character/PNG/Idle/Hair's/Blue/Two.png" }),
    asset('Similar prefix', { location: "Pack/Character/PNG/Idle/Hair's extra/Three.png" }),
    asset('Premade', { location: 'Pack/Character/Pre-made/Alex.png' }),
    asset('Other type', { location: 'Pack/Character/Other/Cow.png', type: 'animal' }),
  ];
  it('lists immediate subfolders with type-specific recursive counts', () => {
    const index = createIndex(manifest(folderAssets()));
    expect(index.options.types.find(item => item.value === 'character')).toMatchObject({ root: 'Pack/Character', count: 4 });
    const folders = queryFolders(index, new URLSearchParams({ type: 'character', folder: 'Pack/Character' }));
    expect(folders.children).toEqual([
      { name: 'PNG', path: 'Pack/Character/PNG', count: 3, hasChildren: true },
      { name: 'Pre-made', path: 'Pack/Character/Pre-made', count: 1, hasChildren: false },
    ]);
    expect(folders.children[0]).not.toHaveProperty('assets');
    expect(queryFolders(index, new URLSearchParams({ type: 'character', folder: 'Pack/Character/Pre-made' })).children).toEqual([]);
  });
  it('filters whole folder branches on path boundaries, combined with existing filters', () => {
    const index = createIndex(manifest(folderAssets()));
    expect(queryAssets(index, new URLSearchParams({ folder: "Pack/Character/PNG/Idle/Hair's" })).items.map(a => a.name))
      .toEqual(['Hair', 'Nested hair']);
    expect(queryAssets(index, new URLSearchParams({ folder: 'Pack/Character', type: 'character', size: '32x32' })).total).toBe(4);
    expect(queryAssets(index, new URLSearchParams({ folder: 'Pack/Character/PNG', type: 'animal' })).total).toBe(0);
    for (const folder of ['../secret', 'Pack//Character', 'Pack/absent', '/Pack', 'Pack\\Character']) {
      expect(() => queryAssets(index, new URLSearchParams({ folder }))).toThrow(/folder/i);
      expect(() => queryFolders(index, new URLSearchParams({ folder }))).toThrow(/folder/i);
    }
  });
  it('filters frame/cell sizes separately from whole-image dimensions', () => {
    const index = createIndex(manifest([asset('Idle'), asset('Beetroot', { type: 'crop', kind: 'growth-stages',
      frameSize: null, cellSize: [16, 16], imageSize: [128, 16], frames: null })]));
    expect(queryAssets(index, new URLSearchParams('size=32x32')).items[0].name).toBe('Idle');
    expect(queryAssets(index, new URLSearchParams('size=128x96')).total).toBe(0);
    expect(queryAssets(index, new URLSearchParams('sizeMode=image&size=128x96')).total).toBe(1);
    expect(queryAssets(index, new URLSearchParams('type=crop&size=16x16')).items[0].name).toBe('Beetroot');
  });
  it('returns small pages, omits full metadata, and keeps stable IDs', () => {
    const assets = Array.from({ length: 80 }, (_, index) => asset(`Sprite${index}`));
    const index = createIndex(manifest(assets));
    const page = queryAssets(index, new URLSearchParams('page=2'));
    expect(page.items).toHaveLength(36);
    expect(page.items[0].name).toBe('Sprite36');
    expect(page.items[0]).not.toHaveProperty('warnings');
    expect(page.items[0]).not.toHaveProperty('sourceMetadata');
    expect(createIndex(manifest([assets[36]])).records[0].id).toBe(page.items[0].id);
    expect(() => queryAssets(index, new URLSearchParams('limit=5000'))).toThrow();
    expect(() => queryAssets(index, new URLSearchParams('page=-1'))).toThrow();
  });
  it('combines search/type/kind/review filters and supports unmapped sizes', () => {
    const index = createIndex(manifest([asset('Idle'), asset('Chicken', { type: 'animal', kind: 'mixed',
      frameSize: null, frames: null, needsReview: true, metadataNeeded: ['animation-regions'] }),
    asset('Empty', { empty: true, needsReview: true })]));
    expect(queryAssets(index, new URLSearchParams('q=chick&type=animal&kind=mixed&review=metadata&size=unknown')).total).toBe(1);
    expect(queryAssets(index, new URLSearchParams('review=warnings')).items.map(a => a.name)).toEqual(['Empty']);
    expect(queryAssets(index, new URLSearchParams('review=ready')).total).toBe(1);
  });
  it('rejects traversal paths and duplicate locations', () => {
    for (const location of ['../secret.png', '/secret.png', 'Pack/../../secret.png', 'Pack\\secret.png']) {
      expect(() => createIndex(manifest([asset('Bad', { location })]))).toThrow();
    }
    expect(() => createIndex(manifest([asset('Same'), asset('Same')]))).toThrow(/Duplicate/);
  });
});

describe('local HTTP viewer', () => {
  async function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-viewer-test-')); temporary.push(directory);
    const assetsRoot = path.join(directory, 'assets'); fs.mkdirSync(path.join(assetsRoot, 'Pack'), { recursive: true });
    const png = fileURLToPath(new URL('../assets/Farm RPG - Tiny Asset Pack - (All in One)/UI/Clock/Clock.png', import.meta.url));
    fs.copyFileSync(png, path.join(assetsRoot, 'Pack/Clock.png'));
    const manifestPath = path.join(directory, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest([asset('Clock', { type: 'ui', kind: 'static', imageSize: [32, 32], frames: 1 })])));
    const server = createViewer({ manifestPath, assetsRoot }); servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return { directory, assetsRoot, url: `http://127.0.0.1:${server.address().port}` };
  }
  it('serves the UI, paged results, individual details, and only catalogued PNGs', async () => {
    const { url } = await fixture();
    const html = await fetch(url);
    expect(html.status).toBe(200);
    expect(html.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await html.text()).toContain('Farm asset library');
    const page = await (await fetch(`${url}/api/assets`)).json();
    expect(page.items).toHaveLength(1);
    const id = page.items[0].id;
    const details = await (await fetch(`${url}/api/assets/${id}`)).json();
    expect(details.location).toBe('Pack/Clock.png');
    expect((await fetch(`${url}/images/${id}.png`)).headers.get('content-type')).toBe('image/png');
    expect((await fetch(`${url}/assets-manifest.json`)).status).toBe(404);
    expect((await fetch(`${url}/api/assets?limit=10000`)).status).toBe(400);
    expect((await (await fetch(`${url}/api/folders?type=ui`)).json()).children)
      .toEqual([{ name: 'Pack', path: 'Pack', count: 1, hasChildren: false }]);
    expect((await fetch(`${url}/api/folders?folder=..`)).status).toBe(400);
    expect((await fetch(`${url}/serve-viewer.mjs`)).status).toBe(404);
  });
  it('rejects cross-origin access, writes, and symlinks escaping the asset directory', async () => {
    const { url, directory, assetsRoot } = await fixture();
    expect((await fetch(`${url}/api/options`, { headers: { Origin: 'https://example.com' } })).status).toBe(403);
    expect((await fetch(`${url}/api/options`, { method: 'POST' })).status).toBe(405);
    const page = await (await fetch(`${url}/api/assets`)).json();
    const image = path.join(assetsRoot, 'Pack/Clock.png');
    fs.renameSync(image, path.join(directory, 'outside.png'));
    fs.symlinkSync(path.join(directory, 'outside.png'), image);
    expect((await fetch(`${url}/images/${page.items[0].id}.png`)).status).toBe(403);
  });
});
