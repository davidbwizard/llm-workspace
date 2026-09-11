import { describe, it, expect } from 'vitest';
import { projectKey, legacyProjectKey } from '../../../src/providers/claude/projectKey.ts';

describe('projectKey', () => {
  it('dashes every non-alphanumeric character, leading slash included', () => {
    expect(projectKey('/Users/me/app')).toBe('-Users-me-app');
  });

  it('dashes dots too — this is the change that silently broke the old resolver', () => {
    expect(projectKey('/Users/me/MDv0.3.0')).toBe('-Users-me-MDv0-3-0');
  });

  it('matches a real directory on this machine', () => {
    expect(projectKey('/Users/davidbrabbins/Documents/David/llm-workspace'))
      .toBe('-Users-davidbrabbins-Documents-David-llm-workspace');
  });
});

describe('legacyProjectKey', () => {
  it('drops the leading slash and preserves dots', () => {
    expect(legacyProjectKey('/Users/me/MDv0.3.0')).toBe('Users-me-MDv0.3.0');
  });
});
