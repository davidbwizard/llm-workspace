import { useEffect, useRef, useState } from 'react';
import type { LaunchResult } from '../../main/launch.ts';
import { Icon } from './Icon.tsx';
import { SettingsModal } from './SettingsModal.tsx';
import { UsagePopover } from './UsagePopover.tsx';
import { useFavourites, addFavourite, removeFavourite, MAX_FAVOURITES, lastSegment } from '../state/favourites.ts';
import { useChecks } from '../state/useChecks.ts';
// Runtime values, so they come from a node-free module under src/core --
// NOT from identity.ts beside SESSION_ID_SAFE, which imports node:crypto
// (tests/renderer/bundle.test.ts).
import {
  SESSION_NAME_SAFE, SESSION_NAME_MAX, SESSION_NAME_HELP,
  SESSION_NAME_CODEX_REASON, SESSION_NAME_PLACEHOLDER,
} from '../../core/sessionName.ts';
import './LaunchBar.css';

// A live terminal only exists once TerminalView actually mounts, and it
// resizes tmux for real the moment it does (its own onResize -> resize-window,
// src/renderer/components/TerminalView.tsx). This only has to be a
// reasonable starting size for the pane before that, not an exact one.
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

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
export function LaunchBar({ onLaunched, disabled = false }: {
  onLaunched: (pid: number) => void;
  /** The first-run takeover is up. The bar stays VISIBLE and goes inert
   *  (mockup option A): the app is not pretending these controls have
   *  gone, it is showing what they will be once the list below is clear.
   *  aria-disabled on the form plus the real `disabled` on each control,
   *  so a keyboard user meets the same wall a mouse user does. */
  disabled?: boolean;
}) {
  const [provider, setProvider] = useState<'claude' | 'codex'>('claude');
  // Design §4: a missing dependency costs exactly one capability, and the
  // control it costs is DISABLED WITH THE REASON ATTACHED, never hidden. A
  // control that vanished teaches the person nothing; one that is visible
  // and explains itself teaches them what to install. Until the first sweep
  // lands, `readiness` is null and nothing is disabled -- the app assumes it
  // works rather than locking its own controls on no evidence.
  const { readiness } = useChecks();
  const launchable = readiness?.launch[provider] ?? null;
  // Blocked by a missing dependency, or by the first-run screen being up.
  const blocked = disabled || (launchable !== null && !launchable.available);
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

  // The Launch split button's own dropdown (session-names design): the main
  // half launches exactly as it did before, unnamed and in one click; this
  // holds the options. Same Escape/outside-click/focus-return shape as the
  // Usage popover above and OpenSessionCard's compact menu -- non-modal,
  // with no background scroll lock, because it is small and local.
  const [nameOpen, setNameOpen] = useState(false);
  const [name, setName] = useState('');
  const nameWrapRef = useRef<HTMLSpanElement | null>(null);
  const nameBtnRef = useRef<HTMLButtonElement | null>(null);
  // Claude only: `codex --help` carries no launch-time name flag, so the
  // field is disabled WITH THE REASON rather than hidden.
  const nameable = provider === 'claude';

  // Favourite folders: state/favourites.ts is the one shared store
  // LaunchBar, MainPane's header star and OpenSessionCard's own menu item
  // all read and write -- adding one from the header or a card shows up
  // here, as a chip, with no reload (useFavourites is a useSyncExternalStore
  // subscription, same as useSettings()).
  const favourites = useFavourites();
  const trimmedCwd = cwd.trim();
  const isFav = trimmedCwd !== '' && favourites.includes(trimmedCwd);
  const favouritesFull = !isFav && favourites.length >= MAX_FAVOURITES;

  /** Adds or removes the CURRENT folder field's (trimmed) text -- not
   *  whichever chip, if any, happens to match it -- toggling is the star's
   *  own job; a chip's own × calls the store's removeFavourite directly,
   *  the only way to drop one that isn't the folder currently typed. A
   *  no-op on an empty field (the button is disabled then anyway); the cap
   *  and dedupe rules live in the store itself (addFavourite), not here. */
  function toggleFavourite(): void {
    if (trimmedCwd === '') return;
    if (isFav) removeFavourite(trimmedCwd); else addFavourite(trimmedCwd);
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

  // Same two effects for the launch-options dropdown, and deliberately not
  // factored into a shared hook with the pair above: the two popovers are
  // independent, and one closing must never close the other.
  useEffect(() => {
    if (!nameOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancelOptions(); };
    // mousedown, not click -- see the Usage effect above for why.
    const onDown = (e: MouseEvent) => {
      if (!nameWrapRef.current?.contains(e.target as Node)) cancelOptions();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [nameOpen]);

  useEffect(() => {
    if (!nameOpen) return;
    return () => { nameBtnRef.current?.focus(); };
  }, [nameOpen]);

  /** The one path anything in this component starts a session through --
   *  the Launch button (no argument, the typed/chosen folder field) AND a
   *  favourite chip (its own stored path) both call this, rather than the
   *  chip duplicating launch's own pending/error handling. Provider always
   *  comes from the `provider` state below, currently-selected either way. */
  /** Closes the launch-options dropdown and throws away whatever was typed
   *  in it -- the ordinary "cancel discards" of any small panel, and the
   *  reason the main Launch half can stay unnamed without ever silently
   *  dropping a name: once this panel is shut, there is no typed name left
   *  to drop. */
  function cancelOptions(): void {
    setNameOpen(false);
    setName('');
  }

  async function launch(targetDir?: string, useName = false): Promise<void> {
    const dir = (targetDir ?? cwd).trim();
    if (blocked) { setMessage(launchable?.reason ?? 'That provider is not available right now.'); return; }
    if (dir === '') { setMessage('Choose a working directory first.'); return; }
    // Only the dropdown's own two launch paths carry a name, and only for a
    // provider that can take one. Trimmed first: surrounding spaces are a
    // typing artefact, not part of the name, and trimming them is the one
    // thing done TO the text -- everything else is accepted or refused as
    // typed. SESSION_NAME_SAFE would reject them, and refusing "  proj  "
    // as malformed would be pedantic rather than protective.
    const wanted = useName && nameable ? name.trim() : '';
    if (wanted !== '') {
      // The same two rules main enforces (launchCommand, src/main/launch.ts),
      // checked here for immediate feedback. This is an affordance, not the
      // enforcement: a name that got past it is still refused at the IPC
      // boundary, and its reason lands in `message` the same way.
      if (wanted.length > SESSION_NAME_MAX) {
        setMessage(`That name is too long -- keep it to ${SESSION_NAME_MAX} characters.`);
        return;
      }
      if (!SESSION_NAME_SAFE.test(wanted)) { setMessage(SESSION_NAME_HELP); return; }
    }
    setPending(true);
    setMessage(null);
    try {
      const r = (await window.fleet?.launch(
        provider, dir, DEFAULT_COLS, DEFAULT_ROWS, wanted === '' ? null : wanted,
      )) as LaunchResult | undefined;
      if (!r) { setMessage('Could not reach the app.'); return; }
      if (r.status === 'launched') { setCwd(''); cancelOptions(); onLaunched(r.pid); return; }
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
    <form className={`launchbar${disabled ? ' disabled' : ''}`} aria-disabled={disabled || undefined}
      onSubmit={e => { e.preventDefault(); void launch(); }}>
      {/* Both options stay in the list whatever is installed. A provider
          that cannot run is still selectable, so choosing it shows the
          reason rather than silently doing nothing -- which is the whole
          point of disabled-with-a-reason over hidden. */}
      {/* Switching provider clears any typed name, so a name meant for
          Claude can never be carried into a Codex launch -- and so the
          disabled Codex field is never showing text that will be thrown
          away anyway. */}
      <select className="launchprovider" aria-label="Provider" value={provider} disabled={disabled}
        onChange={e => { setProvider(e.target.value === 'codex' ? 'codex' : 'claude'); setName(''); }}>
        <option value="claude">
          Claude{readiness && !readiness.launch.claude.available ? ' (unavailable)' : ''}
        </option>
        <option value="codex">
          Codex{readiness && !readiness.launch.codex.available ? ' (unavailable)' : ''}
        </option>
      </select>
      <input className="launchcwd" type="text" aria-label="Working directory" disabled={disabled}
        placeholder="/path/to/project" value={cwd} onChange={e => setCwd(e.target.value)} />
      {/* The star glyph itself is aria-hidden (decorative -- ☆/★ carry no
          meaning to a screen reader on their own); the accessible name and
          the pressed state below carry the actual state, same convention
          as every icon in this app (Icon.tsx renders its glyphs
          aria-hidden too). Disabled both with nothing typed (there's no
          folder to favourite) and, per spec, once 12 are already saved --
          unless the current folder is ALREADY one of them, since removing
          at the cap must still work. */}
      <button type="button" className="launchfav" aria-label={isFav ? 'Remove from favourites' : 'Add to favourites'}
        aria-pressed={isFav} disabled={trimmedCwd === '' || favouritesFull || disabled}
        title={favouritesFull ? `You can save up to ${MAX_FAVOURITES} favourites.` : undefined}
        onClick={toggleFavourite}>
        <span aria-hidden="true">{isFav ? '★' : '☆'}</span>
      </button>
      <button type="button" className="launchchoose" aria-label="Choose a working directory"
        disabled={pending || disabled} onClick={() => { void chooseDirectory(); }}>
        Choose…
      </button>
      {/* `launchable` is null until this component's own sweep lands, and
          `blocked` can already be true before then because the first-run
          screen sets it from App's sweep -- so the reason must be read
          optionally. Asserting it non-null here threw on the very render
          the takeover puts up. */}
      {/* The split button (session-names design). The main half is the same
          submit button it always was -- one click, unnamed, nothing new in
          its path. The attached chevron opens the options beside it. A
          wrapping span, not the button itself, is the positioned ancestor
          and the outside-click boundary, same shape as .usagewrap below and
          OpenSessionCard's .cardmenu: a click on the chevron while the
          panel is open must not read as an outside click. */}
      <span className="launchsplit" ref={nameWrapRef}>
        <button type="submit" className="launchgo" disabled={pending || blocked}
          title={blocked ? launchable?.reason ?? undefined : undefined}>
          {pending ? 'Launching…' : 'Launch'}
        </button>
        {/* Chevron, not a tag or an ellipsis (David's own pick): the
            universal split-button mark for "more ways to do this", which
            says nothing about naming -- so a worktree or a model option can
            join this panel later without the icon becoming a lie. */}
        <button type="button" className="launchmore" ref={nameBtnRef} aria-label="Launch options"
          aria-haspopup="true" aria-expanded={nameOpen} disabled={pending || blocked}
          onClick={() => { if (nameOpen) cancelOptions(); else setNameOpen(true); }}>
          <Icon name="chevron-down" size={11} weight="bold" />
        </button>
        {nameOpen && (
          <div className="launchdrop" role="dialog" aria-label="Launch options">
            <label className={nameable ? undefined : 'off'}>
              Session name
              {/* The placeholder is the kind of name Claude derives on its
                  own, so the field explains itself without help text.
                  Enter launches: this is not a <form> of its own (it sits
                  inside the bar's form, and a nested form is invalid HTML),
                  so Enter is handled here rather than by a submit. */}
              <input type="text" value={name} disabled={!nameable || pending}
                placeholder={nameable ? SESSION_NAME_PLACEHOLDER : 'Not available for Codex'}
                autoFocus
                onChange={e => setName(e.target.value)}
                onKeyDown={e => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  void launch(undefined, true);
                }} />
            </label>
            {/* Disabled WITH THE REASON, never hidden -- the same call this
                app already makes for a missing dependency and for the mode
                chip on a session it did not launch. Readable without
                hovering: a tooltip explains nothing to anyone on a keyboard
                or a screen reader. */}
            {nameable
              ? <small>Leave blank and Claude names it for you.</small>
              : <small className="warn">{SESSION_NAME_CODEX_REASON}</small>}
            <div className="launchdrop-row">
              {/* "Launch with this name" rather than a second button called
                  "Launch": two controls with the same accessible name in one
                  form is ambiguous to a screen reader, and the visible word
                  is still contained in the name, so speech input still
                  works. */}
              <button type="button" className="launchgo" disabled={pending || blocked}
                aria-label="Launch with this name" onClick={() => { void launch(undefined, true); }}>
                Launch
              </button>
              {nameable && <small>Enter to launch</small>}
            </div>
          </div>
        )}
      </span>
      {/* Next to the gear (usage design, Part B). A wrapping div, not the
          button itself, is the positioned ancestor and the outside-click
          boundary -- same shape as OpenSessionCard.tsx's own cardmenu, so a
          click on the button while the popover is open is never mistaken
          for an outside click by the mousedown listener above. */}
      <div className="usagewrap" ref={usageWrapRef}>
        <button type="button" className="launchusage" ref={usageBtnRef} disabled={disabled}
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
        disabled={disabled} onClick={() => setSettingsOpen(true)}>
        <Icon name="gear" size={14} />
      </button>
      <SettingsModal open={settingsOpen} onClose={() => {
        setSettingsOpen(false);
        gearRef.current?.focus();
      }} />
      {message && <p className="launchmsg" role="status">{message}</p>}
      {/* The reason itself, readable without hovering: a tooltip is not an
          explanation for anyone on a keyboard or a screen reader. */}
      {blocked && !disabled && launchable?.reason && message === null && (
        <p className="launchmsg" role="status">{launchable.reason}</p>
      )}
    </form>
    {/* Only rendered once there is at least one favourite -- an empty row
        would just be dead space under the bar. A sibling of the form, not
        nested inside it, so it reads as its own row directly under the
        launch bar rather than wrapping inside it. */}
    {favourites.length > 0 && (
      <div className="favrow" role="group" aria-label="Favourite folders">
        {favourites.map(path => (
          <span className="favchip" key={path} title={path}>
            <button type="button" className="favchip-name" disabled={pending || blocked}
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
