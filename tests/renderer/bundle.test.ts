import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// A renderer file that imports a runtime VALUE out of src/main pulls that
// module's whole graph into the renderer bundle -- and src/main modules
// import node:child_process, node:fs and node:os. Vite externalises those
// for the browser and the build then dies with something that names none of
// this:
//
//   "join" is not exported by "__vite-browser-external", imported by
//   src/hooks/install.ts
//
// Neither `tsc --noEmit` nor vitest catches it: TypeScript does not care
// which process a module ends up in, and vitest runs the renderer under
// node, where node: imports resolve perfectly well. The only thing that
// catches it is `npm run dist:mac`, which is the slowest and least frequent
// check there is -- and on 2026-09-21 it caught exactly this, after the
// suite and the typecheck had both gone green.
//
// So the rule the app already keeps everywhere else is asserted here: the
// renderer imports TYPES from src/main, and runtime values only from
// node-free modules under src/core.
const RENDERER = 'src/renderer';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(full) ? [full] : [];
  });
}

/** Comments in this codebase routinely contain the word "import" while
 *  explaining an import, and the matcher below spans newlines -- so a
 *  comment would otherwise be swallowed into the clause and read as a value
 *  import. Stripped first, the same way tests/main/security.test.ts strips
 *  before asserting on source. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

/** Every `import ... from '<spec>'` statement in `src`, as [clause, spec]. */
function imports(src: string): { clause: string; spec: string }[] {
  return [...strip(src).matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)]
    .map(m => ({ clause: m[1]!, spec: m[2]! }));
}

describe('the renderer bundle stays free of main-process modules', () => {
  const files = sourceFiles(RENDERER);

  it('finds the renderer sources at all', () => {
    // Guards the guard: a glob that silently matches nothing would make
    // every assertion below pass for the wrong reason.
    expect(files.length).toBeGreaterThan(20);
  });

  it('imports only types from src/main', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const { clause, spec } of imports(readFileSync(file, 'utf8'))) {
        if (!/(^|\/)main\//.test(spec)) continue;
        // `import type { ... }` erases entirely. Anything else -- a bare
        // specifier, or a mixed clause with even one value in it -- keeps
        // the module in the graph.
        if (!clause.trimStart().startsWith('type ')) offenders.push(`${file}: ${clause} from '${spec}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('imports nothing from node: directly', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const { spec } of imports(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('node:')) offenders.push(`${file}: '${spec}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('imports nothing from src/hooks or src/store, which are main-only', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const { clause, spec } of imports(readFileSync(file, 'utf8'))) {
        if (!/(^|\/)(hooks|store|discovery|watch)\//.test(spec)) continue;
        if (!clause.trimStart().startsWith('type ')) offenders.push(`${file}: ${clause} from '${spec}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The module that exists precisely so the renderer has somewhere to get
  // shared install advice from as a runtime value.
  it('keeps src/core/install.ts free of node imports', () => {
    const src = readFileSync('src/core/install.ts', 'utf8');
    expect(src).not.toMatch(/from\s+['"]node:/);
  });

  // The session-name rules exist as their own module for exactly this
  // reason: LaunchBar needs SESSION_NAME_SAFE as a runtime value, and the
  // obvious home for it -- identity.ts, beside SESSION_ID_SAFE -- imports
  // node:crypto. Folding these constants back in there would break the
  // renderer build and nothing else would say so.
  it('keeps src/core/sessionName.ts free of node imports', () => {
    const src = readFileSync('src/core/sessionName.ts', 'utf8');
    expect(src).not.toMatch(/from\s+['"]node:/);
  });
});
