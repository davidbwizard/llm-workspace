// Use the workspace's existing Vitest; keep its temporary config/cache local.
export default { cacheDir: '.cache/vite', test: { globals: true, environment: 'node', include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'], environmentMatchGlobs: [['tests/*ui.test.ts', 'jsdom']] } };
