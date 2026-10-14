# Private Mobile Fleet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Continue and launch Fleet Claude/Codex sessions from David's phone/tablet, with private website previews and safe desktop coexistence.

**Architecture:** Retain the existing Electron main process, databases, provider integrations and tmux sessions. Add explicit client-scoped services behind both desktop IPC and a private HTTP/WebSocket adapter, plus a mobile renderer using the existing conversation and prompt components. Tailscale Serve provides private HTTPS; selected project previews use separate origins.

**Tech Stack:** TypeScript, React, Electron, node-pty, tmux, existing SQLite stores, Node HTTP, Tailscale Serve, Vitest. Propose `ws` and `@types/ws` for a bounded, standards-compliant WebSocket server rather than implementing WebSocket framing again; approve this dependency with this plan before installation. Do not add a UI framework or test system.

**Spec:** `docs/superpowers/specs/2026-10-14-private-mobile-access-design.md`

## Global Constraints

- Keep tmux as the session backend.
- The Mac must remain awake, online and running Fleet.
- Every mutation binds to a server-verified session identity and process generation, not a bare PID or working directory.
- The client must not automatically resend mutations after disconnection.
- Do not forward arbitrary IPC names or expose the Codex app-server transport.
- Keep desktop behavior unchanged when remote access is disabled.
- Existing working-copy changes to `App.tsx`, its tests and `docs/FEATURES.md` must be preserved.
- Use disposable tmux sessions for terminal integration tests; do not kill or repurpose David's live sessions.
- No claim of complete delivery until the real-device checks pass.

## Review Focus

1. A reconnect after input was accepted but its reply was lost must not submit twice: Tasks 3 and 6.
2. A stale phone can target a reused PID, changed thread or expired approval: Tasks 2 and 3.
3. Opening another Codex thread or closing the desktop window must not stop the phone's observer: Tasks 1 and 8.
4. A preview page may contain hostile code; it must not reach Fleet controls: Tasks 5 and 7.
5. A phone keyboard resize or suspended tab must not resize/detach the desktop terminal or exhaust memory: Tasks 4 and 6.

## Preparation and execution policy

- [ ] Record `git status --short`, current branch/commit and existing diffs. Create an isolated feature worktree using the worktree skill at execution time; do not stash or reset the existing edits. Keep the root checkout as-is. If the feature must be integrated with the uncommitted shortcut change later, apply the feature's scoped commits without overwriting that change.
- [ ] Read the spec and this plan; create the execution ledger. Record any necessary adjustment there.
- [ ] Use the installed dependencies for the baseline. Run `npm test`, `npm run typecheck`, and `npm run build:app`, capturing output to the ledger directory. Expected: all pass, or identify exact pre-existing failures before attributing any to this feature. Respect the project's Node/Electron native ABI checker; do not rebuild shared native dependencies while the user's app is using them.
- [ ] Work through each task in red/green order. Each task ends with its focused tests and typecheck. Commit only that task's files using a message file and `git commit -F`; no push, merge, app restart or network exposure is implied by a code commit.

## File boundaries

| Area | Responsibility |
|---|---|
| `src/core/remote.ts` | Browser-safe request/event/result types and protocol version |
| `src/main/sessionLive.ts` | Shared session watchers with separate subscriber lifetimes |
| `src/main/codexSubscriptions.ts` | One Codex observer per verified thread with reference-counted clients |
| `src/main/sessionOperations.ts` | Existing operation reuse, server-owned identities and project handles |
| `src/main/sessionActions.ts` | Cross-device serialization, prompt claims and bounded request receipts |
| `src/main/terminalClients.ts` | Terminal viewers, ownership, size and cleanup |
| `src/main/remote/config.ts` | Strict local opt-in settings and preview definitions |
| `src/main/remote/auth.ts` | Proxy identity, Host/Origin checks, bootstrap tickets and limits |
| `src/main/remote/server.ts` | Explicit HTTP routes, WebSocket lifecycle and production assets |
| `src/renderer/mobile/` | Browser entry, API adapter, reconnect state, responsive shell |
| `src/main/remote/previews.ts` | Validated project-to-preview links; no arbitrary proxy |
| `docs/remote-access.md` | Setup, private mappings, troubleshooting and acceptance record |

