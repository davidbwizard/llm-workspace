import { expect, it } from 'vitest';
import { parseRemoteConfig } from '../../src/main/remote/config.ts';
export const valid = { enabled: true, port: 43180, origin: 'https://mac.tail123.ts.net', login: 'owner@example.com', previews: [] };
it('defaults to disabled and validates private settings strictly', () => {
  expect(parseRemoteConfig(undefined).enabled).toBe(false);
  expect(parseRemoteConfig(valid)).toEqual(valid);
  for (const change of [{ port: 0 }, { port: 65536 }, { origin: 'http://mac.tail123.ts.net' }, { origin: 'https://public.com' }, { origin: valid.origin + '/path' }, { login: '' }, { bind: '0.0.0.0' }]) expect(() => parseRemoteConfig({ ...valid, ...change })).toThrow();
});
it('rejects same-origin, foreign-host and duplicate preview mappings', () => {
  const preview = { id: 'site', project: '/tmp', label: 'Site', localPort: 3000, url: valid.origin + ':8443' };
  expect(parseRemoteConfig({ ...valid, previews: [preview] }).previews).toHaveLength(1);
  for (const url of [valid.origin, 'https://evil.ts.net:8443', 'javascript:alert(1)', valid.origin + ':8443/?x=1']) expect(() => parseRemoteConfig({ ...valid, previews: [{ ...preview, url }] })).toThrow();
  expect(() => parseRemoteConfig({ ...valid, previews: [preview, { ...preview, id: 'other' }] })).toThrow();
});
it('validates paired managed preview fields and reserves the gateway port', () => {
  const preview = { id: 'site', project: '/tmp', label: 'Site', localPort: 3000, url: valid.origin + ':8443', managed: true, localHost: '::1' };
  expect(parseRemoteConfig({ ...valid, previews: [preview] }).previews[0]).toEqual(preview);
  for (const change of [{ managed: false }, { managed: undefined }, { localHost: undefined }, { localHost: '0.0.0.0' }, { localPort: 43181 }]) expect(() => parseRemoteConfig({ ...valid, previews: [{ ...preview, ...change }] })).toThrow();
  expect(() => parseRemoteConfig({ ...valid, port: 65535, previews: [{ ...preview, localPort: 65534 }] })).toThrow();
});
