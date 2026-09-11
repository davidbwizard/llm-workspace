#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream';

const here = path.dirname(fileURLToPath(import.meta.url));
const dimension = size => Array.isArray(size) && size.length === 2 && size.every(n => Number.isSafeInteger(n) && n > 0);
const sizeKey = size => dimension(size) ? size.join('x') : 'unknown';

export function createIndex(manifest) {
  if (manifest.schemaVersion !== 3) throw new Error('Regenerate the manifest with generate-assets.mjs first (schema version 3 required).');
  const entries = [];
  function walk(node) {
    if (!Array.isArray(node.assets)) throw new Error('Invalid manifest assets.');
    entries.push(...node.assets);
    for (const child of Object.values(node.folders ?? {})) walk(child);
  }
  walk(manifest);
  const byId = new Map();
  const records = entries.map(asset => {
    const location = asset.location;
    if (typeof location !== 'string' || !location || /[\\\0]/.test(location) || path.posix.isAbsolute(location)
      || location.split('/').some(part => !part || part === '.' || part === '..') || !/\.png$/i.test(location)) {
      throw new Error('Invalid PNG location in manifest.');
    }
    if (!dimension(asset.imageSize) || typeof asset.name !== 'string' || typeof asset.type !== 'string' || typeof asset.kind !== 'string') {
      throw new Error(`Invalid manifest entry: ${location}`);
    }
    const id = createHash('sha256').update(location).digest('hex').slice(0, 24);
    if (byId.has(id)) throw new Error(`Duplicate asset location/id: ${location}`);
    const record = { id, asset, search: `${asset.name} ${location} ${asset.animation ?? ''}`.toLowerCase(),
      cellSize: sizeKey(asset.frameSize ?? asset.cellSize), imageSize: sizeKey(asset.imageSize) };
    byId.set(id, record);
    return record;
  });
  // Index actual path segments, including counts per type. No sprite data is
  // duplicated into the folder responses sent to the browser.
  const folders = new Map();
  const typeRoots = new Map();
  const makeFolder = () => ({ children: new Map(), counts: new Map(), total: 0 });
  folders.set('', makeFolder());
  for (const { asset } of records) {
    const parts = asset.location.split('/').slice(0, -1);
    const root = typeRoots.get(asset.type);
    if (!root) typeRoots.set(asset.type, [...parts]);
    else {
      let common = 0;
      while (common < root.length && root[common] === parts[common]) common++;
      root.length = common;
    }
    let folderPath = '';
    for (const name of [null, ...parts]) {
      if (name !== null) {
        const parent = folders.get(folderPath);
        folderPath = folderPath ? `${folderPath}/${name}` : name;
        if (!folders.has(folderPath)) folders.set(folderPath, makeFolder());
        parent.children.set(name, folderPath);
      }
      const node = folders.get(folderPath);
      node.total++;
      node.counts.set(asset.type, (node.counts.get(asset.type) ?? 0) + 1);
    }
  }
  function facets(key) {
    const counts = new Map();
    for (const record of records) {
      const value = record[key] ?? record.asset[key];
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => a.value.localeCompare(b.value, 'en', { numeric: true }));
  }
  return { records, byId, folders, sources: new Map((manifest.sources ?? []).map(source => [source.location, source])),
    options: { total: records.length, types: facets('type').map(item => ({ ...item, root: typeRoots.get(item.value).join('/') })),
      kinds: facets('kind'), cellSizes: facets('cellSize'), imageSizes: facets('imageSize') } };
}

function selectedFolder(index, params) {
  const folder = params.get('folder') ?? '';
  if (!index.folders.has(folder)) throw new Error('Unknown or invalid folder. Clear the folder filter and try again.');
  return folder;
}

export function queryFolders(index, params) {
  const folder = selectedFolder(index, params), type = params.get('type') ?? '';
  const count = node => type ? node.counts.get(type) ?? 0 : node.total;
  const children = [...index.folders.get(folder).children].map(([name, path]) => {
    const node = index.folders.get(path);
    return { name, path, count: count(node), hasChildren: [...node.children.values()].some(child => count(index.folders.get(child)) > 0) };
  }).filter(node => node.count > 0).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  return { path: folder, children };
}

export function queryAssets(index, params) {
  const integer = (name, fallback, max) => {
    const value = params.get(name);
    if (value === null) return fallback;
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) throw new Error(`Invalid ${name}.`);
    return Number(value);
  };
  const page = integer('page', 1, 1_000_000), limit = integer('limit', 36, 72);
  const query = (params.get('q') ?? '').trim().toLowerCase();
  if (query.length > 200) throw new Error('Search is limited to 200 characters.');
  const type = params.get('type') ?? '', kind = params.get('kind') ?? '', size = params.get('size') ?? '';
  const folder = selectedFolder(index, params);
  const sizeMode = params.get('sizeMode') ?? 'cell', review = params.get('review') ?? '';
  if (!['cell', 'image'].includes(sizeMode) || !['', 'ready', 'metadata', 'warnings', 'empty'].includes(review)) throw new Error('Invalid filter.');
  const matches = index.records.filter(record => {
    const asset = record.asset;
    return (!query || record.search.includes(query)) && (!type || asset.type === type) && (!kind || asset.kind === kind)
      && (!folder || asset.location.startsWith(`${folder}/`))
      && (!size || record[sizeMode === 'cell' ? 'cellSize' : 'imageSize'] === size)
      && (!review || (review === 'ready' ? !asset.needsReview : review === 'metadata' ? asset.metadataNeeded?.length > 0
        : review === 'empty' ? asset.empty === true : asset.warnings?.length > 0 || asset.empty === true));
  });
  return { total: matches.length, page, limit, pages: Math.ceil(matches.length / limit),
    items: matches.slice((page - 1) * limit, page * limit).map(({ id, asset }) => ({
      id, name: asset.name, location: asset.location, type: asset.type, kind: asset.kind,
      imageSize: asset.imageSize, previewSize: asset.frameSize ?? asset.cellSize,
      frames: asset.frames, empty: asset.empty, needsReview: asset.needsReview,
      warningCount: (asset.warnings?.length ?? 0) + Number(asset.empty === true),
    })) };
}