Do not move unrelated IPC handlers. Extract only bodies reused by the new adapter, preserving their validation and result shapes.

### Task 1: Multiple session and Codex subscribers

**Files:** Modify `src/main/sessionLive.ts`, `src/main/ipc.ts`, `src/main/index.ts`; create `src/main/codexSubscriptions.ts`; update `tests/main/sessionLive.test.ts`; create `tests/main/codexSubscriptions.test.ts`.

**Interfaces:** Add `subscribeSession(clientId: string, pid: number | null, deps: WatchDeps): boolean` and `releaseSessionClient(clientId: string): void`. Preserve `watchSessionFor` as a desktop-compatibility wrapper until IPC is migrated. `pushSessionLive` and `notifySessionChanged` fan out once per watched session. `CodexSubscriptions` exposes `watch(clientId, threadId, changed)`, `release(clientId)`, `snapshot(threadId)`, `answer(threadId, key, answer)` and `stop()`; it owns existing `CodexAppServer` instances.

- [ ] Add failing tests using the existing session-live fixtures: two clients on different PIDs both receive updates; two clients on one PID share a filesystem watcher; releasing one leaves the other alive; invalid PID does not replace a valid subscription; `/clear` moves the identity; a failed watcher closes once. Add a fake observer factory with `watch`, `stop`, `snapshot`, `answer` spies to test pool ownership:

```ts
it('does not stop another client on the same Codex thread', () => {
  const observer = { watch: vi.fn(), stop: vi.fn(), snapshot: vi.fn(), answer: vi.fn() };
  const pool = new CodexSubscriptions(() => observer);
  pool.watch('desktop', 'thread-a', () => {});
  pool.watch('phone', 'thread-a', () => {});
  pool.release('desktop');
  expect(observer.stop).not.toHaveBeenCalled();
  pool.release('phone');
  expect(observer.stop).toHaveBeenCalledTimes(1);
});
```

- [ ] Run `npm test -- tests/main/sessionLive.test.ts tests/main/codexSubscriptions.test.ts`; expected failure on missing multi-client behavior, after imports resolve.
- [ ] Implement a client-to-session map and session-to-subscribers map. Preserve existing immediate snapshot, 250 ms coalescing and discovery backstop. Centralize each thread's Codex request store so two screens cannot independently answer the same request. Replace singleton `codexAppServer.snapshot/answer/watch/stop` usages in IPC with the pool, preserving the existing class for low-level protocol tests.
- [ ] Run the above tests plus `tests/main/codexAppServer.test.ts` and typecheck; expected pass. Commit the isolated subscription change.

### Task 2: Explicit operations and fresh session/project handles

**Files:** Create `src/core/remote.ts`, `src/main/sessionOperations.ts`, `tests/main/sessionOperations.test.ts`; modify only reusable handlers in `src/main/ipc.ts` and relevant desktop types.

**Interfaces:** Define the following browser-safe primitives and operation boundary. The concrete factory receives existing database/discovery/provider functions; no module imports an Electron window merely to perform a session operation.

```ts
export type ClientId = string;
export type SessionHandle = string;
export type ProjectHandle = string;
export type OperationResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'invalid' | 'stale' | 'unavailable' | 'unsupported' | 'busy' };
export interface SessionOperations {
  list(): unknown;
  projects(): Array<{ id: ProjectHandle; label: string }>;
  resolve(handle: SessionHandle): { pid: number; sessionId: string; provider: 'claude' | 'codex' } | null;
  read(client: ClientId, operation: 'conversation' | 'live', payload: unknown): Promise<OperationResult>;
  mutate(client: ClientId, operation: 'send' | 'answerClaude' | 'answerCodex' | 'launch', payload: unknown): Promise<OperationResult>;
  release(client: ClientId): void;
}
```

