import { describe, it, expect } from 'vitest';
import { hashRecord } from '../../src/core/identity.ts';

describe('hashRecord', () => {
  it('is stable for identical input', () => {
    expect(hashRecord('{"a":1}')).toBe(hashRecord('{"a":1}'));
  });

  it('differs when a single byte changes', () => {
    expect(hashRecord('{"a":1}')).not.toBe(hashRecord('{"a":2}'));
  });

  it('returns lowercase hex', () => {
    expect(hashRecord('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});
