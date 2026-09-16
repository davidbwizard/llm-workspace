import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Bell, CircleNotch, Gear, Terminal, Warning } from '@phosphor-icons/react';
import { Icon, type IconName } from '../../src/renderer/components/Icon.tsx';

/** The Phosphor component each name is expected to resolve to, imported
 *  independently of Icon.tsx's own ICONS map (which isn't exported). Pinned
 *  by comparing rendered markup rather than reference identity -- Phosphor's
 *  output has no per-render randomness (no generated ids), so two renders of
 *  the same component with the same props are byte-identical, and two
 *  different icons are never byte-identical. This catches a name pointing at
 *  the wrong glyph, not just two names collapsing onto the same one. */
const EXPECTED = { bell: Bell, gear: Gear, spinner: CircleNotch, terminal: Terminal, warning: Warning } as const;

const NAMES: readonly IconName[] = ['bell', 'gear', 'spinner', 'terminal', 'warning'];

describe('Icon', () => {
  it.each(NAMES)('renders an svg element for "%s"', (name) => {
    const { container } = render(<Icon name={name} />);
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it.each(NAMES)('pins "%s" to its expected Phosphor glyph', (name) => {
    const actual = render(<Icon name={name} />).container.innerHTML;
    const Expected = EXPECTED[name];
    const expected = render(
      <Expected size={14} weight="regular" aria-hidden="true" />
    ).container.innerHTML;
    expect(actual).toBe(expected);
  });

  it('is hidden from assistive tech, since the label is adjacent text', () => {
    const { container } = render(<Icon name="bell" />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});
