import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

// Execute the real loading branch without starting Electron, discovery, or
// database writes. import.meta.dirname is supplied as the bundled main path.
const main = readFileSync('src/main/index.ts', 'utf8');
const rendererLoad = main.match(/  if \([^\n]*\) void win\.loadURL\([^\n]*\);\n  else void win\.loadFile\([^\n]*\);/)?.[0];
if (!rendererLoad) throw new Error('main window renderer loading branch not found');

function loadRenderer(isPackaged: boolean, rendererUrl?: string) {
  const win = { loadURL: vi.fn(), loadFile: vi.fn() };
  runInNewContext(rendererLoad!.replaceAll('import.meta.dirname', 'mainDir'), {
    app: { isPackaged }, process: { env: { ELECTRON_RENDERER_URL: rendererUrl } },
    win, join, mainDir: '/fleet/out/main',
  });
  return win;
}

describe('main window renderer loading', () => {
  it('loads the bundled renderer in a packaged app despite an inherited dev URL', () => {
    const win = loadRenderer(true, 'http://localhost:5173');
    expect(win.loadURL).not.toHaveBeenCalled();
    expect(win.loadFile).toHaveBeenCalledWith('/fleet/out/renderer/index.html');
  });

  it('keeps the dev server URL available to an unpackaged app', () => {
    const win = loadRenderer(false, 'http://localhost:5173');
    expect(win.loadURL).toHaveBeenCalledWith('http://localhost:5173');
    expect(win.loadFile).not.toHaveBeenCalled();
  });

  it.each([true, false])('loads the bundle without a dev URL (packaged: %s)', isPackaged => {
    const win = loadRenderer(isPackaged);
    expect(win.loadURL).not.toHaveBeenCalled();
    expect(win.loadFile).toHaveBeenCalledWith('/fleet/out/renderer/index.html');
  });
});
