import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve('src/main/index.ts'),
        external: ['better-sqlite3', 'chokidar'],
      },
    },
  },
  preload: {
    build: {
      // A sandboxed preload cannot be ESM (Electron requires non-sandboxed
      // preloads for ESM); force CommonJS output regardless of the
      // package.json "type": "module" setting, and fully bundle it since a
      // sandboxed preload cannot require() across files.
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        output: { format: 'cjs' },
      },
      externalizeDeps: false,
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
    plugins: [react()],
  },
});
