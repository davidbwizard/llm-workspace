import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Icon, type IconName } from '../../src/renderer/components/Icon.tsx';

/** Every name the component is expected to support. Kept here as a literal
 *  list, typed against IconName, so the ICONS map in Icon.tsx cannot rename
 *  or drop a key without this file failing to typecheck. */
const NAMES: readonly IconName[] = ['bell', 'spinner', 'terminal', 'warning'];

describe('Icon', () => {
  it.each(NAMES)('renders an svg element for "%s"', (name) => {
    const { container } = render(<Icon name={name} />);
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('maps every name to a distinct glyph', () => {
    // Guards against two names pointing at the same Phosphor component --
    // each would still render a valid svg, so the check above alone
    // wouldn't catch a wrong-glyph assignment.
    const markup = NAMES.map((name) => render(<Icon name={name} />).container.innerHTML);
    expect(new Set(markup).size).toBe(NAMES.length);
  });
});
