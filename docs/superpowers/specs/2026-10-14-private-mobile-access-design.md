# Private mobile access to Fleet

Status: core design approved in conversation on 2026-10-14; implementation plan written for review. Includes the requested private website-preview workflow.

## Intent and agreed scope

David wants to pick up an existing Fleet session on his own phone or tablet and continue working, then return to the desktop. The same agent process, conversation and working files remain on the Mac. Access is browser-based, with a home-screen entry, and privately connected through Tailscale. Keep tmux as the session backend.

The first version includes the live session list, conversations, replies, supported approval/question forms, launching a session in an existing project, and an interactive terminal. Existing sessions that Fleet already controls must work without restarting the agent or migrating the session. Sessions Fleet only detects remain limited to their existing capabilities; mobile access does not make arbitrary terminal or native desktop-app sessions controllable.

The Mac must remain awake, online and running Fleet. Quitting Fleet makes the mobile service unavailable. Independent background service installation, wake-on-demand, public hosting, multiple users, push notifications and native mobile apps are outside this version. Phone/tablet operating systems are not yet specified; use standard browser APIs and verify on David's actual devices before declaring delivery complete.

## Existing code and constraints

- `src/preload/index.ts` exposes `window.fleet` through Electron IPC. `src/renderer/App.tsx` requires that bridge. Serving the renderer unchanged is insufficient.
- `src/main/ipc.ts` already implements discovery payloads, conversation reads, guarded sends, prompt answers, launch and terminal operations. Preserve those checks and reuse their underlying functions through explicit adapters.
- Terminal attachments are currently keyed only by PID, with output sent to one `BrowserWindow`. A second attachment succeeds without creating a separate viewer. Detach and resize also act by PID alone.
- `src/main/sessionLive.ts` has a singleton `watchState`; selecting a second session replaces the first watch.
- `CodexAppServer.watch()` stops its previous thread subscription. Multiple screens selecting different Codex threads require separate subscriptions, with shared ownership for screens viewing the same thread.
- `src/main/index.ts` owns discovery, ingestion and application shutdown. Keep one instance of these services and one database owner.

These are required integration changes, not permission to refactor unrelated IPC or provider code. Existing working-copy changes to `App.tsx`, its tests and `docs/FEATURES.md` must be preserved.

## Architecture

```text
Phone/tablet browser
        |
Private HTTPS through Tailscale Serve
        |
Fleet HTTP service on Mac loopback
        |
Explicit Fleet operations and subscriptions
        |
Existing discovery / conversations / approvals / tmux
        |
Same live Claude and Codex sessions
```

Run an opt-in local HTTP service within Fleet's main process. Serve a production browser bundle and an explicit, versioned API. Keep Electron IPC for the desktop and add a browser adapter for mobile. Share types and reusable conversation, prompt and terminal components; make desktop-only capabilities explicit so mobile does not invoke native dialogs or window operations.

Use HTTP for reads and mutations, and an authenticated WebSocket for live events and terminal traffic. Preserve existing refusal results. Do not forward arbitrary IPC names or expose the Codex app-server transport. A maintained WebSocket implementation is preferable to extending Fleet's handwritten Codex protocol observer into a general server; any new dependency must be justified in the implementation plan before installation.

The browser initially receives a current snapshot and subsequently receives bounded updates. Reconnection retrieves fresh state and then resumes subscriptions. It never launches or resumes an agent merely because the browser reconnects.

## Private access and authorization

Use Tailscale Serve with HTTPS and access rules restricted to David's devices. Bind Fleet's service only to `127.0.0.1`; do not enable public Funnel access or listen on the LAN. Setup is opt-in and shows whether the private endpoint is ready. Disabling access closes remote connections and stops the listener without terminating sessions.

Configure the exact allowed HTTPS hostname and David's expected Tailscale login locally. Require the trusted Serve identity header on every API request and WebSocket upgrade; missing or mismatched identity fails closed. Serve strips client-supplied identity headers before forwarding. The loopback service trusts local processes on this Mac, consistent with Fleet's existing local-user boundary; it is not isolation from compromised local software.

