import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { realpathSync } from 'node:fs';
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
    // theme.css loads its three font files straight out of node_modules by
    // relative path, so Vite has to be allowed to serve from wherever that
    // directory REALLY is. In the main checkout it is inside the project
    // root and this line changes nothing. In a git worktree it is a symlink
    // to the main checkout's (the trick that makes the suite and typecheck
    // run there), which lands outside the worktree root -- Vite then refuses
    // every font with "outside of Vite serving allow list", and the whole app
    // silently renders in fallback faces. realpathSync is what makes this
    // work in both places without hard-coding a machine-specific path.
    server: { fs: { allow: [resolve('.'), realpathSync(resolve('node_modules'))] } },
  },
});
