import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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

  // This replaces 'leaves a fenced code block alone, so its Copy button
  // still copies code'. That behaviour is gone deliberately: measured over
  // 400 real transcripts, 118 .md mentions sat in fenced blocks and none
  // was clickable. The guarantee the old test really protected -- that the
  // block still copies verbatim -- is asserted below rather than dropped
  // with it.
  it('makes a path inside a fenced code block clickable', async () => {
    const { fileProbe } = setProbe({ 'src/main/ipc.ts': 'markdown' });
    renderMd('```\nread src/main/ipc.ts\n```');
    await waitFor(() => expect(screen.getByRole('button', { name: 'src/main/ipc.ts' })).toBeTruthy());
    expect(fileProbe).toHaveBeenCalled();
  });

  // The constraint that had to hold for the above to be allowed at all.
  it('still copies a fenced block verbatim, path text included', async () => {
    setProbe({ 'src/main/ipc.ts': 'markdown' });
    const source = 'read src/main/ipc.ts and then stop';
    renderMd('```\n' + source + '\n```');
    await waitFor(() => expect(screen.getByRole('button', { name: 'src/main/ipc.ts' })).toBeTruthy());
    // The Copy button reads textContent off the <pre>, which walks every
    // descendant -- so the path button contributes its own characters and
    // nothing is added, lost or reordered.
    const pre = document.querySelector('pre')!;
    expect(pre.textContent).toBe(source + '\n');
  });

  it('does not stop a drag selecting through a path in a block', async () => {
    setProbe({ 'src/main/ipc.ts': 'markdown' });
    renderMd('```\nread src/main/ipc.ts\n```');
    const btn = await screen.findByRole('button', { name: 'src/main/ipc.ts' });
    // `all: unset` plus an explicit user-select is what keeps the button
    // from behaving like a control mid-sentence; assert the declaration is
    // there rather than trusting the stylesheet by eye.
    const css = readFileSync('src/renderer/components/ConversationView.css', 'utf8');
    expect(css).toMatch(/pre \.fp \{[^}]*user-select:\s*text/s);
    expect(btn.tagName).toBe('BUTTON');
  });

  // This replaces 'leaves the text of a markdown link alone'. The link's
  // TEXT is still left alone -- that part has not changed -- but a link
  // whose target is a local path is now the path control, because Codex
  // emits nearly every file reference that way.
  it('leaves a link alone when its target is a web address', async () => {
    const { fileProbe } = setProbe({ 'docs/a.md': 'markdown' });
    renderMd('[docs/a.md](https://example.com)');
    await waitFor(() => expect(screen.getByRole('link')).toBeTruthy());
    expect(fileProbe).not.toHaveBeenCalled();
  });

  it('opens a markdown link whose target is a local path, keeping its label', async () => {
    const { fileProbe } = setProbe({ 'src/app.py': 'other' });
    const onOpen = renderMd('[app.py](src/app.py:12)');
    const btn = await screen.findByRole('button', { name: 'app.py' });
    // The label is the label; the target is what main is asked about, with
    // the line number stripped exactly as it is in prose.
    expect(fileProbe).toHaveBeenCalledWith(PID, ['src/app.py']);
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledWith('src/app.py');
    // And it is no longer an <a> the window would refuse to navigate to.
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('leaves an http target as a link even when it ends in .md', async () => {
    const { fileProbe } = setProbe({ 'setup.md': 'markdown' });
    renderMd('[setup](https://code.claude.com/docs/en/setup.md)');
    const a = await screen.findByRole('link');
    expect(a.getAttribute('href')).toBe('https://code.claude.com/docs/en/setup.md');
    expect(fileProbe).not.toHaveBeenCalled();
  });

  // grep prints `path:N:` for a matching line and `path-N-` for a context
  // line, and agents paste both. The first form already fell out of the
  // line-number suffix; this is its twin. Measured: 95 occurrences across 6
  // distinct files in a 400-transcript sample.
  it('cuts the suffix grep glues on for a context line', async () => {
    const { fileProbe } = setProbe({ 'docs/plan.md': 'markdown' });
    const onOpen = renderMd('docs/plan.md-2147-  some matching text');
    await waitFor(() => expect(fileProbe).toHaveBeenCalled());
    expect(fileProbe.mock.calls[0]![1]).toContain('docs/plan.md');
    fireEvent.click(await screen.findByRole('button', { name: /docs\/plan\.md/ }));
    expect(onOpen).toHaveBeenCalledWith('docs/plan.md');
  });

  it('leaves a name that merely contains a dash and digits alone', async () => {
    // The cut needs an extension before the -N-, so an ordinary filename
    // with digits in it is untouched.
    const { fileProbe } = setProbe({ 'docs/2026-09-18-plan.md': 'markdown' });
    renderMd('see docs/2026-09-18-plan.md');
    await waitFor(() => expect(fileProbe).toHaveBeenCalled());
    expect(fileProbe.mock.calls[0]![1]).toContain('docs/2026-09-18-plan.md');
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

// A cached miss used to outlive the file being created: an agent names a
// doc in a plan, writes it a minute later, and the path stayed plain text
// for the rest of the session. Hits are still kept for the window's life --
// a file that exists does not usually stop existing mid-session, and
// re-probing them would be pure churn.
describe('a miss goes stale, a hit does not', () => {
  beforeEach(() => { clearFileProbeCache(); vi.useRealTimers(); });

  it('asks again for a path that did not exist, once the answer is old', async () => {
    vi.useFakeTimers();
    let exists = false;
    const fileProbe = vi.fn(async (_pid: number, candidates: string[]) =>
      ({ ok: true as const, kinds: candidates.map(() => (exists ? 'markdown' as const : null)) }));
    (globalThis as unknown as { window: { fleet: unknown } }).window.fleet = { fileProbe };

    const { unmount } = render(
      <FileLinkContext.Provider value={{ pid: PID, onOpen: vi.fn() }}>
        <MarkdownText text="see docs/new.md" />
      </FileLinkContext.Provider>,
    );
    await vi.advanceTimersByTimeAsync(5);
    expect(fileProbe).toHaveBeenCalledTimes(1);

    // Still inside the window the miss is believed: a remount does not ask.
    unmount();
    render(
      <FileLinkContext.Provider value={{ pid: PID, onOpen: vi.fn() }}>
        <MarkdownText text="see docs/new.md" />
      </FileLinkContext.Provider>,
    );
    await vi.advanceTimersByTimeAsync(5);
    expect(fileProbe).toHaveBeenCalledTimes(1);

    // Past it, the file now exists, and the next mount asks again.
    exists = true;
    await vi.advanceTimersByTimeAsync(31_000);
    render(
      <FileLinkContext.Provider value={{ pid: PID, onOpen: vi.fn() }}>
        <MarkdownText text="see docs/new.md" />
      </FileLinkContext.Provider>,
    );
    await vi.advanceTimersByTimeAsync(5);
    expect(fileProbe).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('never re-asks for a path it has already found', async () => {
    vi.useFakeTimers();
    const fileProbe = vi.fn(async (_pid: number, candidates: string[]) =>
      ({ ok: true as const, kinds: candidates.map(() => 'markdown' as const) }));
    (globalThis as unknown as { window: { fleet: unknown } }).window.fleet = { fileProbe };

    for (let i = 0; i < 3; i++) {
      const { unmount } = render(
        <FileLinkContext.Provider value={{ pid: PID, onOpen: vi.fn() }}>
          <MarkdownText text="see docs/real.md" />
        </FileLinkContext.Provider>,
      );
      await vi.advanceTimersByTimeAsync(60_000);
      unmount();
    }
    expect(fileProbe).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