- [ ] Add failing integration tests with an in-memory database and injected discovery: preserve existing fleet list entries and annotate capability/handle; reject a PID supplied instead of a handle; reject a changed tmux binding, Claude start identity or Codex thread; reject unknown project, removed directory and symlink target change. Use two sessions in one working directory to prove routing is not by cwd.
- [ ] Run `npm test -- tests/main/sessionOperations.test.ts`; expected failure for missing handle validation and operations.
- [ ] Issue random handles bound to fresh provider/session/process identity and tmux ownership. Read process start identity when issuing and revalidate before mutation; do not derive identity from rounded process age. Unverified sessions may be listed/read according to existing capabilities but have no mutation handle. Project handles resolve to canonical directories from known sessions/favourites, rechecked before launch. Move the existing guarded send/answer/launch bodies into callable functions; retain their refusal explanations and admission checks. Return actual launch identity and never guess from the current selection.
- [ ] Route desktop actions through the same callable functions without changing the desktop's public behavior. Run operation tests, IPC tests, existing send/answer/launch tests and typecheck; expected pass. Commit.

### Task 3: Cross-device mutations and lost acknowledgments

**Files:** Create `src/main/sessionActions.ts`, `tests/main/sessionActions.test.ts`; modify operation/IPC adapters from Task 2.

**Interfaces:** `SessionActions.run(sessionHandle, requestId, fingerprint, effect): Promise<OperationResult>`; `claimPrompt(sessionHandle, promptKey): boolean`; `close(): void`. Server generation is a random value returned in bootstrap; every remote mutation carries it. Receipts are bounded to 1,024 entries and expire after 30 minutes; an expired request ID cannot be transparently retried by the browser. A duplicate with a different fingerprint is invalid.

- [ ] Write failure cases for simultaneous phone/desktop send, double approval, duplicate request while in flight, duplicate after success, request-ID reuse with changed body, rejection cleanup, full ledger and stale generation. Pin the no-duplicate behavior with an actual effect counter:

```ts
it('runs one effect for a retried request', async () => {
  const actions = new SessionActions();
  let calls = 0;
  const effect = async (): Promise<OperationResult> => ({ ok: true, value: ++calls });
  const replies = await Promise.all([
    actions.run('s1', 'request-1', 'same-body', effect),
    actions.run('s1', 'request-1', 'same-body', effect),
  ]);
  expect(calls).toBe(1);
  expect(replies[0]).toEqual(replies[1]);
  actions.close();
});
```

- [ ] Run `npm test -- tests/main/sessionActions.test.ts`; expected failure before coordinator implementation.
- [ ] Serialize by verified session, insert receipts before effects, reserve each approval while executing, and preserve sent/uncertain states. Revalidate after waiting in the queue. Bound queued actions (32 per session), reject overflow and time out queued work after 30 seconds without treating an already-executing effect as canceled. Enforce generation before dispatch. Never report a transport timeout as proof that the action failed.
- [ ] Run coordinator, operation, prompt and IPC tests and typecheck. Expected pass; commit.

### Task 4: Independent terminal viewers and one Fleet controller

**Files:** Create `src/main/terminalClients.ts`, `tests/main/terminalClients.test.ts`; modify `src/main/ipc.ts`, `src/main/tmux.ts`, `src/preload/index.ts`, `src/renderer/components/TerminalView.tsx`; extend `tests/main/stream-bridge.test.ts`.

**Interfaces:** `TerminalClients.attach(clientId, sessionHandle, cols, rows, send)`, `takeControl(clientId, sessionHandle)`, `resize(clientId, sessionHandle, cols, rows)`, `input(clientId, sessionHandle, data)`, `release(clientId)`, `close()`. Use existing attach/resize/raw result unions extended with an explicit `not_controller` refusal. Output events include attachment ID and sequence so old sockets cannot deliver into a replacement terminal.

- [ ] Write failing tests: two viewers receive output; detaching phone leaves desktop and agent alive; ownership takeover rejects the former owner; only the owner changes pane size; disconnect releases ownership within 15 seconds; reconnect does not replay raw input; stale attachment events are ignored. Add disposable real-tmux tests for pane sizing, attach flags and detach survival using the existing test helpers.
- [ ] Run `npm test -- tests/main/terminalClients.test.ts tests/main/stream-bridge.test.ts`; expected failure on multi-client behavior.
- [ ] Extract the current PTY lifecycle into a client-keyed manager. Apply tmux ignore-size/read-only attach behavior where verified by the real test; choose an explicit session-scoped sizing policy so observer clients cannot shrink the shared pane. Gate all Fleet raw input/resize by ownership. Programmatic replies and approval actions must coordinate with active terminal control and revalidate the prompt; refuse conflicting actions instead of interleaving bytes. Existing non-Fleet clients remain outside this arbitration.
- [ ] Cap each outbound queue at 1 MiB and at most eight remote connections overall. Disconnect a slow viewer and release only its resources. Batch output through the existing coalescer. Handle PTY exit and reattach errors explicitly, without launching another agent.
- [ ] Run focused tests, existing terminal renderer tests and typecheck; expected pass. Commit.