Validate Host and the exact Origin for mutations and socket upgrades. Do not enable cross-origin API access. Require a short-lived anti-CSRF value obtained through an authenticated same-origin bootstrap for mutations and socket establishment; never put credentials in URLs. Use restrictive content-security and framing policies, and prevent browser caching of transcripts, terminal output and API responses. A home-screen manifest is sufficient initially; no offline action queue or transcript-caching service worker.

Validate inputs at the remote boundary and again in the existing operation layer. Apply finite connection, request-size, message-size, rate and outbound-buffer limits. Reject excess load explicitly; disconnect slow terminal clients without affecting agent processes. Record action type, target identity and result for diagnosis, excluding prompts, terminal contents, credentials and file bodies.

Remote launches select a server-issued project identifier from directories already known to Fleet. Resolve and revalidate the real directory server-side. No arbitrary command execution endpoint, raw filesystem browser, global settings modification, hook installation, kill/reattach operation or native file-reveal endpoint is exposed in this version. The interactive terminal still grants the normal authority of the selected terminal session; API restrictions do not sandbox terminal commands.

## Multiple devices and session identity

Give each browser connection and desktop window its own client identity and subscription lifecycle. Share a session's underlying live watcher while it has subscribers; removing one subscriber cannot stop another. Reference-count Codex subscriptions by verified thread and route snapshots and answers to that thread's observer. Destroy the observer only after its last subscriber leaves. Selecting Claude on the phone cannot stop Codex observation on the desktop.

Every mutation binds to a server-verified session identity and process generation, not a bare PID or working directory. Revalidate immediately before input. A stale session, PID reuse, thread switch or expired prompt returns a refusal and refreshes the UI. Preserve all existing provider-specific validation and consent rules.

Serialize conversation sends and prompt answers per session across desktop and mobile. A prompt is resolved once: a second answer gets a stale result. Assign request IDs and deduplicate repeated requests within the current server generation using a bounded result ledger. The client must not automatically resend mutations after disconnection. If execution may have happened but acknowledgment was lost, show an uncertain result and refresh the conversation before offering an explicit retry. After a server restart, old requests cannot be replayed under the new generation. Do not claim exactly-once delivery across a process crash.

## Terminal behavior

Separate attachments by client and verified session. Closing a browser cleans up only its tmux client, listeners and buffers. It must never kill the underlying session or detach the desktop viewer.

Within Fleet, permit one active terminal input/resize owner per session. Opening a terminal acquires ownership when free; another Fleet viewer can explicitly take control. Broadcast ownership changes, reject input from the previous owner and release ownership after a bounded disconnected-client timeout. The ordinary single-device path needs no extra confirmation. Conversation actions remain serialized with terminal input; do not allow a remote approval to race a terminal submission.

tmux still has one underlying pane size. The owner controls that size; viewers render the current size without resizing it merely because their viewport or phone keyboard changed. Test the tmux sizing options with real disposable sessions before relying on this policy. Outside terminal clients remain outside Fleet's ownership mechanism and can still affect the shared session; do not promise independent terminal layouts.

A reconnect performs a fresh attach/redraw after identity validation. Buffer sizes and client counts are capped, output is batched, and inactive browser tabs do not accumulate unlimited terminal history on the server. Input typed while disconnected remains visibly unsent and is never replayed automatically.

## Mobile interaction

On a phone, show the session list first, then a full-width conversation with a visible way back to sessions. On a tablet, retain a session rail when space permits. Keep the current Fleet typography, colors and provider distinctions.

Replies and approval choices use touch-sized controls. Terminal is an explicit view with Escape, Tab, Ctrl-C and arrow-key controls, correct paste handling, touch scrolling and external-keyboard support. Account for safe areas, rotation and the software keyboard. Keep connection state visible and disable actions until the server has revalidated the selected session after reconnect.

