import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig({ root: resolve('src/renderer/mobile'), plugins: [react()], build: { outDir: resolve('out/mobile'), emptyOutDir: true } });
