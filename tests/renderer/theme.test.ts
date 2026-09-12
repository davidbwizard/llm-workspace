import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const THEME_PATH = 'src/renderer/theme.css';
const themeDir = dirname(THEME_PATH);

// Comments in this file quote selectors and family names to explain them
// (e.g. the duplicated-light-palette comment names ':root[data-theme="light"]'
// verbatim). Left in place, an assertion below could match the comment
// instead of the rule it describes -- passing even if the real rule were
// broken or removed. Strip them so every assertion here matches only text
// that actually takes effect, the same defect and the same fix as
// tests/main/security.test.ts.
const css = readFileSync(THEME_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Pulls every `@font-face { ... }` block whose font-family matches `family`
 *  exactly (not merely a substring of some other declaration). */
function fontFaceBlocks(family: string): string[] {
  const blocks = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  const nameRe = new RegExp(`font-family:\\s*["']${family}["']\\s*;`);
  return blocks.filter((b) => nameRe.test(b));
}

/** Extracts every `url(...)` reference inside a font-face block, unquoted. */
function srcUrls(block: string): string[] {
  return [...block.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]!);
}

/** Parses `--token: value;` pairs out of a single unnested `{ ... }` block. */
function parseTokens(block: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    tokens[m[1]!] = m[2]!.trim();
  }
  return tokens;
}

/** Extracts the `{ ... }` body that immediately follows the first match of
 *  `selector` in the CSS. Assumes no nested braces inside the block, which
 *  holds for plain token-declaration blocks. */
function blockAfter(selector: string): string {
  const idx = css.indexOf(selector);
  expect(idx, `selector not found: ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

/** The design doc's rules, asserted rather than trusted. The sepia incident
 *  came from warming several layers at once; these keep the structure that
 *  prevents it. */
describe('theme tokens', () => {
  it('declares every token in the bare :root before any override', () => {
    // Matched on the parsed token name, not a substring of the raw text:
    // '--accent' is a substring of '--accent-soft', so a plain toContain(t)
    // here would still pass with --accent deleted as long as --accent-soft
    // (the decoy) is still declared. Same collision for --signal, --critical,
    // --ink and --line against their own '-soft'/'-2' siblings.
    const bare = css.slice(0, css.search(/@media|:root\[data-theme/));
    const bareTokens = Object.keys(parseTokens(bare));
    for (const t of ['--ground','--surface','--raised','--line','--line-soft',
                     '--ink','--ink-2','--muted','--faint','--accent','--signal',
                     '--critical','--ok','--ag-blue','--ag-red'])
      expect(bareTokens, `${t} must exist in bare :root`).toContain(t);
  });

  it('guards the light media query so an explicit dark choice wins', () => {
    expect(css).toMatch(/@media \(prefers-color-scheme: light\)[\s\S]*?:root:not\(\[data-theme="dark"\]\)/);
  });

  it('redefines tokens under an explicit light choice too', () => {
    expect(css).toMatch(/:root\[data-theme="light"\]/);
  });

  it('declares the same token set, with the same values, in both light blocks', () => {
    const mediaBlock = parseTokens(blockAfter(':root:not([data-theme="dark"])'));
    const explicitBlock = parseTokens(blockAfter(':root[data-theme="light"]'));
    expect(Object.keys(mediaBlock).sort()).toEqual(Object.keys(explicitBlock).sort());
    expect(mediaBlock).toEqual(explicitBlock);
  });

  it('paints the body from a token, never transparent', () => {
    expect(css).toMatch(/body\s*\{[^}]*background:\s*var\(--ground\)/);
  });

  it('uses the chosen faces', () => {
    expect(css).toContain('Fraunces');
    expect(css).toContain('Karla');
    expect(css).toContain('IBM Plex Mono');
  });

  it('ships each face as a local @font-face, not just a fallback-stack name', () => {
    for (const family of ['Fraunces', 'Karla', 'IBM Plex Mono']) {
      const blocks = fontFaceBlocks(family);
      expect(blocks.length, `expected an @font-face for "${family}"`).toBeGreaterThan(0);

      const urls = blocks.flatMap(srcUrls);
      expect(urls.length, `expected a src url() for "${family}"`).toBeGreaterThan(0);
      for (const url of urls) {
        // Must be a local path, not a CDN -- CSP is default-src 'self'.
        expect(url, `"${family}" src must not be a remote URL`).not.toMatch(/^[a-z]+:\/\//i);

        // Must resolve to a real file. This is what makes the assertion
        // fail if @fontsource-variable/fraunces, @fontsource-variable/karla
        // or @fontsource/ibm-plex-mono is uninstalled: the CSS text alone
        // can't prove a font actually loads, but the file it points at can.
        const resolved = resolve(themeDir, url);
        expect(existsSync(resolved), `"${family}" src does not resolve to a file: ${resolved}`).toBe(true);
      }
    }
  });

  it('pushes Fraunces to its SOFT and WONK axes via a token, not a literal', () => {
    const bare = css.slice(0, css.search(/@media|:root\[data-theme/));
    const bareTokens = parseTokens(bare);
    expect(bareTokens['--f-display-fx'], '--f-display-fx must exist in bare :root')
      .toBe('"SOFT" 100, "WONK" 1');
    // .display, not just h1/h2/h3, so a non-heading element (a project name,
    // say) can opt in without being a heading tag. Consumes the token via
    // var() -- a rule that repeated the literal here would still pass this
    // test's first half while drifting from --f-display-fx unnoticed.
    expect(css).toMatch(/\.display[^{]*\{[^}]*font-variation-settings:\s*var\(--f-display-fx\)/);
  });

  it('disables transitions under reduced motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  // Fix-wave item 4: ReplyPopover.css and SessionCard.css each hardcoded
  // their own raw shadow hex against the "existing tokens only" constraint.
  //
  // Fix-wave item 2 (whole-branch review), correcting item 4's own fix:
  // ReplyPopover and SessionCard's hover never rendered the SAME shadow
  // (0 8px 20px #0009 vs 0 3px 16px rgba(0,0,0,.22) -- different blur, and
  // about a third the alpha) -- one shared token collapsed onto
  // ReplyPopover's value made the card hover materially darker than it had
  // ever been, regressing the most-looked-at surface in the app. Two
  // tokens now, each pinned to the value ITS OWN rule already rendered.
  it('gives the popover and the card hover lift their own elevation tokens, pinned to what each already rendered -- not one shared value', () => {
    const bare = css.slice(0, css.search(/@media|:root\[data-theme/));
    const bareTokens = parseTokens(bare);
    expect(bareTokens['--shadow-pop']).toBe('0 8px 20px rgba(0,0,0,.6)');
    expect(bareTokens['--shadow-card-hover']).toBe('0 3px 16px rgba(0,0,0,.22)');

    const popover = readFileSync('src/renderer/components/ReplyPopover.css', 'utf8');
    const card = readFileSync('src/renderer/components/SessionCard.css', 'utf8');
    expect(popover).toMatch(/box-shadow:\s*var\(--shadow-pop\)/);
    expect(card).toMatch(/box-shadow:\s*var\(--shadow-card-hover\)/);
    // Neither the wrong token nor the raw hardcoded value it replaced.
    expect(popover).not.toMatch(/box-shadow:\s*var\(--shadow-card-hover\)/);
    expect(card).not.toMatch(/box-shadow:\s*var\(--shadow-pop\)/);
    expect(popover).not.toContain('#0009');
    expect(card).not.toContain('rgba(0,0,0,.22)');
  });
});
