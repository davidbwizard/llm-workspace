import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const CONFIG_PATH = 'vitest.config.ts';
const TESTS_DIR = 'tests';

/** Pulls the quoted glob strings out of `test.include` in vitest.config.ts.
 *  Not a general glob parser -- just enough to read what vitest is actually
 *  told to collect. */
function includeGlobs(): string[] {
  const src = readFileSync(CONFIG_PATH, 'utf8');
  const m = src.match(/include:\s*\[([^\]]*)\]/);
  expect(m, 'vitest.config.ts must declare test.include as an array').not.toBeNull();
  return [...m![1]!.matchAll(/['"]([^'"]+)['"]/g)].map((g) => g[1]!);
}

/** The file extension (".ts", ".tsx", ...) each `*.test.<ext>` include glob
 *  covers. This is the one property that matters: Task 8 discovered
 *  `.tsx` test files were silently never collected because the include
 *  list only had `*.test.ts` -- the suite reported green while those files
 *  sat inert. Reimplementing glob matching would be its own source of
 *  bugs; checking which extension each glob targets is enough to catch
 *  that exact failure mode again if it recurs. */
function coveredExtensions(globs: string[]): Set<string> {
  const exts = new Set<string>();
  for (const g of globs) {
    const m = g.match(/\*\.test\.([a-z0-9]+)$/i);
    if (m) exts.add(`.${m[1]!.toLowerCase()}`);
  }
  return exts;
}

/** Every `*.test.*` file under `dir`, recursively. */
function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...testFiles(full));
    } else if (/\.test\.[^./]+$/i.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('test collection', () => {
  it('collects every tests/**/*.test.* file under an extension vitest.config.ts includes', () => {
    const exts = coveredExtensions(includeGlobs());
    expect(exts.size, 'no *.test.<ext> glob found in vitest.config.ts include').toBeGreaterThan(0);

    for (const file of testFiles(TESTS_DIR)) {
      expect(
        exts.has(extname(file).toLowerCase()),
        `${file} has an extension vitest.config.ts does not collect (collected: ${[...exts].join(', ')})`,
      ).toBe(true);
    }
  });
});
