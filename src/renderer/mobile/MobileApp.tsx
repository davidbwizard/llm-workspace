import { Image as ImageIcon } from '@phosphor-icons/react';
import { MOBILE_IMAGE_BYTES, MOBILE_IMAGE_LIMIT } from '../../core/remote.ts';
import { transcriptRefresh } from './refresh.ts';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ConversationPage } from '../../store/conversation.ts';
import type { SessionLivePayload } from '../../main/sessionLive.ts';
import type { LaunchResult } from '../../main/launch.ts';
import { MarkdownText } from '../components/ConversationView.tsx';
import { LocalWebsiteContext, LocalWebsiteInput, type LocalWebsiteAccess } from '../components/LocalWebsiteLink.tsx';
import type { PreviewOpenResult } from '../../core/preview.ts';
import { PromptCard } from '../components/PromptCard.tsx';
import { CodexPromptCard } from '../components/CodexPromptCard.tsx';
import { WorkingStrip } from '../components/WorkingStrip.tsx';
import { StatusIcon } from '../components/StatusIcon.tsx';
import { TerminalView } from '../components/TerminalView.tsx';
import { MobileConnection } from './connection.ts';
import { MobileSessionMenu } from './MobileSessionMenu.tsx';
import { MobileSessionList } from './MobileSessionList.tsx';
import { ActivityInbox, InboxNav } from '../components/ActivityInbox.tsx';
import { createActivityInboxStore, findUnreadBoundary, useActivityInbox, type ReadBoundary } from '../state/activityInbox.ts';
import { terminalBridge, unwrap } from './bridge.ts';
import './mobile.css';
export interface MobileSession { handle: string | null; pid: number; sessionId: string | null; provider: 'claude' | 'codex'; name?: string | null; cwd: string | null; activity?: string; events?: number | null; lastProse?: string | null; lastProseId?: number | null; project?: string; controllable: boolean }
interface MobileProject { id: string; label: string; favorite?: boolean }
interface Preview { id: string; label: string; url: string; available: boolean }
const defaultConnection = new MobileConnection(typeof location === 'undefined' ? '' : location.origin);
const messageFor = (error: unknown) => error instanceof Error ? error.message : 'Could not reach Fleet. Check the connection.';
function readLocal(key: string): string { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } }
function writeLocal(key: string, value: string) { localStorage.setItem(key, value); }
export function MobileApp({ connection = defaultConnection }: { connection?: MobileConnection }) {
  const state = useSyncExternalStore(connection.subscribe, connection.state);
  const [sessions, setSessions] = useState<MobileSession[]>([]);
  const [inboxStore] = useState(() => createActivityInboxStore({ read: () => readLocal('fleet:mobile:activity-inbox') || null, write: raw => writeLocal('fleet:mobile:activity-inbox', raw) }));
  const inbox = useActivityInbox(sessions, inboxStore);
  const [latestRequest, setLatestRequest] = useState(0);
  const [activityView, setActivityView] = useState<'fleet' | 'needs-you' | 'updates'>('fleet');
  const [visit, setVisit] = useState<{ unread: boolean; boundary: ReadBoundary | null }>({ unread: false, boundary: null });
  const [selected, setSelected] = useState(() => readLocal('fleet:mobile:selection'));
  const [terminal, setTerminal] = useState(false); const [showRail, setShowRail] = useState(true);
  const [error, setError] = useState(''); const [newSession, setNewSession] = useState(false);
  const [projects, setProjects] = useState<MobileProject[]>([]);
  const [sessionName, setSessionName] = useState('');
  const [project, setProject] = useState(''); const [provider, setProvider] = useState<'claude' | 'codex'>('codex');
  const [launching, setLaunching] = useState(false); const waitingPid = useRef<number | null>(null);
  const [closeTarget, setCloseTarget] = useState<MobileSession | null>(null);
  const [closing, setClosing] = useState(false);
  const retry = useRef(0);
  const session = sessions.find(row => (row.sessionId ?? String(row.pid)) === selected);
  function select(row: MobileSession, latest = false) {
    if (latest) setLatestRequest(request => request + 1);
    setVisit({ unread: inbox.isUnread(row), boundary: inbox.getBoundary(row) });
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
        if (launched?.handle && launched.sessionId) { waitingPid.current = null; select(launched); }
      } catch (e) { if (alive) setError(messageFor(e)); }
      finally { running = false; }
    };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [connection, state]);
  async function closeSession() {
    if (!closeTarget || closing) return; setClosing(true); setError('');
    try {
      const result = unwrap<{ status: string; reason?: string }>(await connection.request('close', { handle: closeTarget.handle }));
      if (!['killed', 'already_gone'].includes(result.status)) throw new Error(`Could not close session: ${result.reason ?? result.status}. Check its desktop view.`);
      setCloseTarget(null); setShowRail(true); setError('Close requested. The session will disappear when its agent exits.');
    } catch (e) { setError(messageFor(e)); setCloseTarget(null); } finally { setClosing(false); }
  }
  async function openLaunch() {
    setError(''); setSessionName(''); setNewSession(true);
    try { const rows = unwrap<MobileProject[]>(await connection.request('projects', {})); setProjects(rows); setProject(rows[0]?.id ?? ''); }
    catch (e) { setError(messageFor(e)); }
  }
  async function launch() {
    setLaunching(true); setError('');
    try {
      const result = unwrap<LaunchResult>(await connection.request('launch', { project, provider, ...(sessionName.trim() ? { name: sessionName.trim() } : {}) }));
      if (result.status !== 'launched') throw new Error(result.reason);
      waitingPid.current = result.pid; setNewSession(false); setError(result.warning || 'Session started. Waiting for Fleet to discover it…');
    } catch (e) { setError(messageFor(e)); } finally { setLaunching(false); }
  }
  return <div className="mobile-app" data-show-rail={showRail}>
    <header className="mobile-top"><h1>Fleet</h1><span role="status" data-state={state}>{state === 'ready' ? 'Connected to your Mac' : state === 'connecting' ? 'Connecting…' : 'Offline — reconnecting'}</span><button disabled={state !== 'ready'} onClick={() => void openLaunch()}>New session</button></header>
    {error && <div className="mobile-notice" role="alert">{error}<button aria-label="Dismiss message" onClick={() => setError('')}>×</button></div>}
    <InboxNav active={activityView} fleetLabel="Sessions" needsCount={inbox.needsYou.length} updatesCount={inbox.updates.length} onChange={view => { setActivityView(view); setShowRail(true); }} />
    <div className="mobile-workspace">
      <nav className="mobile-rail" aria-label="Sessions" hidden={activityView !== 'fleet'}><h2>Sessions <small>{sessions.length}</small></h2><MobileSessionList ready={state === 'ready'} sessions={sessions} selected={session} onSelect={select} />{!sessions.length && <p>{state === 'ready' ? 'No running sessions. Start one in a known project.' : 'Keep Fleet running on your Mac and connect this device to Tailscale.'}</p>}</nav>
      {activityView !== 'fleet' && showRail && <section className="mobile-inbox">
        {state !== 'ready' && <p className="mobile-inbox-offline">Offline — these are the last known updates. Reconnect to check requests.</p>}
        <ActivityInbox kind={activityView} items={activityView === 'needs-you' ? inbox.needsYou : inbox.updates} onOpen={item => { const row = sessions.find(candidate => candidate.pid === item.pid && candidate.provider === item.provider); if (row) select(row, true); }} />
      </section>}
      <main className="mobile-main" hidden={activityView !== 'fleet' && showRail}>{session ? <><div className="mobile-session-header"><button className="mobile-back" onClick={() => setShowRail(true)}>{activityView === 'fleet' ? 'Sessions' : activityView === 'needs-you' ? 'Needs you' : 'Updates'}</button><h2>{session.name || session.cwd?.split('/').pop() || session.provider}</h2></div>
        <Session key={session.handle ?? session.pid} session={session} terminal={terminal} connection={connection} ready={state === 'ready'} onTerminal={() => setTerminal(true)} onToggleTerminal={() => setTerminal(v => !v)} onClose={() => setCloseTarget(session)} onError={setError} visible={!showRail && !newSession && !closeTarget} latestRequest={latestRequest} unreadAtOpen={visit.unread} readBoundary={visit.boundary} onRead={lastAgent => inbox.markVisible(session, { lastAgentText: lastAgent.text, lastAgentId: lastAgent.id })} />
      </> : <p className="mobile-empty">Choose a session to pick up where you left off.</p>}</main>
    </div>
    {closeTarget && <div className="mobile-modal" role="dialog" aria-modal="true" aria-label="Close session"><div className="mobile-dialog"><h2>Close {closeTarget.name || closeTarget.cwd?.split('/').pop() || closeTarget.provider}?</h2><p>This stops the running {closeTarget.provider === 'codex' ? 'Codex' : 'Claude'} agent on your Mac, on every device. Work in progress may be interrupted.</p><div className="mobile-actions"><button autoFocus disabled={closing} onClick={() => setCloseTarget(null)}>Cancel</button><button className="mobile-danger" disabled={closing || state !== 'ready'} onClick={() => void closeSession()}>{closing ? 'Closing…' : 'Stop session'}</button></div></div></div>}
    {newSession && <div className="mobile-modal" role="dialog" aria-modal="true" aria-label="New session"><form onSubmit={e => { e.preventDefault(); void launch(); }}><h2>New session</h2><p>Runs on your Mac, available on every device.</p><label>Agent<select value={provider} onChange={e => setProvider(e.target.value as 'claude' | 'codex')}><option value="codex">Codex</option><option value="claude">Claude</option></select></label><div className="mobile-favorites"><h3>Favourites</h3>{projects.some(p => p.favorite) ? projects.filter(p => p.favorite).map(p => <button key={p.id} type="button" aria-pressed={project === p.id} onClick={() => setProject(p.id)}>{p.label}</button>) : <p>Star folders in desktop Fleet to keep them here.</p>}</div><label>Project<select value={project} onChange={e => setProject(e.target.value)}>{projects.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label><label>Session name (optional)<input value={sessionName} maxLength={64} placeholder="Name this session" onChange={e => setSessionName(e.target.value)} /></label>{!projects.length && <p>Open a project in Fleet on your Mac first.</p>}<div className="mobile-actions"><button type="button" disabled={launching} onClick={() => setNewSession(false)}>Cancel</button><button disabled={!project || launching || state !== 'ready'}>{launching ? 'Starting…' : 'Start session'}</button></div></form></div>}
  </div>;
}
function Session({ session, terminal, connection, ready, onTerminal, onToggleTerminal, onClose, onError, visible, latestRequest, unreadAtOpen, readBoundary, onRead }: { session: MobileSession; terminal: boolean; connection: MobileConnection; ready: boolean; onTerminal(): void; onToggleTerminal(): void; onClose(): void; onError(message: string): void; visible: boolean; latestRequest: number; unreadAtOpen: boolean; readBoundary: ReadBoundary | null; onRead(turn: { id: number; text: string }): void }) {
  const [page, setPage] = useState<ConversationPage | null>(null); const [live, setLive] = useState<SessionLivePayload | null>(null);
  const [previews, setPreviews] = useState<Preview[]>([]); const [sending, setSending] = useState(false); const [loadingOlder, setLoadingOlder] = useState(false);
  const draftKey = `fleet:mobile:draft:${session.provider}:${session.sessionId ?? session.handle}`;
  const [draft, setDraft] = useState(() => readLocal(draftKey));
  const [controlling, setControlling] = useState(false);
  const [showPreviews, setShowPreviews] = useState(false); const [checkingPreviews, setCheckingPreviews] = useState(false);
  const [images, setImages] = useState<Array<{ file: File; url: string }>>([]);
  const imagesRef = useRef(images); imagesRef.current = images;
  useEffect(() => () => { for (const image of imagesRef.current) URL.revokeObjectURL(image.url); }, []);
  function clearImages() { for (const image of imagesRef.current) URL.revokeObjectURL(image.url); setImages([]); }
  const previewLifetime = useMemo(() => ({ active: true, refreshing: false, refreshAgain: false }), [connection, session.handle]);
  useEffect(() => { previewLifetime.active = true; return () => { previewLifetime.active = false; }; }, [previewLifetime]);
  const refreshPreviews = useCallback(async function refresh() {
    if (!previewLifetime.active) return;
    if (previewLifetime.refreshing) { previewLifetime.refreshAgain = true; return; }
    previewLifetime.refreshAgain = false; previewLifetime.refreshing = true; setCheckingPreviews(true);
    try {
      const next = unwrap<Preview[]>(await connection.request('previews', { handle: session.handle }));
      if (previewLifetime.active) setPreviews(next);
    } catch (e) { if (previewLifetime.active) onError(messageFor(e)); }
    finally {
      previewLifetime.refreshing = false;
      if (previewLifetime.active) {
        setCheckingPreviews(false);
        if (previewLifetime.refreshAgain) void refresh();
      }
    }
  }, [connection, session.handle, previewLifetime, onError]);
  const openWebsite = useCallback(async (url: string): Promise<PreviewOpenResult> => {
    const response = await connection.request('preview:open', { handle: session.handle, url });
    if (!response.ok && response.reason === 'uncertain') return {
      ok: false,
      message: 'Connection lost before Fleet confirmed setup. This website may already be connected. Reconnect and check Websites, or safely retry Open website.',
    };
    const result = unwrap<PreviewOpenResult>(response);
    if (result.ok && previewLifetime.active) await refreshPreviews();
    return result;
  }, [connection, session.handle, refreshPreviews, previewLifetime]);
  const websiteAccess = useMemo<LocalWebsiteAccess>(() => ({
    mobile: true, disabled: !ready, open: openWebsite,
  }), [ready, openWebsite]);
  function pickImages(files: FileList | null) {
    if (!files) return;
    const next = Array.from(files);
    if (images.length + next.length > MOBILE_IMAGE_LIMIT) { onError('Attach up to 4 images per reply.'); return; }
    if (next.some(file => file.size > MOBILE_IMAGE_BYTES || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type))) {
      onError('Choose PNG, JPEG, GIF or WebP images up to 10 MB each.'); return;
    }
    if (terminal) onToggleTerminal();
    setImages(old => [...old, ...next.map(file => ({ file, url: URL.createObjectURL(file) }))]);
  }
  const bridge = useMemo(() => terminalBridge(connection, session.handle ?? ''), [connection, session.handle]);
  useEffect(() => connection.onEvent((event, payload) => {
    const p = payload as { pid: number; controlling?: boolean };
    if (event === 'terminal:control' && p.pid === session.pid) setControlling(p.controlling === true);
  }), [connection, session.pid]);
  const scroll = useRef<HTMLDivElement>(null); const bottom = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const update = () => setDocumentVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const lastAgent = page?.turns.findLast(turn => turn.role === 'assistant');
  useEffect(() => {
    if (ready && visible && documentVisible && !terminal && atBottom && lastAgent) onRead(lastAgent);
  }, [ready, visible, documentVisible, terminal, atBottom, lastAgent, onRead]);
  const unreadBoundary = unreadAtOpen ? findUnreadBoundary(page?.turns ?? [], readBoundary) : null;
  const prompts = useRef<HTMLFieldSetElement>(null);
  const reviewPending = useRef(false);
  function focusRequest() {
    prompts.current?.focus({ preventScroll: true });
    prompts.current?.scrollIntoView({ block: 'nearest' });
  }
  function reviewRequest() {
    if (terminal) { reviewPending.current = true; onToggleTerminal(); }
    else focusRequest();
  }
  useEffect(() => {
    if (!terminal && reviewPending.current) { reviewPending.current = false; focusRequest(); }
  }, [terminal]);
  useEffect(() => {
    if (!ready || !session.handle) { setLive(null); return; }
    let alive = true; let refreshing = false; let receivedLive = false;
    const refresh = async () => {
      if (refreshing) return; refreshing = true;
      try {
        const next = unwrap<ConversationPage>(await connection.request('conversation', { handle: session.handle }));
        if (alive) setPage(old => old ? { turns: [...old.turns.filter(t => !next.turns.some(n => n.id === t.id)), ...next.turns].sort((a, b) => a.ts.localeCompare(b.ts) || a.id - b.id), nextCursor: old.nextCursor } : next);
      } catch (e) { if (alive) onError(messageFor(e)); } finally { refreshing = false; }
    };
    const transcript = transcriptRefresh(refresh);
    const unsub = connection.onEvent((event, data) => {
      const next = data as SessionLivePayload;
      if (event !== 'session:live' || next.pid !== session.pid || next.sessionId !== session.sessionId || !alive) return;
      receivedLive = true; setLive(next); transcript.request();
    });
    void connection.request('watch', { handle: session.handle }).then(r => { if (!r.ok && alive) onError('Could not watch this session. Reopen it from the list.'); });
    void connection.request('live', { handle: session.handle }).then(r => { if (r.ok && alive && !receivedLive) setLive(r.value as SessionLivePayload); });
    void connection.request('previews', { handle: session.handle }).then(r => { if (r.ok && alive) setPreviews(r.value as Preview[]); });
    transcript.request(); const timer = setInterval(() => transcript.request(), 5000);
    return () => { alive = false; unsub(); transcript.close(); clearInterval(timer); void connection.request('watch', { handle: null }); };
  }, [connection, ready, session.handle, session.pid, session.sessionId, onError]);
  useLayoutEffect(() => {
    if (latestRequest === 0) return;
    bottom.current = true; setAtBottom(true);
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [latestRequest]);
  useLayoutEffect(() => { if (bottom.current && scroll.current) { scroll.current.scrollTop = scroll.current.scrollHeight; setAtBottom(true); } }, [page, visible, terminal, documentVisible]);
  async function send() {
    if (sending || (!draft.trim() && !images.length)) return; setSending(true);
    try {
      const result = unwrap<{ status: string; reason?: string }>(await connection.sendReply(session.handle!, draft, images.map(image => image.file)));
      if (result.status === 'interrupted') throw new Error('The reply may have been sent. Check the terminal before trying again.');
      if (!['sent', 'queued'].includes(result.status)) throw new Error(`Reply refused: ${result.reason ?? result.status}. Check Terminal.`);
      setDraft(''); clearImages(); writeLocal(draftKey, '');
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
      bottom.current = false; setAtBottom(false); setPage(p => ({ turns: [...next.turns.filter(t => !p?.turns.some(n => n.id === t.id)), ...(p?.turns ?? [])], nextCursor: next.nextCursor }));
      requestAnimationFrame(() => { if (scroll.current) scroll.current.scrollTop += scroll.current.scrollHeight - priorHeight; });
    } catch (e) { onError(messageFor(e)); } finally { setLoadingOlder(false); }
  }
  const hasPrompt = ready && !!(live?.prompt || live?.codex?.prompts.length);
  const waiting = ready && (live?.activity === 'waiting' || !!live?.prompt || !!live?.codex?.prompts.some(prompt => prompt.isBlocking !== false));
  if (!session.handle) return <p className="mobile-empty">Fleet cannot verify this session yet. Check its desktop view.</p>;
  return <LocalWebsiteContext.Provider value={websiteAccess}>
    {showPreviews && <section className="mobile-websites" aria-label="Project websites"><div className="mobile-website-heading"><h3>Websites</h3><button type="button" aria-label="Hide websites" onClick={() => setShowPreviews(false)}>×</button></div><div className="mobile-previews">{previews.map(p => p.available ? <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer">Open {p.label}</a> : <span key={p.id}>{p.label} — server unavailable</span>)}</div>{!previews.length && <p>No websites connected for this folder. Paste a localhost address below and keep its development server running on your Mac.</p>}<button disabled={!ready || checkingPreviews} onClick={() => void refreshPreviews()}>{checkingPreviews ? 'Checking…' : 'Refresh websites'}</button><LocalWebsiteInput /></section>}
    {terminal ? <><TerminalView key={String(ready)} pid={session.pid} bridge={bridge} /><div className="mobile-keys">{[['Esc', '\x1b'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['Ctrl-C', '\x03'], ['Enter', '\r']].map(([label, data]) => <button key={label} disabled={!ready || !controlling} onClick={() => { void bridge.sendRaw(session.pid, data!).catch(e => onError(messageFor(e))); }}>{label}</button>)}</div></> : <>
      <div className="mobile-transcript" ref={scroll} onScroll={() => { const el = scroll.current; if (el) { const remaining = el.scrollHeight - el.clientHeight - el.scrollTop; bottom.current = remaining < 100; setAtBottom(remaining <= 1); } }}>
        {page?.nextCursor && <button disabled={loadingOlder || !ready} onClick={() => void older()}>Load earlier messages</button>}
        {!page && <p>{ready ? 'Loading conversation…' : 'Reconnect to read the conversation.'}</p>}
        {page?.turns.map(turn => <Fragment key={turn.id}>{unreadBoundary?.beforeTurnId === turn.id && <div className="mobile-new-since" role="separator">New since your last visit</div>}<article data-role={turn.role}><small>{turn.role === 'user' ? 'You' : session.provider}</small><MarkdownText text={turn.text} /></article></Fragment>)}
        <fieldset disabled={!ready} className="mobile-prompts" ref={prompts} tabIndex={-1} aria-label="Session requests">{ready && live?.prompt && <PromptCard pid={session.pid} prompt={live.prompt} onOpenTerminal={onTerminal} answerPrompt={(_pid, key, value) => answer('answerClaude', key, value)} />}{ready && live?.codex?.prompts.map(prompt => <CodexPromptCard key={prompt.key} pid={session.pid} prompt={prompt} onOpenTerminal={onTerminal} answerPrompt={(_pid, key, value) => answer('answerCodex', key, value)} />)}</fieldset>
      </div>
    </>}
      {!terminal && <div className="mobile-attachments">{images.map((image, index) => <figure key={image.url}><img src={image.url} alt={image.file.name} /><button type="button" disabled={sending} aria-label={`Remove ${image.file.name}`} onClick={() => { URL.revokeObjectURL(image.url); setImages(old => old.filter((_, i) => i !== index)); }}>×</button></figure>)}</div>}
      {ready && (waiting || hasPrompt ? <div className="mobile-attention-strip">
        <span className="mobile-activity" data-activity="waiting_input"><StatusIcon activity="waiting_input" size={20} /><span role="status">{waiting ? 'Waiting on you' : 'Needs your input'}</span></span>
        {hasPrompt ? <button type="button" onClick={reviewRequest}>Review request</button> : !terminal ? <button type="button" onClick={onTerminal}>Open terminal</button> : <span className="mobile-attention-hint">Answer in the terminal</span>}
      </div> : live?.activity === 'working' ? <div className="mobile-working-strip"><WorkingStrip provider={session.provider} since={live.since} /></div> : null)}
      <form className="mobile-composer" onSubmit={e => { e.preventDefault(); void send(); }}>{!terminal && <><label htmlFor="mobile-reply" className="visually-hidden">Reply</label><textarea id="mobile-reply" value={draft} disabled={sending} placeholder={session.controllable ? 'Message this session…' : 'This session is view only'} onChange={e => { setDraft(e.target.value); try { writeLocal(draftKey, e.target.value); } catch { onError('Draft could not be saved on this device. Keep this page open.'); } }} /></>}<div className="mobile-reply-tools" role="group" aria-label="Reply tools"><label className="mobile-image-picker" title="Upload image"><ImageIcon size={22} aria-hidden="true" /><input type="file" aria-label="Upload images" accept="image/png,image/jpeg,image/gif,image/webp" multiple disabled={!ready || !session.controllable || sending || images.length >= MOBILE_IMAGE_LIMIT} onChange={e => { pickImages(e.target.files); e.target.value = ''; }} /></label><button type="button" disabled={!terminal && (!session.controllable || !ready)} onClick={onToggleTerminal}>{terminal ? 'Conversation' : 'Terminal'}</button><MobileSessionMenu pid={session.pid} sessionId={session.sessionId} canClose={ready && session.controllable} onClose={onClose} onWebsites={() => { setShowPreviews(true); if (ready) void refreshPreviews(); }} />{!terminal && <button className="mobile-send" disabled={!ready || !session.controllable || (!draft.trim() && !images.length) || sending}>{sending ? 'Sending…' : 'Send'}</button>}</div></form>
  </LocalWebsiteContext.Provider>;
}
