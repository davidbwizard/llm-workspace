import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { StatusIcon } from '../../src/renderer/components/StatusIcon.tsx';
import type { Activity } from '../../src/fleet/state.ts';

/** The shape each activity is drawn as (status row, variant A). The point
 *  of the set is that no two states are told apart by HUE alone -- a
 *  reader who cannot separate the warm tones still has a different shape
 *  to go on -- so these assertions are about geometry, not colour. */
describe('StatusIcon', () => {
  const shapeOf = (activity: Activity) => {
    const { container } = render(<StatusIcon activity={activity} />);
    return container.querySelector('svg')!;
  };

  it('draws working as a BROKEN ring -- a dashed stroke, no fill', () => {
    const c = shapeOf('working').querySelector('circle')!;
    expect(c.getAttribute('fill')).toBe('none');
    expect(c.getAttribute('stroke-dasharray')).toBeTruthy();
  });

  it('draws idle as a HOLLOW ring -- unbroken stroke, no fill', () => {
    const c = shapeOf('idle').querySelector('circle')!;
    expect(c.getAttribute('fill')).toBe('none');
    expect(c.getAttribute('stroke-dasharray')).toBeNull();
  });

  // "Waiting on you" is the state that must never be missed, so it is the
  // only FILLED shape in the set -- a solid disc reads at a glance and at
  // a size where a stroke weight does not.
  it.each<Activity>(['waiting_permission', 'waiting_input'])(
    'draws %s as the one FILLED shape', (activity) => {
      const c = shapeOf(activity).querySelector('circle')!;
      expect(c.getAttribute('fill')).toBe('currentColor');
    });

  it('leaves the filled shape unique to waiting -- error is not filled', () => {
    const c = shapeOf('error').querySelector('circle')!;
    expect(c.getAttribute('fill')).toBe('none');
  });

  it('gives every activity its own distinct shape', () => {
    const outline = (a: Activity) => shapeOf(a).innerHTML;
    const shapes = (['working', 'idle', 'waiting_permission', 'error'] as Activity[]).map(outline);
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  // The icon is decoration: the word beside it carries the name (see
  // OpenSessionCard.test.tsx). An icon that announced itself too would
  // make a screen reader say the state twice.
  it('is hidden from assistive tech, because the word beside it is not', () => {
    expect(shapeOf('working').getAttribute('aria-hidden')).toBe('true');
  });

  it('inherits its colour, so .state.<activity> owns the hue', () => {
    const c = shapeOf('idle').querySelector('circle')!;
    expect(c.getAttribute('stroke')).toBe('currentColor');
  });
});