### Task 5: Private HTTP/WebSocket service and production browser build

**Files:** Create `src/main/remote/config.ts`, `auth.ts`, `server.ts`; create matching `tests/main/remoteConfig.test.ts`, `remoteAuth.test.ts`, `remoteServer.test.ts`; create `vite.mobile.config.ts`; modify `package.json`, `package-lock.json`, `tsconfig.json` if needed and `electron.vite.config.ts` only where packaging requires it.

**Interfaces:** `RemoteConfig` below; `startRemoteServer(config, operations, terminals): Promise<{ close(): Promise<void> }>`; `authorize(request, config): boolean`. Read local opt-in settings from `~/.llm-workspace/remote.json`, with a strict schema and atomic desktop-controlled writes. Missing/disabled config starts no listener. Misconfiguration produces a visible readiness error.

```ts
export interface RemoteConfig {
  enabled: boolean;
  port: number;
  origin: string;
  login: string;
  previews: Array<{ id: string; project: string; label: string; localPort: number; url: string }>;
}
```

- [ ] Write table-driven authorization tests: missing/wrong/duplicate proxy login, wrong Host, cross-origin POST/upgrade, invalid CSRF, stale server generation and IPv6/LAN bind attempts. Add real loopback HTTP tests with temporary assets for traversal, unexpected methods, malformed JSON, body limit, rate limit, disabled service and graceful shutdown. Add WebSocket tests with real sockets for unauthenticated frames, fragmented/oversized messages, ping timeout, unknown operation and bounded queues.
- [ ] Run `npm test -- tests/main/remoteConfig.test.ts tests/main/remoteAuth.test.ts tests/main/remoteServer.test.ts`; expected failures for missing server behavior.
- [ ] Install the approved `ws` runtime dependency and `@types/ws` development types using npm; retain lockfile. Use `WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false })`; authenticate upgrade before `handleUpgrade`. Accept only JSON envelopes with known version, operation, client and generation; before authentication no app operations are available.
- [ ] Bind HTTP to `127.0.0.1`, with 10-second header timeout, 30-second request timeout, 64 KiB JSON limit, eight remote connections and per-client 120 API requests/minute. Raw terminal frames have their own 256 KiB/second budget and the queue caps from Task 4. Authentication failures are rate-limited without logging credentials. Bootstrap generates a 256-bit CSRF ticket valid for 10 minutes, delivered only to the same-origin browser; refresh before expiry. Authenticate the socket's first message within five seconds with the ticket, then bind the connection to a server-generated client ID. Never place tickets in URLs or permit app messages before ticket validation.
- [ ] Serve only the production mobile build, with `Cache-Control: no-store` on data and HTML, strict content security, `frame-ancestors 'none'`, no CORS and no authentication cookies. Static path resolution must remain within the build directory. Expose only bootstrap/list/projects/conversation, the four Task 2 mutations, selected live subscriptions and Task 4 terminal messages. No general RPC, file reads, desktop settings or filesystem proxy.
- [ ] Add `build:mobile` using `vite build --config vite.mobile.config.ts`; include its output in app packaging and `build:app`. Run server tests, bundle checks, typecheck and both builds; expected pass. Commit.

### Task 6: Mobile shell, connection adapter and recoverable drafts

**Files:** Create `src/renderer/mobile/index.html`, `main.tsx`, `MobileApp.tsx`, `mobile.css`, `bridge.ts`, `connection.ts`, `manifest.webmanifest`; modify shared renderer components only for explicit capability props; create `tests/renderer/mobileConnection.test.ts`, `mobileApp.test.tsx`, `mobileBridge.test.ts`.

