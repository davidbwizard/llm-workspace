import { useEffect, useRef, useState } from 'react';
import type { LaunchResult } from '../../main/launch.ts';
import { Icon } from './Icon.tsx';
import { SettingsModal } from './SettingsModal.tsx';
import { UsagePopover } from './UsagePopover.tsx';
import './LaunchBar.css';

// A live terminal only exists once TerminalView actually mounts, and it
// resizes tmux for real the moment it does (its own onResize -> resize-window,
// src/renderer/components/TerminalView.tsx). This only has to be a
// reasonable starting size for the pane before that, not an exact one.
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

// Favourite folders: a JSON array of absolute path strings, keyed like this
// app's own settings/rail-width preferences (a per-viewer UI convenience,
// never fleet state -- nothing here belongs in the store/db). Read/write
// are both wrapped in try/catch: localStorage can throw in a locked-down or
// private-mode webview, and losing the star/chips is never worth taking the
// bar down over (same "must still work" rule as SessionRail's own
// readStoredRailWidth/writeStoredRailWidth).
const FAVOURITES_KEY = 'llmws.favourites';
const MAX_FAVOURITES = 12;

/** Validates on every read, not just on write -- the stored value could
 *  have been left behind by an older version of this app, or edited by
 *  hand: only absolute-path strings survive, deduped, capped at
 *  MAX_FAVOURITES. Any failure (missing key, invalid JSON, a throw from
 *  localStorage itself) falls back to no favourites rather than crashing
 *  the bar. */
