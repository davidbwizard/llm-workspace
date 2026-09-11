import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** These are not style checks. A renderer with node integration, or a preload
 *  that forwards arbitrary channels, turns untrusted transcript text into
 *  remote code execution (spec §11.1). Asserting on source is deliberate:
 *  these must fail loudly in review, not at runtime. */
describe('renderer security posture', () => {
  const main = readFileSync('src/main/index.ts', 'utf8');
  const preload = readFileSync('src/preload/index.ts', 'utf8');

  it('enables context isolation', () => expect(main).toMatch(/contextIsolation:\s*true/));
  it('disables node integration', () => expect(main).toMatch(/nodeIntegration:\s*false/));
  it('enables the sandbox', () => expect(main).toMatch(/sandbox:\s*true/));
  it('denies new windows', () => expect(main).toMatch(/setWindowOpenHandler/));
  it('blocks navigation', () => {
    // will-navigate alone only covers main-frame, user-initiated navigation --
    // will-frame-navigate (subframes) and will-redirect (server redirects)
    // close the other two gaps (spec §11.1).
    expect(main).toMatch(/will-navigate/);
    expect(main).toMatch(/will-frame-navigate/);
    expect(main).toMatch(/will-redirect/);
  });

  it('exposes no generic invoke from the preload', () => {
    expect(preload).not.toMatch(/ipcRenderer\.invoke\(\s*channel/);
    expect(preload).not.toMatch(/\.\.\.args/);
  });

  it('exposes only the enumerated channels', () => {
    const exposed = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]);
    expect(exposed.sort()).toEqual(['fleet:list']);
  });
});
