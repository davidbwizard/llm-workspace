import { describe, it, expect } from 'vitest';
import { abbreviateHome } from '../../src/renderer/pathFormat.ts';

// MainPane's header shows the session's cwd; David's own bug report against
// the real, running window asked for the home folder abbreviated to "~"
// (e.g. "~/Documents/David/llm-workspace"). The renderer never learns the
// real machine's home directory (no IPC for it, deliberately -- see this
// function's own doc comment), so this matches the recognisable home-
// directory SHAPE already present in the cwd string itself.
describe('abbreviateHome', () => {
  it.each([
    ['/Users/davidbrabbins/Documents/David/llm-workspace', '~/Documents/David/llm-workspace'],
    ['/Users/davidbrabbins', '~'], // the home directory itself, no trailing segment
    ['/home/david/projects/foo', '~/projects/foo'], // Linux shape
    ['/tmp/foo', '/tmp/foo'], // not home-shaped -- left alone, not guessed at
    ['/a', '/a'], // the short fixture path every other MainPane test uses
    ['/Userspace/oops', '/Userspace/oops'], // "Users" without the slash boundary must not match
  ])('formats %s as %s', (path, expected) => {
    expect(abbreviateHome(path)).toBe(expected);
  });
});