function readFavourites(): string[] {
  try {
    const raw = localStorage.getItem(FAVOURITES_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter((p): p is string => typeof p === 'string' && p.startsWith('/'));
    return Array.from(new Set(valid)).slice(0, MAX_FAVOURITES);
  } catch {
    return [];
  }
}

/** Best-effort only: a failed write leaves this render's own state (already
 *  updated by the caller) as the only copy of the change, gone on the next
 *  reload -- still better than throwing and losing the click entirely. */
function writeFavourites(list: string[]): void {
  try { localStorage.setItem(FAVOURITES_KEY, JSON.stringify(list)); } catch { /* best-effort only */ }
}

/** The chip label (spec: "the folder's last path segment"). A bare "/" (no
 *  segment at all) falls back to the path itself rather than an empty
 *  label -- unreachable in practice (readFavourites only ever keeps
 *  strings starting with "/", and "/" itself is a legal absolute path). */
function lastSegment(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Starts a new session from the app -- the renderer's one job is naming a
 *  provider and an explicit, user-typed directory; main re-derives
 *  everything else (the tmux session name, the pid) itself.
 *
 *  LaunchResult's own `reason` is shown verbatim on failure, not an internal
 *  code: main already writes it as something a person can read (spec: say
 *  why in the UI, not obscurely). onLaunched hands the new pid to the
 *  caller (App.tsx) rather than selecting it here -- this component has no
 *  reach into fleet selection state, matching every other component in this
 *  tree that reaches window.fleet directly but takes no fleet-state props. */
export function LaunchBar({ onLaunched }: { onLaunched: (pid: number) => void }) {
  const [provider, setProvider] = useState<'claude' | 'codex'>('claude');
  const [cwd, setCwd] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Focus returns here when the modal closes, by whichever route -- Escape,
  // the close button, Done or the backdrop. A person who opened settings
  // from the keyboard must not be dropped back at the top of the document.
  const gearRef = useRef<HTMLButtonElement | null>(null);

  // The Usage popover (usage design, Part B): small and non-modal (no
  // background scroll lock, unlike SettingsModal's native <dialog>), so it
  // gets the same Escape/outside-click/focus-return pattern OpenSessionCard's
  // own compact `...` menu already uses, rather than SettingsModal's
  // showModal()-based one, which would also inert the rest of the page.
  const [usageOpen, setUsageOpen] = useState(false);
  const usageWrapRef = useRef<HTMLDivElement | null>(null);
  const usageBtnRef = useRef<HTMLButtonElement | null>(null);

  const [favourites, setFavourites] = useState<string[]>(() => readFavourites());
  const trimmedCwd = cwd.trim();
  const isFavourite = trimmedCwd !== '' && favourites.includes(trimmedCwd);
  const favouritesFull = !isFavourite && favourites.length >= MAX_FAVOURITES;

  /** Adds or removes the CURRENT folder field's (trimmed) text -- not
   *  whichever chip, if any, happens to match it -- toggling is the star's
   *  own job; a chip's own × (removeFavourite below) is the only way to
   *  drop one that isn't the folder currently typed. A no-op on an empty
   *  field (the button is disabled then anyway) and on trying to ADD past
   *  the cap -- removing already-favourited-at-the-cap must still work, so
   *  the cap only ever blocks the add branch. */
  function toggleFavourite(): void {
    if (trimmedCwd === '') return;
    setFavourites(prev => {
      const next = prev.includes(trimmedCwd)
        ? prev.filter(p => p !== trimmedCwd)
        : (prev.length >= MAX_FAVOURITES ? prev : [...prev, trimmedCwd]);
      if (next !== prev) writeFavourites(next);
      return next;
    });
  }

  function removeFavourite(path: string): void {
    setFavourites(prev => {
      const next = prev.filter(p => p !== path);
      writeFavourites(next);
      return next;
    });
  }

  useEffect(() => {
    if (!usageOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setUsageOpen(false); };
    // mousedown, not click -- see OpenSessionCard.tsx's own cardmenu effect
    // for why: a click listener registered during the very click that
    // opened this popover would otherwise fire again as that same event
    // finishes bubbling to the window, closing it immediately.
    const onDown = (e: MouseEvent) => {
      if (!usageWrapRef.current?.contains(e.target as Node)) setUsageOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [usageOpen]);

  // Focus returns to the button on every close path (Escape, outside click,
  // or toggling the button itself) -- the cleanup below fires exactly once,
  // on the true -> false transition (or unmount), never on every render,
  // since the effect's own dependency is unchanged while usageOpen stays
  // true.
  useEffect(() => {
    if (!usageOpen) return;
    return () => { usageBtnRef.current?.focus(); };
  }, [usageOpen]);

  /** The one path anything in this component starts a session through --
   *  the Launch button (no argument, the typed/chosen folder field) AND a
   *  favourite chip (its own stored path) both call this, rather than the
   *  chip duplicating launch's own pending/error handling. Provider always
   *  comes from the `provider` state below, currently-selected either way. */
  async function launch(targetDir?: string): Promise<void> {
    const dir = (targetDir ?? cwd).trim();
    if (dir === '') { setMessage('Choose a working directory first.'); return; }
    setPending(true);
    setMessage(null);
    try {
      const r = (await window.fleet?.launch(provider, dir, DEFAULT_COLS, DEFAULT_ROWS)) as LaunchResult | undefined;
      if (!r) { setMessage('Could not reach the app.'); return; }
      if (r.status === 'launched') { setCwd(''); onLaunched(r.pid); return; }
      setMessage(r.reason);
    } finally {
      setPending(false);
    }
  }

  // Opens the native picker as an alternative to typing the path. A
  // cancel (or an unreachable main process) resolves to null/undefined --
  // either way, cwd is left exactly as it was, since a misclick on
  // "Choose…" must never wipe out a path someone already typed.
  async function chooseDirectory(): Promise<void> {
    const chosen = await window.fleet?.chooseDirectory();
    if (chosen) setCwd(chosen);
  }

  return (
    <>
    <form className="launchbar" onSubmit={e => { e.preventDefault(); void launch(); }}>
      <select className="launchprovider" aria-label="Provider" value={provider}
        onChange={e => setProvider(e.target.value === 'codex' ? 'codex' : 'claude')}>
        <option value="claude">Claude</option>
        <option value="codex">Codex</option>
      </select>
      <input className="launchcwd" type="text" aria-label="Working directory"
        placeholder="/path/to/project" value={cwd} onChange={e => setCwd(e.target.value)} />
      {/* The star glyph itself is aria-hidden (decorative -- ☆/★ carry no
          meaning to a screen reader on their own); the accessible name and
          the pressed state below carry the actual state, same convention
          as every icon in this app (Icon.tsx renders its glyphs
          aria-hidden too). Disabled both with nothing typed (there's no
          folder to favourite) and, per spec, once 12 are already saved --
          unless the current folder is ALREADY one of them, since removing
          at the cap must still work. */}
      <button type="button" className="launchfav" aria-label={isFavourite ? 'Remove from favourites' : 'Add to favourites'}
        aria-pressed={isFavourite} disabled={trimmedCwd === '' || favouritesFull}
        title={favouritesFull ? `You can save up to ${MAX_FAVOURITES} favourites.` : undefined}
        onClick={toggleFavourite}>
        <span aria-hidden="true">{isFavourite ? '★' : '☆'}</span>
      </button>
      <button type="button" className="launchchoose" aria-label="Choose a working directory"
        disabled={pending} onClick={() => { void chooseDirectory(); }}>
        Choose…
      </button>
      <button type="submit" className="launchgo" disabled={pending}>
        {pending ? 'Launching…' : 'Launch'}
      </button>
      {/* Next to the gear (usage design, Part B). A wrapping div, not the
          button itself, is the positioned ancestor and the outside-click
          boundary -- same shape as OpenSessionCard.tsx's own cardmenu, so a
          click on the button while the popover is open is never mistaken
          for an outside click by the mousedown listener above. */}
      <div className="usagewrap" ref={usageWrapRef}>
        <button type="button" className="launchusage" ref={usageBtnRef}
          aria-haspopup="true" aria-expanded={usageOpen}
          onClick={() => setUsageOpen(o => !o)}>
          Usage
        </button>
        {usageOpen && <UsagePopover />}
      </div>
      {/* Beside Launch, per the mockup. A real button, so it is reachable
          by keyboard and carries a real accessible name -- "Settings", not
          the glyph, which Icon renders aria-hidden. Phosphor's Gear, not a
          Unicode gear character: U+2699 renders as a colour emoji on macOS
          in some fonts, and this app uses none. */}
      <button type="button" className="launchgear" aria-label="Settings" ref={gearRef}
        onClick={() => setSettingsOpen(true)}>
        <Icon name="gear" size={14} />
      </button>
      <SettingsModal open={settingsOpen} onClose={() => {
        setSettingsOpen(false);
        gearRef.current?.focus();
      }} />
      {message && <p className="launchmsg" role="status">{message}</p>}
    </form>
    {/* Only rendered once there is at least one favourite -- an empty row
        would just be dead space under the bar. A sibling of the form, not
        nested inside it, so it reads as its own row directly under the
        launch bar rather than wrapping inside it. */}
    {favourites.length > 0 && (
      <div className="favrow" role="group" aria-label="Favourite folders">
        {favourites.map(path => (
          <span className="favchip" key={path} title={path}>
            <button type="button" className="favchip-name" disabled={pending}
              onClick={() => { void launch(path); }}>
              {lastSegment(path)}
            </button>
            <button type="button" className="favchip-remove"
              aria-label={`Remove ${lastSegment(path)} from favourites`}
              onClick={() => removeFavourite(path)}>
              ×
            </button>
          </span>
        ))}
      </div>
    )}
    </>
  );
}