export function createViewer({ manifestPath = path.join(here, 'assets-manifest.json'), assetsRoot = path.join(here, 'assets'), extraStaticFiles = [] } = {}) {
  const index = createIndex(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  const assetRoot = fs.realpathSync(assetsRoot);
  const staticFiles = new Map([
    ['/', ['viewer.html', 'text/html; charset=utf-8']],
    ['/viewer.js', ['viewer.js', 'text/javascript; charset=utf-8']],
    ['/viewer.css', ['viewer.css', 'text/css; charset=utf-8']],
    // Startup-only configuration: callers explicitly register local entry points.
    ...extraStaticFiles,
  ]);
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    response.setHeader('Cache-Control', 'no-store');
    const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
    const port = server.address()?.port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(request.headers.host) || (request.headers.origin && !hosts.map(host => `http://${host}`).includes(request.headers.origin))
      || request.headers['sec-fetch-site'] === 'cross-site') { json(403, { error: 'This viewer only accepts local, same-origin requests.' }); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.setHeader('Allow', 'GET, HEAD'); json(405, { error: 'Read-only viewer.' }); return; }
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (url.pathname === '/api/options') { json(200, index.options); return; }
      if (url.pathname === '/api/assets' || url.pathname === '/api/folders') {
        try { json(200, (url.pathname === '/api/folders' ? queryFolders : queryAssets)(index, url.searchParams)); }
        catch (error) { json(400, { error: error.message }); }
        return;
      }
      const details = url.pathname.match(/^\/api\/assets\/([a-f0-9]{24})$/);
      if (details) {
        const record = index.byId.get(details[1]);
        if (!record) { json(404, { error: 'Asset not found.' }); return; }
        json(200, { id: record.id, ...record.asset, sourceMetadata: index.sources.get(record.asset.source) ?? null }); return;
      }
      let filename, contentType, etag;
      const image = url.pathname.match(/^\/images\/([a-f0-9]{24})\.png$/);
      if (image) {
        const record = index.byId.get(image[1]);
        if (!record) { json(404, { error: 'Asset not found.' }); return; }
        filename = await fs.promises.realpath(path.join(assetRoot, record.asset.location));
        if (!filename.startsWith(`${assetRoot}${path.sep}`)) { json(403, { error: 'Asset is outside the asset directory.' }); return; }
        contentType = 'image/png';
        const stat = await fs.promises.stat(filename);
        etag = `"${stat.size}-${stat.mtimeMs}"`;
      } else if (staticFiles.has(url.pathname)) {
        const [relative, type] = staticFiles.get(url.pathname);
        filename = path.join(here, relative); contentType = type;
      } else { json(404, { error: 'Not found.' }); return; }
      const file = await fs.promises.open(filename, 'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile()) { json(404, { error: 'Not a file.' }); await file.close(); return; }
        if (etag) { response.setHeader('ETag', etag); response.setHeader('Cache-Control', 'private, max-age=60'); }
        if (etag && request.headers['if-none-match'] === etag) { response.writeHead(304); response.end(); await file.close(); return; }
        response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size });
        if (request.method === 'HEAD') { response.end(); await file.close(); return; }
        pipeline(file.createReadStream(), response, error => { if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('Viewer stream failed:', error.message); });
      } catch (error) { await file.close(); throw error; }
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') json(404, { error: 'File not found. Regenerate the catalog and restart the viewer.' });
      else { console.error('Viewer request failed:', error.message); json(500, { error: 'Unable to read this asset. Check the viewer terminal.' }); }
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help') {
      console.log('node game-viewer/serve-viewer.mjs [--port 4173]');
    } else {
      if (args.length && (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1]))) throw new Error('Use --port PORT or --help.');
      const port = Number(args[1] ?? 4173);
      if (port < 1 || port > 65535) throw new Error('Port must be 1–65535.');
      const server = createViewer();
      server.on('error', error => { console.error(`Viewer failed: ${error.message}`); process.exitCode = 1; });
      server.listen(port, '127.0.0.1', () => console.log(`Asset viewer: http://127.0.0.1:${port}\nImages load on demand. Ctrl+C stops the viewer.`));
      process.on('SIGINT', () => server.close());
      process.on('SIGTERM', () => server.close());
    }
  } catch (error) { console.error(`Viewer failed: ${error.message}`); process.exitCode = 1; }
}
