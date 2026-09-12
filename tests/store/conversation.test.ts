import { describe, it, expect } from 'vitest';
import { unwrapSlashCommand } from '../../src/store/conversation.ts';

describe('unwrapSlashCommand', () => {
  it('reduces a slash-command wrapper to the command the user actually typed', () => {
    const raw = '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>';
    expect(unwrapSlashCommand(raw)).toBe('/clear');
  });

  it('keeps the arguments when there are some', () => {
    const raw = '<command-name>/loop</command-name><command-args>5m /foo</command-args>';
    expect(unwrapSlashCommand(raw)).toBe('/loop 5m /foo');
  });

  it('leaves ordinary prose completely alone', () => {
    expect(unwrapSlashCommand('run the farm tests')).toBe('run the farm tests');
    expect(unwrapSlashCommand('use <angle brackets> in prose')).toBe('use <angle brackets> in prose');
  });

  it('returns empty for a wrapper with no command name, rather than leaking markup', () => {
    expect(unwrapSlashCommand('<command-message>x</command-message>')).toBe('');
  });

  // The test above passes even without the `name === ''` guard, because its
  // input also has empty args -- the final ternary already falls back to
  // `name` (empty) in that case. The guard only matters when name is empty
  // but args is not; without it this would leak a leading-space fragment
  // instead of the required empty string.
  it('returns empty rather than a bare-args fragment when the name is missing', () => {
    expect(unwrapSlashCommand('<command-args>foo</command-args>')).toBe('');
  });
});
