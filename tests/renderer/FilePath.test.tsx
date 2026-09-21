import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MarkdownText } from '../../src/renderer/components/ConversationView.tsx';
import { FileLinkContext, findPaths, clearFileProbeCache } from '../../src/renderer/components/FilePath.tsx';

const PID = 4821;

function setProbe(kinds: Record<string, 'markdown' | 'other'>) {
  const fileProbe = vi.fn(async (_pid: number, candidates: string[]) =>
    ({ ok: true as const, kinds: candidates.map(c => kinds[c] ?? null) }));
  const fileOpen = vi.fn(async () => ({ ok: true as const, action: 'revealed' as const, path: '/x', name: 'x' }));
  (globalThis as unknown as { window: { fleet: unknown } }).window.fleet = { fileProbe, fileOpen };
  return { fileProbe, fileOpen };
}

function renderMd(text: string, onOpen = vi.fn()) {
  render(
    <FileLinkContext.Provider value={{ pid: PID, onOpen }}>
      <MarkdownText text={text} />
    </FileLinkContext.Provider>,
  );
  return onOpen;
}

beforeEach(() => { clearFileProbeCache(); });

describe('findPaths', () => {
  const texts = (s: string) => findPaths(s).map(p => p.text);

  it('finds a path with directory separators', () => {
    expect(texts('see src/main/ipc.ts for the note')).toEqual(['src/main/ipc.ts']);
  });

  it('keeps a trailing line number in the visible text', () => {
    expect(texts('the comment at src/renderer/components/ConversationView.tsx:22 says so'))
      .toEqual(['src/renderer/components/ConversationView.tsx:22']);
    expect(texts('at ipc.ts:504:12.')).toEqual(['ipc.ts:504:12']);
  });

  it('finds a bare filename that carries an extension', () => {
    expect(texts('written up in KNOWN_ISSUES.md with what I ruled out')).toEqual(['KNOWN_ISSUES.md']);
  });

  it('drops the sentence\'s own full stop', () => {
    expect(texts('recorded in KNOWN_ISSUES.md.')).toEqual(['KNOWN_ISSUES.md']);
    expect(texts('see src/main/ipc.ts, then stop')).toEqual(['src/main/ipc.ts']);
  });

  it('leaves ordinary prose alone', () => {
    expect(texts('Recorded both the shipped part and the loose end.')).toEqual([]);
    expect(texts('e.g. i.e. etc. vs. a.m.')).toEqual([]);
    expect(texts('version 1.2 of the thing')).toEqual([]);
  });

  it('does not pick a path out of the middle of a URL', () => {
    expect(texts('https://example.com/a/b.md is a link')).toEqual([]);
  });

  it('reports offsets that exactly cover the match', () => {
    const s = 'open src/a.md now';
    const [hit] = findPaths(s);
    expect(hit).toBeTruthy();
    expect(s.slice(hit!.start, hit!.end)).toBe('src/a.md');
  });

  it('ignores a candidate longer than the channel would accept', () => {
    expect(texts(`a/${'b'.repeat(2000)}.md`)).toEqual([]);
  });
});

describe('paths in a reply', () => {
  it('turns a path that resolves into a button', async () => {
    setProbe({ 'KNOWN_ISSUES.md': 'markdown' });
    renderMd('Recorded in KNOWN_ISSUES.md with what I ruled out.');
    await waitFor(() => expect(screen.getByRole('button', { name: /KNOWN_ISSUES\.md/ })).toBeTruthy());
  });

  it('leaves a path that does not resolve as plain text, not a dead link', async () => {
    const { fileProbe } = setProbe({});
    renderMd('Recorded in GONE.md with what I ruled out.');
    await waitFor(() => expect(fileProbe).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/Recorded in GONE\.md/)).toBeTruthy());
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('asks main once for the whole reply, not once per path', async () => {
    const { fileProbe } = setProbe({ 'a/x.md': 'markdown', 'b/y.md': 'markdown' });
    renderMd('Both a/x.md and b/y.md changed.');
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(2));
    expect(fileProbe).toHaveBeenCalledTimes(1);
    expect(fileProbe.mock.calls[0]![1]).toEqual(['a/x.md', 'b/y.md']);
  });

  it('proposes the path without its line number, and shows it with one', async () => {
    const { fileProbe } = setProbe({ 'src/main/ipc.ts': 'markdown' });
    const onOpen = renderMd('the note at src/main/ipc.ts:504 says so');
    await waitFor(() => expect(fileProbe).toHaveBeenCalled());
    expect(fileProbe.mock.calls[0]![1]).toEqual(['src/main/ipc.ts']);
    const button = await screen.findByRole('button', { name: /src\/main\/ipc\.ts:504/ });
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledWith('src/main/ipc.ts');
  });

  it('links a path written as an inline code span', async () => {
    setProbe({ 'src/main/ipc.ts': 'markdown' });
    renderMd('the note at `src/main/ipc.ts` says so');
    await waitFor(() => expect(screen.getByRole('button', { name: 'src/main/ipc.ts' })).toBeTruthy());
  });

  it('leaves a fenced code block alone, so its Copy button still copies code', async () => {
    const { fileProbe } = setProbe({ 'src/main/ipc.ts': 'markdown' });
    renderMd('```\nread src/main/ipc.ts\n```');
    await waitFor(() => expect(screen.getByText(/read src\/main\/ipc\.ts/)).toBeTruthy());
    // The reply's own Copy button is the only button in a fenced block.
    expect(screen.queryByRole('button', { name: /src\/main\/ipc\.ts/ })).toBeNull();
    expect(fileProbe).not.toHaveBeenCalled();
  });

  it('leaves the text of a markdown link alone', async () => {
    const { fileProbe } = setProbe({ 'docs/a.md': 'markdown' });
    renderMd('[docs/a.md](https://example.com)');
    await waitFor(() => expect(screen.getByRole('link')).toBeTruthy());
    expect(fileProbe).not.toHaveBeenCalled();
  });

  it('renders as plain text with no session behind the pane', async () => {
    const { fileProbe } = setProbe({ 'a/x.md': 'markdown' });
    render(<MarkdownText text="see a/x.md" />);
    await waitFor(() => expect(screen.getByText(/see a\/x\.md/)).toBeTruthy());
    expect(screen.queryByRole('button')).toBeNull();
    expect(fileProbe).not.toHaveBeenCalled();
  });

  it('says what a click will do, so Finder is never a surprise', async () => {
    setProbe({ 'run.command': 'other', 'notes.md': 'markdown' });
    renderMd('either run.command or notes.md');
    const reveal = await screen.findByRole('button', { name: 'run.command' });
    const open = await screen.findByRole('button', { name: 'notes.md' });
    expect(reveal.getAttribute('title')).toMatch(/Finder/);
    expect(open.getAttribute('title')).toMatch(/^Open /);
  });

  it('keeps the reply plain text when the probe channel itself fails', async () => {
    const fileProbe = vi.fn().mockRejectedValue(new Error('bridge gone'));
    (globalThis as unknown as { window: { fleet: unknown } }).window.fleet = { fileProbe };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderMd('see a/x.md');
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.queryByRole('button')).toBeNull();
    spy.mockRestore();
  });
});
