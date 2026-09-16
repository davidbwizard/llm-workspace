#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewer } from '../serve-viewer.mjs';

const MODULES = ['app', 'scene', 'art', 'model', 'definitions', 'sessions', 'validation', 'storage', 'world', 'combat-view', 'combat', 'balance'];

export function createFarmServer(options = {}) {
  return createViewer({ ...options, extraStaticFiles: [
    ['/', ['farm/index.html', 'text/html; charset=utf-8']],
    ['/farm/', ['farm/index.html', 'text/html; charset=utf-8']],
    ['/farm/style.css', ['farm/style.css', 'text/css; charset=utf-8']],
    ...MODULES.map(name => [`/farm/${name}.mjs`, [`farm/${name}.mjs`, 'text/javascript; charset=utf-8']]),
  ] });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--help' && args.length === 1) {
      console.log('node farm/serve.mjs [--port 4175]');
    } else {
      if (args.length && (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1]))) throw new Error('Use --port PORT or --help.');
      const port = Number(args[1] ?? 4175);
      if (port < 1 || port > 65535) throw new Error('Port must be 1–65535.');
      const server = createFarmServer();
      server.on('error', error => { console.error(`Farm server: ${error.message}`); process.exitCode = 1; });
      server.listen(port, '127.0.0.1', () => console.log(`Little Meadow: http://127.0.0.1:${port}\nStandalone session simulator. Ctrl+C stops the server.`));
      process.on('SIGINT', () => server.close());
      process.on('SIGTERM', () => server.close());
    }
  } catch (error) { console.error(`Farm server: ${error.message}`); process.exitCode = 1; }
}
