import { expect, it } from 'vitest';
import { parseLocalPreviewUrl } from '../../src/core/preview.ts';

it.each(['localhost', '127.0.0.1', '[::1]'])('recognises explicit HTTP loopback links for %s and preserves their destination', host => {
  expect(parseLocalPreviewUrl(`http://${host}:5199/game?level=2#play`)).toEqual({ port: 5199, path: '/game?level=2#play' });
});
it.each([null, {}, '', 'http://localhost/', 'https://localhost:5199/', 'http://localhost:80/',
  'http://localhost:65536/', 'http://localhost:5199@evil.test/', 'http://user@localhost:5199/',
  'http://127.1:5199/', 'http://2130706433:5199/', 'http://localhost.evil.test:5199/',
  'http://0.0.0.0:5199/', 'http://192.168.1.1:5199/', 'http://localhost:5199/\n',
  'http://localhost:5199\\@evil.test/', 'file:///tmp/site'])('rejects unsupported or ambiguous preview address %j', value => {
  expect(parseLocalPreviewUrl(value)).toBeNull();
});
