// Asking before editing a file the person owns.
//
// Design: docs/superpowers/specs/2026-09-21-first-run-checks-design.md §6.
//
// The app writes hooks into ~/.claude/settings.json. On the author's own
// machine that is invisible; on a stranger's it is an app modifying their
// config. So this component does the four things §6 asks for, and the
// mechanism behind each is in main, not here:
//
//   1. Shows exactly what will be written, and to which file, BEFORE
//      writing -- from hooksPreview(), which writes nothing at all.
//   2. Asks once, and takes no for an answer. A decline is recorded and the
//      app carries on with less.
//   3. Offers a clean uninstall that removes what it added and nothing else.
//   4. Never rewrites entries the app did not put there -- enforced in
//      src/hooks/consent.ts by exact command matching, not here.
//
// The Install button cannot work without the token this preview returned:
// main refuses an install it has not just shown (CONSENT_REQUIRED). That is
// what makes this a gate rather than a dialog bolted on beside one.
//
// Deliberately plain, for the same reason as DependencyChecks.tsx.
import { useCallback, useEffect, useState } from 'react';
import type { HooksPreview } from '../../hooks/consent.ts';
import './HooksConsent.css';

export function HooksConsent({ onSettled, onDeclined }: {
  /** Fires after any write, with what settings.json now actually shows --
   *  never with what was attempted. */
  onSettled?: (installed: boolean) => void;
  /** Fires only on an explicit "No thanks". Kept apart from onSettled
   *  because a REFUSED install also ends with installed === false, and
   *  closing the panel on that would take the refusal off the screen
   *  before anyone had read it. */
  onDeclined?: () => void;
}) {
  const [preview, setPreview] = useState<HooksPreview | null>(null);
  // Two errors, deliberately. `previewError` is what reading settings.json
  // reported and is refreshed by every load(); `actionError` is what a
  // write refused with and must SURVIVE the reload that follows it --
  // every action re-previews (the token is spent either way), and a single
  // error slot would let that reload wipe the refusal off the screen
  // before anyone read it.
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(() => {
    const api = window.fleet;
    if (!api?.hooksPreview) return;
    void api.hooksPreview().then(
      p => { setPreview(p); setPreviewError(p.error); },
      err => setPreviewError(err instanceof Error ? err.message : String(err)),
    );
  }, []);

  useEffect(load, [load]);

  if (preview === null) {
    return <p className="hcnote">{previewError ?? 'Reading your Claude Code settings…'}</p>;
  }

  // A refusal wins: it is about something the person just tried to do.
  const error = actionError ?? previewError;

  const install = () => {
    const api = window.fleet;
    if (!api?.hooksSet || preview.token === null || busy) return;
    setBusy(true);
    setActionError(null);
    void api.hooksSet(true, preview.token).then(
      r => {
        setBusy(false);
        setActionError(r.error);
        onSettled?.(r.installed);
        // Always re-read. The token is spent either way, and a refusal
        // (settings.json changed under us) must show the NEW situation
        // rather than leave a dead button behind.
        load();
      },
      err => { setBusy(false); setActionError(err instanceof Error ? err.message : String(err)); },
    );
  };

  const decline = () => {
    const api = window.fleet;
    if (!api?.hooksDecline || busy) return;
    setBusy(true);
    setActionError(null);
    void api.hooksDecline().then(
      () => { setBusy(false); onSettled?.(false); onDeclined?.(); },
      err => { setBusy(false); setActionError(err instanceof Error ? err.message : String(err)); },
    );
  };

  const remove = () => {
    const api = window.fleet;
    if (!api?.hooksSet || busy) return;
    setBusy(true);
    setActionError(null);
    void api.hooksSet(false).then(
      r => { setBusy(false); setActionError(r.error); onSettled?.(r.installed); load(); },
      err => { setBusy(false); setActionError(err instanceof Error ? err.message : String(err)); },
    );
  };

  return (
    <section className="hc" aria-label="Quick answers setup">
      <p className="hcwhat">
        To show what an agent is asking you, this app adds hooks to a file Claude Code
        owns. It will only ever touch its own entries.
      </p>

      <dl className="hcfacts">
        <dt>File it will change</dt>
        <dd><code>{preview.file}</code>{preview.fileExists ? '' : ' (will be created)'}</dd>
        <dt>Script the hooks will run</dt>
        <dd><code>{preview.helperPath}</code></dd>
        <dt>Entries it will add</dt>
        <dd>
          {preview.installed
            ? 'None — they are already installed.'
            : `${preview.additions.length} (${[...new Set(preview.additions.map(a => a.event))].join(', ')})`}
        </dd>
      </dl>

      {preview.additions.length > 0 && (
        <div className="hcexact">
          <button type="button" className="hclink" aria-expanded={expanded}
            onClick={() => setExpanded(v => !v)}>
            {expanded ? 'Hide' : 'Show'} exactly what will be written
          </button>
          {expanded && (
            <ul className="hcadds">
              {preview.additions.map(a => (
                <li key={`${a.event}:${a.matcher ?? ''}`}>
                  <span className="hcevent">{a.event}{a.matcher ? ` (${a.matcher})` : ''}</span>
                  <pre>{a.json}</pre>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error !== null && <p className="hcerror" role="alert">{error}</p>}

      <div className="hcactions">
        {preview.installed
          ? (
            <>
              <button type="button" className="hcbtn" onClick={remove} disabled={busy}>
                Remove these hooks
              </button>
              <span className="hcnote">Installed. Removing takes out only the entries above.</span>
            </>
          )
          : (
            <>
              <button type="button" className="hcbtn hcprimary" onClick={install}
                disabled={busy || preview.token === null}>
                Add them
              </button>
              <button type="button" className="hcbtn" onClick={decline} disabled={busy}>
                No thanks
              </button>
              {/* Taking no for an answer, in as many words. */}
              <span className="hcnote">
                {preview.decision === 'declined'
                  ? 'You said no before. The app works without them; you just do not see prompts.'
                  : 'The app still works without them. You just will not see what an agent is asking.'}
              </span>
            </>
          )}
      </div>
    </section>
  );
}
