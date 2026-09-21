// A markdown file, read-only, beside the conversation or over it.
//
// Everything on screen here came back from src/main/files.ts, which decided
// the path was inside the session's own folder, that it existed, and that it
// was small enough to render. This component reads nothing and writes
// nothing; the one action it offers besides closing is asking main to reveal
// the same file in Finder, which goes back through the identical checks.
//
// The markdown is rendered with ConversationView's own exported
// MarkdownText -- the renderer the conversation already uses, already
// hardened for untrusted text (no raw HTML, links only ever leave through
// main's https-only window-open handler, images never fetched). A second
// markdown renderer would be a second thing to harden.
import { useEffect } from 'react';
import { MarkdownText } from './ConversationView.tsx';
import './FileViewer.css';

/** The scroll-lock class SettingsModal.css already defines: this app's
 *  scrolling lives in .mainpane, .conv and .railcards, none of which body's
 *  own overflow reaches. Reused rather than restated so there is one lock in
 *  the app, not two that can disagree. */
const LOCK_CLASS = 'modal-open';

export type ViewerFile = {
  /** The candidate the click proposed, unchanged. A Reveal sends exactly
   *  this back, so main re-runs every check from scratch rather than
   *  trusting a path that has been out to the renderer and back. */
  candidate: string;
  name: string;
  size: number;
  /** The resolved path, for the header's tooltip only. Absent when main
   *  refused before it had one to report. */
  path?: string;
} & ({ kind: 'file'; text: string } | { kind: 'too_large' });

/** Where the viewer sits. MainPane picks this from the width it measures;
 *  there is no setting. */
export type ViewerMode = 'side' | 'sheet';

/** "4.1 KB" -- the mockup's own units. Bytes below 1 KB stay bytes; nothing
 *  the viewer opens can reach GB (the cap is far below that). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function FileViewer({ file, mode, onClose, onReveal }: {
  file: ViewerFile;
  mode: ViewerMode;
  onClose: () => void;
  onReveal: () => void;
}) {
  const sheet = mode === 'sheet';

  // Escape belongs to the sheet alone. As a side panel this is not modal --
  // the conversation beside it still takes typing, and stealing Escape from
  // the pane's other keyboard users to close a panel with a visible × would
  // be a worse trade.
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sheet, onClose]);

  // Nothing behind an open sheet scrolls. Removed on close AND on unmount
  // (and when the pane widens back into a side panel), so no close path can
  // leave the app unscrollable with nothing on screen to explain why.
  useEffect(() => {
    if (!sheet) return;
    document.documentElement.classList.add(LOCK_CLASS);
    return () => { document.documentElement.classList.remove(LOCK_CLASS); };
  }, [sheet]);

  const panel = (
    <section
      className={`fileviewer ${mode}`}
      role={sheet ? 'dialog' : 'region'}
      aria-modal={sheet || undefined}
      aria-label={file.name}
    >
      <header className="fvhead">
        <span className="fvname" title={file.path ?? file.candidate}>{file.name}</span>
        <span className="fvsize">{formatBytes(file.size)}</span>
        <span className="fvspacer" />
        <button type="button" className="fvbtn" onClick={onReveal}>Reveal in Finder</button>
        <button type="button" className="fvbtn fvclose" aria-label="Close file" onClick={onClose}>
          <span aria-hidden="true">&times;</span>
        </button>
      </header>
      <div className="fvbody">
        {file.kind === 'file'
          ? <MarkdownText text={file.text} />
          : (
            // The cap's own message. Not an apology and not a silent
            // failure: it names the size and hands over the one route that
            // still works.
            <p className="fvtoobig">
              {file.name} is {formatBytes(file.size)}, too large to show here.
              Reveal it in Finder to open it yourself.
            </p>
          )}
      </div>
    </section>
  );

  if (!sheet) return panel;
  return (
    // mouseDown, not click: a click that STARTED inside the sheet and ended
    // on the scrim (a drag-select that overshoots) must not close it.
    <div className="fvscrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      {panel}
    </div>
  );
}
