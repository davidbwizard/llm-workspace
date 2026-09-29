import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

// Counts how often reply Markdown is parsed. Re-parsing every reply on every
// window update was measured at ~70% of the window's CPU (2026-09-29).
const parses = vi.hoisted(() => ({ n: 0 }));
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => { parses.n += 1; return <p>{children}</p>; },
}));

import { MarkdownText } from '../../src/renderer/components/ConversationView.tsx';

describe('MarkdownText', () => {
  it('does not parse unchanged text again when its parent re-renders', () => {
    const { rerender } = render(<div><MarkdownText text="Hello **there**" /></div>);
    const first = parses.n;
    rerender(<div data-tick="1"><MarkdownText text="Hello **there**" /></div>);
    expect(parses.n).toBe(first);
    rerender(<div data-tick="2"><MarkdownText text="Changed" /></div>);
    expect(parses.n).toBe(first + 1);
  });
});
