import { it, expect, afterEach } from 'vitest';
import { createFarmServer } from '../farm/serve.mjs';
import { ART } from '../farm/art.mjs';
const servers = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
it('serves an isolated game and its explicit modules, with the original HTTP protections', async () => {
  const server = createFarmServer(); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('data-farm-app');
  expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
  for (const filename of ['app.mjs', 'style.css', 'scene.mjs', 'art.mjs', 'sessions.mjs', 'storage.mjs', 'definitions.mjs', 'validation.mjs', 'world.mjs', 'combat-view.mjs']) {
    expect((await fetch(`${base}/farm/${filename}`)).status, filename).toBe(200);
  }
  const module = await fetch(`${base}/farm/model.mjs`);
  expect(module.status).toBe(200); expect(module.headers.get('content-type')).toMatch(/javascript/);
  expect(await (await fetch(`${base}/farm/CONTRACT.md`)).text()).not.toContain('Standalone farm contracts');
  expect((await fetch(`${base}/farm/../assets-manifest.json`)).status).toBe(404);
  expect((await fetch(`${base}/farm/model.mjs`, { headers: { origin: 'https://attacker.example' } })).status).toBe(403);
  expect((await fetch(`${base}/farm/model.mjs`, { method: 'POST' })).status).toBe(405);
  const api = await (await fetch(`${base}/api/assets?q=Parsnip&limit=1`)).json();
  expect(api.items).toHaveLength(1);
  expect((await fetch(`${base}/images/${api.items[0].id}.png`)).status).toBe(200);
  for (const art of Object.values(ART)) {
    const response = await fetch(`${base}/api/assets?q=${encodeURIComponent(art.path)}&limit=12`);
    const catalog = await response.json();
    const asset = catalog.items.find(item => item.location === `Farm RPG - Tiny Asset Pack - (All in One)/${art.path}`);
    expect(asset, art.path).toBeDefined();
    const image = await fetch(`${base}/images/${asset.id}.png`);
    expect(image.status, art.path).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
  }
});