Selection, scroll position and unsent drafts are local to each device in this version. Submitted messages and actual session state appear everywhere. An unsent desktop draft does not silently move to the phone. Persist mobile drafts only on the device, keyed by exact session identity, and never discard them because a request timed out. File uploads and general file browsing are deferred; display unsupported actions truthfully rather than leaving broken desktop buttons.

## Lifecycle and compatibility

Mobile connections do not create a second discovery loop, database writer or Fleet instance. Closing the desktop window on macOS may leave the existing Fleet main process and mobile service running; client cleanup must not stop remote subscriptions. Cmd-Q stops the service and reports disconnection. Verify current provider lifecycle behavior rather than assuming every Codex process survives Fleet shutdown.

Keep desktop behavior unchanged when remote access is disabled. Readiness and setup errors are explicit. Do not change system sleep settings or Tailscale configuration silently; document the required setup and expose an intentional keep-awake option only if included in the reviewed implementation plan.

## Private development previews

Add an Open preview action for explicitly configured development servers associated with a project. David can ask an agent to change a site, open the actual site in his phone's browser, test it, then return to Fleet with feedback. This supports websites, web apps and browser games. Native desktop/mobile windows require their own remote-desktop or device-build workflow and are not served by this feature.

Store preview definitions locally on the Mac. Each definition binds a project to a label, a loopback development-server port and a separate private HTTPS origin. Use Tailscale Serve to forward that origin to the configured loopback port. Never publish arbitrary ports discovered in agent output, accept a remote-supplied proxy target, or mount development content under Fleet's own origin. A different HTTPS port is a different browser origin; Fleet's control interface uses no cross-port authentication cookies and still checks the exact Origin and anti-CSRF value. Preview links open in a separate tab with opener isolation. Projects may have several explicitly named previews.

Do not rewrite application source or weaken host/CORS checks automatically. Document exact host allowlisting, WebSocket forwarding for live reload, relative or separately reachable API URLs, and OAuth redirect configuration where the application needs them. A successful HTML response alone does not prove the site's backend or live reload works. Verify those paths on an actual phone. Development-server creation and lifecycle remain with the agent/project; opening a preview does not start or stop a process.

Setup must preserve any pre-existing Tailscale Serve mappings. Configuring or removing one Fleet/preview endpoint cannot reset unrelated services. Only activate the explicitly reviewed private mappings; verify the reported endpoint is private before presenting it as ready.

## Verification and acceptance

Use existing Vitest infrastructure, typecheck and the production app/browser builds. Add meaningful coverage for:

- Missing/wrong identity, wrong Host/Origin, CSRF, malformed inputs, limits, unauthorized operations and slow-client cleanup.
- Desktop and mobile watching different sessions, including two Codex threads, without replacing each other's watchers.
- Two viewers answering one prompt, concurrent sends, stale identities, PID reuse and lost acknowledgments without duplicate submission.
- Phone disconnect/lock/reconnect, server restart, browser refresh and device revocation without terminating live agents.
- Terminal ownership, resize arbitration, separate detach, output backpressure and old connections sending after takeover.
- Launching only a validated known project and receiving the exact new session identity.

Use disposable tmux sessions for terminal integration tests; do not kill or repurpose David's live sessions. Then manually verify one already-running Fleet Claude session and one already-running Fleet Codex session from David's phone/tablet, including an approval, reply and terminal handoff. Verify both home Wi-Fi and a different network. Verify the running Fleet process and build correspond to the tested changes before claiming success.

Success means David can continue an existing controllable session from his phone, lock the phone while work continues, reconnect without duplicated input, and return to the desktop with the same conversation and agent. Unsupported sessions remain clearly identified. No claim of complete delivery until the real-device checks pass.

## Sources

- [Tailscale Serve: private HTTPS, identity headers and loopback trust](https://tailscale.com/docs/features/tailscale-serve)
- [Existing Fleet Codex recovery design](2026-10-09-codex-conversation-recovery-design.md)

## Next review

Review this written design before producing the implementation plan. The plan should separate the client/subscription changes, private transport, mobile UI and end-to-end verification while keeping the complete first-version scope above.