**Interfaces:** `createMobileBridge(origin): { connect(): Promise<void>; close(): void; state(): 'connecting' | 'ready' | 'offline'; request(operation: string, payload: unknown): Promise<OperationResult> }`. Its implementation maps only supported shared renderer calls to Task 5. Add explicit capabilities for launch/project picker, reply, prompts, terminal, uploads and file-open rather than dummy success methods. Desktop keeps its existing preload.

- [ ] Add failing tests for initial list, selection, conversation, Claude/Codex prompts, known-project launch and truthful unsupported sessions. Verify a lost send acknowledgment preserves the draft, shows an uncertain result and does not resend on reconnect. Check old connection events cannot change a new selection; phone selection does not alter desktop preferences.
- [ ] Run `npm test -- tests/renderer/mobileConnection.test.ts tests/renderer/mobileApp.test.tsx tests/renderer/mobileBridge.test.ts`; expected missing behavior failures.
- [ ] Build the mobile entry using existing typography and shared conversation/prompt components. Show a single pane on narrow screens and a rail plus content on tablets. Add New session with provider and known-project choices; select the actual returned session. Hide desktop-only settings and disable unsupported controls with a reason. Audit shared components' reliance on Electron navigation interception: browser links require safe schemes and `rel="noopener noreferrer"`; no raw HTML from transcripts.
- [ ] Implement read/subscription reconnection with jittered backoff capped at 10 seconds and a fresh bootstrap. Never replay send/answer/launch/raw input. Key local draft storage by exact session identity and keep it on uncertain results. Persist local selection and scroll without writing desktop prefs. Provide a visible offline/connecting state and actionable errors.
- [ ] Add mobile terminal keys, touch scrolling, paste, ownership status and takeover. Use safe-area insets and dynamic viewport sizing. A software keyboard changing viewport height must not resize a terminal unless this client owns it. Add the home-screen manifest; no service worker or offline mutation queue.
- [ ] Run the mobile tests, shared conversation/prompt/terminal tests, renderer bundle test and typecheck; expected pass. Inspect browser layouts at phone and tablet widths and check the actual keyboard behavior during Task 9. Commit.

### Task 7: Private project previews

**Files:** Create `src/main/remote/previews.ts`, `tests/main/remotePreviews.test.ts`; modify `remote/config.ts`, `remote/server.ts`, `MobileApp.tsx`; extend `mobileApp.test.tsx`.

**Interfaces:** `previewsForProject(config: RemoteConfig, canonicalProject: string): Array<{ id: string; label: string; url: string }>`; preview configuration is editable only from the Mac. A preview URL must use HTTPS, the configured Mac's private hostname and a different origin from Fleet, with no credentials, query, fragment or arbitrary upstream path. A separate HTTPS port is permitted; Fleet's authentication does not use cookies.

