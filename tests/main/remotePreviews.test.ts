import { expect, it } from 'vitest';
import { previewsForProject } from '../../src/main/remote/previews.ts';
const config = { enabled: true, port: 43180, origin: 'https://mac.tail.ts.net', login: 'owner', previews: [{ id: 'p', project: '/private/tmp', label: 'Site', localPort: 3000, url: 'https://mac.tail.ts.net:8443' }] };
it('returns only the canonical selected project and checks availability', async () => {
  expect(await previewsForProject(config, '/tmp', async () => true)).toEqual([{ id: 'p', label: 'Site', url: 'https://mac.tail.ts.net:8443', available: true }]);
  expect(await previewsForProject(config, '/does-not-exist', async () => true)).toEqual([]);
  expect((await previewsForProject(config, '/tmp', async () => false))[0]?.available).toBe(false);
});
