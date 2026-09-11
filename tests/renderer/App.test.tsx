import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from '../../src/renderer/App.tsx';

function Boom(): never {
  throw new Error('kaboom');
}

describe('ErrorBoundary', () => {
  it('renders a specific message instead of a blank window when a child throws', () => {
    // React logs a caught render error to console.error by default, on top
    // of calling componentDidCatch -- expected noise for this test, not a
    // real warning, so it's suppressed rather than left to clutter output.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(<ErrorBoundary><Boom /></ErrorBoundary>);
    // Scoped to the message paragraph specifically -- the stack trace
    // rendered below it (next test) also contains "kaboom" (the error's
    // own first stack line), so a page-wide text search would ambiguously
    // match both.
    expect(container.querySelector('p')?.textContent).toMatch(/kaboom/);
    consoleError.mockRestore();
  });

  // The bug this fixes: componentDidCatch used to be empty, so a render
  // throw produced the symptom (this message) with no way to find WHERE it
  // happened short of re-attaching devtools to a window that may already
  // be gone. Both halves of the fix are asserted here: a record a person
  // can find without devtools (console.error), and one visible in the
  // window itself (the rendered stack).
  it('records the error and component stack, and shows the stack on screen', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(<ErrorBoundary><Boom /></ErrorBoundary>);

    expect(consoleError).toHaveBeenCalledWith(
      'FleetView render crashed:', expect.any(Error), expect.stringContaining('Boom'));

    const stack = container.querySelector('.crash-stack');
    expect(stack).toBeTruthy();
    expect(stack!.textContent).toMatch(/kaboom/);   // Error#stack's own first line
    expect(stack!.textContent).toMatch(/at Boom/);  // the component stack

    consoleError.mockRestore();
  });
});