- [ ] Add failing tests for same-origin previews, public hostnames, credential-bearing URLs, `javascript:` links, arbitrary loopback targets, removed projects and duplicate port mappings. Assert rendered preview links have `target="_blank"` and `rel="noopener noreferrer"`. Use the real auth handler to prove requests from the preview origin cannot invoke Fleet actions or obtain a usable socket ticket.
- [ ] Run `npm test -- tests/main/remotePreviews.test.ts tests/renderer/mobileApp.test.tsx`; expected failure before preview implementation.
- [ ] Validate saved local preview definitions; return only selected project's links. Add Open preview next to the conversation/terminal controls. Do not scan ports or infer authorization from agent output. Link opening does not launch processes or mutate Tailscale configuration. If the developer server is stopped, preserve a truthful unavailable/error result rather than claiming readiness from stored configuration alone.
- [ ] Document manual per-endpoint Serve commands, leaving other mappings untouched. Example only, after selecting the actual unoccupied ports and hostname:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:43180
tailscale serve --bg --https=8443 http://127.0.0.1:3000
tailscale serve status --json
```

The Fleet config origin uses the reported HTTPS hostname; the preview uses that hostname at `:8443`. Confirm access rules and private status. Never call a global Serve reset. Document exact Vite allowed host and WebSocket settings for the project's installed version, backend URL/proxy and OAuth callback requirements; never suggest `allowedHosts: true` or unrestricted CORS.
- [ ] Run preview, server and renderer tests plus typecheck; expected pass. Commit.

### Task 8: Desktop setup, lifecycle and packaging

**Files:** Modify `src/main/index.ts`, `src/main/ipc.ts`, `src/preload/index.ts`, `src/renderer/types.d.ts`, `src/renderer/components/SettingsModal.tsx`, `SettingsModal.css`; create `src/renderer/components/RemoteSettings.tsx`, `tests/main/remoteLifecycle.test.ts`, `tests/renderer/RemoteSettings.test.tsx`; update `docs/remote-access.md` and scoped entries in `docs/FEATURES.md`.

**Interfaces:** Desktop-only IPC for `remote:get`, `remote:configure`, `remote:enable`, `remote:disable`. Configuration validation is reused from Task 5. Readiness states are `disabled`, `starting`, `ready`, `error`; include a truthful reason. Opening a preview configuration screen cannot grant remote access.

- [ ] Add failing tests for disabled default, invalid settings retaining the previous valid config, port already in use, enable/disable idempotence, disabling access closing sockets but leaving tmux alive, closing desktop releasing only desktop resources, and Cmd-Q closing all network resources before the database.
- [ ] Run `npm test -- tests/main/remoteLifecycle.test.ts tests/renderer/RemoteSettings.test.tsx`; expected failure for absent lifecycle/setup.
- [ ] Add a small desktop Remote access settings section with private origin/login/port, explicit enable, status, copyable URL and a locally generated QR code for that same URL, preview definitions and setup guidance. Atomic writes must surface errors. Start the service only after main-process dependencies are ready; subscribe it to the existing discovery/ingestion signals. Track service shutdown and stop accepting requests before closing the database. No independent daemon and no implicit keep-awake system change.
- [ ] Verify packaging includes the mobile bundle from a Finder-launched app with no Vite dev server. Keep existing shortcuts, first-run checks, hooks, mode behavior and preferences intact.
- [ ] Run lifecycle/settings tests, existing App tests, typecheck and builds. Expected pass; commit.

### Task 9: Whole-feature verification and real-device acceptance

**Files:** Extend focused regression tests where review finds gaps; record commands and device checks in `docs/remote-access.md`. Do not mark a missing real-device check as passed.

- [ ] Run `npm test`, `npm run typecheck`, `npm run build:app`; expected zero new failures and both renderer bundles produced. Inspect every result, not just exit codes. Run real tmux/socket integration cases on disposable resources.
- [ ] Obtain a fresh correctness/security review of the feature, specifically identity/Origin/CSRF, request replay, terminal ownership, safe preview isolation and leaked watchers/processes. Fix important findings with failing regression tests first. No unrelated cleanup.
- [ ] Record the running app process start time and tested commit/build. Arrange a safe launch of the feature build without killing the user's active agents; never claim a stale running app contains the changes.
- [ ] Set up Tailscale on David's actual devices, with his account sign-in/permissions where required. Inspect current Serve mappings before adding the selected private endpoints. Restrict access to his devices and verify from both home Wi-Fi and cellular/another network. Confirm an unauthorized device cannot connect.
- [ ] On phone and tablet, continue an already-running Claude session and an already-running Codex session: read, reply, answer a real prompt once, open terminal, take control and return to desktop. Start one new session of each provider in a known project. Lock the phone mid-turn, reconnect, and confirm no duplicated input. Display different Codex threads on desktop and phone at once. Disconnect one viewer while the other remains active.
- [ ] Open one actual development website, test touch/keyboard behavior, its backend calls, navigation and live reload after an agent edit. Confirm preview origin is different from Fleet and cannot invoke Fleet controls. Document any project-specific configuration accurately.
- [ ] Deliver the feature commit range, test evidence, exact private URL and any remaining device-dependent limitation. Do not mark the feature complete while required real-device checks remain unperformed.

## Plan self-review

Spec coverage: Tasks 1–4 cover client identity, watchers, prompts, input and terminal isolation; Task 5 covers private transport and validation; Task 6 covers mobile interaction and drafts; Task 7 covers previews; Task 8 covers opt-in setup/lifecycle; Task 9 covers cross-device acceptance. Every Review Focus condition has an owning test task. New types and entry points are defined above; existing provider/domain result types are reused rather than fabricated by the browser. The proposed `ws` dependency and local configuration are explicit. No network exposure or system changes happen merely by writing or committing this plan.
