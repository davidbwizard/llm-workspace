import { useRef, useState } from 'react';
import type { LaunchResult } from '../../main/launch.ts';
import { Icon } from './Icon.tsx';
import { SettingsModal } from './SettingsModal.tsx';
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

  async function launch(): Promise<void> {
    const dir = cwd.trim();
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
    <form className="launchbar" onSubmit={e => { e.preventDefault(); void launch(); }}>
      <select className="launchprovider" aria-label="Provider" value={provider}
        onChange={e => setProvider(e.target.value === 'codex' ? 'codex' : 'claude')}>
        <option value="claude">Claude</option>
        <option value="codex">Codex</option>
      </select>
      <input className="launchcwd" type="text" aria-label="Working directory"
        placeholder="/path/to/project" value={cwd} onChange={e => setCwd(e.target.value)} />
      <button type="button" className="launchchoose" aria-label="Choose a working directory"
        disabled={pending} onClick={() => { void chooseDirectory(); }}>
        Choose…
      </button>
      <button type="submit" className="launchgo" disabled={pending}>
        {pending ? 'Launching…' : 'Launch'}
      </button>
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
  );
}
