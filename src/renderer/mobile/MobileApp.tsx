import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ConversationPage } from '../../store/conversation.ts';
import type { SessionLivePayload } from '../../main/sessionLive.ts';
import type { LaunchResult } from '../../main/launch.ts';
import { MarkdownText } from '../components/ConversationView.tsx';
import { PromptCard } from '../components/PromptCard.tsx';
import { CodexPromptCard } from '../components/CodexPromptCard.tsx';
import { TerminalView } from '../components/TerminalView.tsx';
import { MobileConnection } from './connection.ts';
import { terminalBridge, unwrap } from './bridge.ts';
import './mobile.css';
export interface MobileSession { handle: string | null; pid: number; sessionId: string | null; provider: 'claude' | 'codex'; name?: string | null; cwd: string | null; activity?: string; controllable: boolean }
interface Preview { id: string; label: string; url: string; available: boolean }
const defaultConnection = new MobileConnection(typeof location === 'undefined' ? '' : location.origin);
const messageFor = (error: unknown) => error instanceof Error ? error.message : 'Could not reach Fleet. Check the connection.';
function readLocal(key: string): string { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } }
function writeLocal(key: string, value: string) { localStorage.setItem(key, value); }
export function MobileApp({ connection = defaultConnection }: { connection?: MobileConnection }) {
  const state = useSyncExternalStore(connection.subscribe, connection.state);
  const [sessions, setSessions] = useState<MobileSession[]>([]);
  const [selected, setSelected] = useState(() => readLocal('fleet:mobile:selection'));
  const [terminal, setTerminal] = useState(false); const [showRail, setShowRail] = useState(true);
  const [error, setError] = useState(''); const [newSession, setNewSession] = useState(false);
  const [projects, setProjects] = useState<Array<{ id: string; label: string }>>([]);
  const [project, setProject] = useState(''); const [provider, setProvider] = useState<'claude' | 'codex'>('codex');
  const [launching, setLaunching] = useState(false); const waitingPid = useRef<number | null>(null);
  const retry = useRef(0);
  const session = sessions.find(row => (row.sessionId ?? String(row.pid)) === selected);
  function select(row: MobileSession) {
    const id = row.sessionId ?? String(row.pid); setSelected(id); setShowRail(false); setTerminal(false);
    try { writeLocal('fleet:mobile:selection', id); } catch { setError('This browser cannot save your selection.'); }
  }
  useEffect(() => {
    if (state === 'ready') { retry.current = 0; return; }
    if (state === 'connecting') return;
    const timer = setTimeout(() => { void connection.connect(); }, Math.min(10_000, 500 * 2 ** retry.current++) + Math.random() * 250);
    return () => clearTimeout(timer);
  }, [connection, state]);
  useEffect(() => () => connection.close(), [connection]);
  useEffect(() => {
    if (state !== 'ready') return;
    let alive = true; let running = false;
    const refresh = async () => {
      if (running) return; running = true;
      try {
        const rows = unwrap<MobileSession[]>(await connection.request('list', {}));
        if (!alive) return; setSessions(rows);
        const launched = rows.find(row => row.pid === waitingPid.current);
        if (launched) { waitingPid.current = null; select(launched); }
      } catch (e) { if (alive) setError(messageFor(e)); }
      finally { running = false; }
    };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [connection, state]);
  async function openLaunch() {
    setError(''); setNewSession(true);
    try { const rows = unwrap<Array<{ id: string; label: string }>>(await connection.request('projects', {})); setProjects(rows); setProject(rows[0]?.id ?? ''); }
    catch (e) { setError(messageFor(e)); }
  }
  async function launch() {
    setLaunching(true); setError('');
    try {
      const result = unwrap<LaunchResult>(await connection.request('launch', { project, provider }));
      if (result.status !== 'launched') throw new Error(result.reason);
      waitingPid.current = result.pid; setNewSession(false); setError('Session started. Waiting for Fleet to discover it…');
    } catch (e) { setError(messageFor(e)); } finally { setLaunching(false); }
  }
  return <div className="mobile-app" data-show-rail={showRail}>
    <header className="mobile-top"><h1>Fleet</h1><span role="status" data-state={state}>{state === 'ready' ? 'Connected to your Mac' : state === 'connecting' ? 'Connecting…' : 'Offline — reconnecting'}</span><button disabled={state !== 'ready'} onClick={() => void openLaunch()}>New session</button></header>
    {error && <div className="mobile-notice" role="alert">{error}<button aria-label="Dismiss message" onClick={() => setError('')}>×</button></div>}
    <div className="mobile-workspace">
      <nav className="mobile-rail" aria-label="Sessions"><h2>Sessions <small>{sessions.length}</small></h2>{sessions.map(row => <button key={row.pid} aria-current={row === session} onClick={() => select(row)}><strong>{row.name || row.cwd?.split('/').pop() || row.provider}</strong><span>{row.provider} · {row.activity ?? 'running'}</span>{!row.controllable && <small>View only</small>}</button>)}{!sessions.length && <p>{state === 'ready' ? 'No running sessions. Start one in a known project.' : 'Keep Fleet running on your Mac and connect this device to Tailscale.'}</p>}</nav>
      <main className="mobile-main">{session ? <><div className="mobile-session-header"><button className="mobile-back" onClick={() => setShowRail(true)}>Sessions</button><h2>{session.name || session.cwd?.split('/').pop() || session.provider}</h2><button disabled={!session.controllable || state !== 'ready'} onClick={() => setTerminal(v => !v)}>{terminal ? 'Conversation' : 'Terminal'}</button></div>
        <Session key={`${session.handle}:${state}`} session={session} terminal={terminal} connection={connection} ready={state === 'ready'} onTerminal={() => setTerminal(true)} onError={setError} />
      </> : <p className="mobile-empty">Choose a session to pick up where you left off.</p>}</main>
    </div>
    {newSession && <div className="mobile-modal" role="dialog" aria-modal="true" aria-label="New session"><form onSubmit={e => { e.preventDefault(); void launch(); }}><h2>New session</h2><p>Runs on your Mac, available on every device.</p><label>Agent<select value={provider} onChange={e => setProvider(e.target.value as 'claude' | 'codex')}><option value="codex">Codex</option><option value="claude">Claude</option></select></label><label>Project<select value={project} onChange={e => setProject(e.target.value)}>{projects.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>{!projects.length && <p>Open a project in Fleet on your Mac first.</p>}<div className="mobile-actions"><button type="button" disabled={launching} onClick={() => setNewSession(false)}>Cancel</button><button disabled={!project || launching || state !== 'ready'}>{launching ? 'Starting…' : 'Start session'}</button></div></form></div>}
  </div>;
}
function Session({ session, terminal, connection, ready, onTerminal, onError }: { session: MobileSession; terminal: boolean; connection: MobileConnection; ready: boolean; onTerminal(): void; onError(message: string): void }) {
  const [page, setPage] = useState<ConversationPage | null>(null); const [live, setLive] = useState<SessionLivePayload | null>(null);
  const [previews, setPreviews] = useState<Preview[]>([]); const [sending, setSending] = useState(false); const [loadingOlder, setLoadingOlder] = useState(false);
  const draftKey = `fleet:mobile:draft:${session.provider}:${session.sessionId ?? session.handle}`;
  const [draft, setDraft] = useState(() => readLocal(draftKey));
  const bridge = useMemo(() => terminalBridge(connection, session.handle ?? ''), [connection, session.handle]);
  const scroll = useRef<HTMLDivElement>(null); const bottom = useRef(true);
  useEffect(() => {
    if (!ready || !session.handle) return;
    let alive = true; let refreshing = false;
    const refresh = async () => {
      if (refreshing) return; refreshing = true;
      try {
        const next = unwrap<ConversationPage>(await connection.request('conversation', { handle: session.handle }));
        if (alive) setPage(old => old ? { turns: [...old.turns.filter(t => !next.turns.some(n => n.id === t.id)), ...next.turns].sort((a, b) => a.ts.localeCompare(b.ts) || a.id - b.id), nextCursor: old.nextCursor } : next);
      } catch (e) { if (alive) onError(messageFor(e)); } finally { refreshing = false; }
    };
    const unsub = connection.onEvent((event, data) => {
      const next = data as SessionLivePayload;
      if (event !== 'session:live' || next.pid !== session.pid || next.sessionId !== session.sessionId || !alive) return;
      setLive(next); void refresh();
    });
    void connection.request('watch', { handle: session.handle }).then(r => { if (!r.ok && alive) onError('Could not watch this session. Reopen it from the list.'); });
    void connection.request('live', { handle: session.handle }).then(r => { if (r.ok && alive) setLive(r.value as SessionLivePayload); });
    void connection.request('previews', { handle: session.handle }).then(r => { if (r.ok && alive) setPreviews(r.value as Preview[]); });
    void refresh(); const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { alive = false; unsub(); clearInterval(timer); void connection.request('watch', { handle: null }); };
  }, [connection, ready, session.handle, session.pid, session.sessionId, onError]);
  useEffect(() => { if (bottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [page]);
  async function send() {
    if (sending || !draft.trim()) return; setSending(true);
    try {
      const result = unwrap<{ status: string; reason?: string }>(await connection.request('send', { handle: session.handle, text: draft }));
      if (!['sent', 'queued'].includes(result.status)) throw new Error(`Reply refused: ${result.reason ?? result.status}. Check Terminal.`);
      setDraft(''); writeLocal(draftKey, '');
    } catch (e) { onError(messageFor(e)); } finally { setSending(false); }
  }
  async function answer<T,>(op: string, key: string, value: unknown): Promise<T> {
    try { return unwrap<T>(await connection.request(op, { handle: session.handle, key, answer: value })); }
    catch (e) { onError(messageFor(e)); throw e; }
  }
  async function older() {
    if (!page?.nextCursor || loadingOlder) return; setLoadingOlder(true);
    const priorHeight = scroll.current?.scrollHeight ?? 0;
    try {
      const next = unwrap<ConversationPage>(await connection.request('conversation', { handle: session.handle, cursor: page.nextCursor }));
      bottom.current = false; setPage(p => ({ turns: [...next.turns.filter(t => !p?.turns.some(n => n.id === t.id)), ...(p?.turns ?? [])], nextCursor: next.nextCursor }));
      requestAnimationFrame(() => { if (scroll.current) scroll.current.scrollTop += scroll.current.scrollHeight - priorHeight; });
    } catch (e) { onError(messageFor(e)); } finally { setLoadingOlder(false); }
  }
  if (!session.handle) return <p className="mobile-empty">Fleet cannot verify this session yet. Check its desktop view.</p>;
  return <>
    {!!previews.length && <div className="mobile-previews">{previews.map(p => p.available ? <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer">Open {p.label}</a> : <span key={p.id}>{p.label} — server unavailable</span>)}</div>}
    {terminal ? <><TerminalView key={String(ready)} pid={session.pid} bridge={bridge} /><div className="mobile-keys">{[['Esc', '\x1b'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['Ctrl-C', '\x03'], ['Enter', '\r']].map(([label, data]) => <button key={label} disabled={!ready} onClick={() => { void bridge.sendRaw(session.pid, data!).catch(e => onError(messageFor(e))); }}>{label}</button>)}</div></> : <>
      <div className="mobile-transcript" ref={scroll} onScroll={() => { const el = scroll.current; if (el) bottom.current = el.scrollHeight - el.clientHeight - el.scrollTop < 100; }}>
        {page?.nextCursor && <button disabled={loadingOlder || !ready} onClick={() => void older()}>Load earlier messages</button>}
        {!page && <p>{ready ? 'Loading conversation…' : 'Reconnect to read the conversation.'}</p>}
        {page?.turns.map(turn => <article key={turn.id} data-role={turn.role}><small>{turn.role === 'user' ? 'You' : session.provider}</small><MarkdownText text={turn.text} /></article>)}
        <fieldset disabled={!ready} className="mobile-prompts">{live?.prompt && <PromptCard pid={session.pid} prompt={live.prompt} onOpenTerminal={onTerminal} answerPrompt={(_pid, key, value) => answer('answerClaude', key, value)} />}{live?.codex?.prompts.map(prompt => <CodexPromptCard key={prompt.key} pid={session.pid} prompt={prompt} onOpenTerminal={onTerminal} answerPrompt={(_pid, key, value) => answer('answerCodex', key, value)} />)}</fieldset>
      </div>
      <form className="mobile-composer" onSubmit={e => { e.preventDefault(); void send(); }}><label htmlFor="mobile-reply" className="visually-hidden">Reply</label><textarea id="mobile-reply" value={draft} disabled={sending} placeholder={session.controllable ? 'Message this session…' : 'This session is view only'} onChange={e => { setDraft(e.target.value); try { writeLocal(draftKey, e.target.value); } catch { onError('Draft could not be saved on this device. Keep this page open.'); } }} /><button disabled={!ready || !session.controllable || !draft.trim() || sending}>{sending ? 'Sending…' : 'Send'}</button></form>
    </>}
  </>;
}
