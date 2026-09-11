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
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByText(/kaboom/)).toBeTruthy();
    consoleError.mockRestore();
  });
});
