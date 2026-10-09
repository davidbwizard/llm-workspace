# Codex Conversation Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. The user selected Sol implementation agents and primary-agent review.

**Goal:** Keep Fleet-launched Codex conversations automatically recoverable, writable, and able to show and answer main-agent prompts in Conversation mode.

**Architecture:** Retain the existing native TUI/relay/daemon flow. Separate verified thread identity from transport readiness; repair the existing endpoint before replacing an exhausted TUI. Use app-server replay for prompt recovery.

**Tech Stack:** TypeScript, Electron, React, tmux, Unix WebSockets, SQLite and existing Vitest tests.

**Spec:** ../specs/2026-10-09-codex-conversation-recovery-design.md

## Global Constraints

- Sol agents implement; primary reviews after. No worker subagents.
- No new dependencies or test frameworks, global Codex configuration edits, or changes to Claude semantics.
- Do not terminate or send test messages to user sessions or restart the shared daemon.
- Exact verified thread ID is required for recovery and all conversation actions. Folder/time inference cannot authorize a Fleet session action.
- Preserve conversation and native-terminal drafts; keep one visible current conversation after a verified replacement.
- Main constructs prompt responses from the original server request. Renderer input never supplies raw RPC IDs, permission profiles or unoffered persistence.
- No automatic approvals; unsupported/native verification ceremonies remain visible and require their proper client.
- Keep retries, fragmented messages, pending callback storage and preserved terminal chains bounded.
- Workers own only their assigned files. They are not alone in the codebase and must not revert others' edits.

## Review Focus

1. Disconnect during a thread switch must not resume the old conversation by mistake.
2. Repeated failures must not spawn an unbounded collection of terminals or duplicate user messages.
3. Selection changes while recovery is pending must not redirect a different conversation.
4. Numeric request IDs reused after reconnect must not let an old card answer a new prompt.
5. Fleet restart while a main-agent question or MCP approval is pending must restore an answerable card.

## Task 1: Prompt transport and main-agent prompt support

**Files:** src/core/codexPrompt.ts, src/main/codexAppServer.ts, src/renderer/components/CodexPromptCard.tsx, tests/main/codexAppServer.test.ts, tests/renderer/CodexPromptCard.test.tsx. A focused new transport/form utility is permitted if necessary to avoid bloating the existing module. Coordinate decoder-only changes in codexRelayProtocol.ts before editing.

**Interfaces:** Preserve CodexAppServer.watch, snapshot, answer and existing IPC answer arguments. Extend CodexPrompt as a discriminated view with offered actions and validated fields. Keep raw requests only in main. Keys become opaque per-subscription-generation handles.

- [ ] Add failing tests for pending request replay after reconnect/new observer; stale old keys with reused numeric IDs; cross-thread filtering; duplicate replay after send; blocking and nonblocking questions; MCP approvals with nullable turn and absent item; required typed form validation; offered session persistence; file-change previews.
- [ ] Add transport tests for fragmented total-size overflow, continuation order, control FIN/size, RSV and invalid UTF-8.
- [ ] Implement bounded transport handling, generation-scoped request storage, supported request normalization and server-built responses.
- [ ] Render common main-agent prompts and unsupported/native ceremony fallbacks. Answers must reflect offered options only.
- [ ] Run focused tests with local sockets permitted and typecheck; report exact results and source-derived limitations.

## Task 2: Exact identity and automatic backend recovery

**Files:** src/main/codexRelayProtocol.ts (tracker), src/main/codexRelay.ts, src/main/codexRelayControl.ts, src/main/launch.ts, src/main/sessions.ts, src/main/index.ts, src/main/ipc.ts, src/main/sessionLive.ts, src/fleet/state.ts; focused new recovery module/core types; corresponding tests.

**Interfaces:** Introduce readCodexRelayBinding(pid) returning authoritative thread and connection state (ordinary processes return null). Add versioned atomic persisted identity. Add a recover operation accepting a PID only; main resolves cwd, ownership and exact thread. Return verified replacement PID and session ID. Publish enough recovery/replacement metadata for Task 3 without exposing arbitrary command/socket control.

- [ ] Add failing identity-state tests (successful switch, pending/failed/stale/ephemeral switch, physical disconnect and invalid observation).
- [ ] Add recovery tests for same-endpoint relay restoration, native retry grace, exact resume confirmation, failure/backoff/coalescing, repeated sweeps, validated successor reuse and bounded predecessor retention.
- [ ] Implement recovery using validated server-owned launch arguments. Persist recovery links by tmux names rather than recycled PIDs. Never auto-submit user text or kill an old native terminal with a draft.
- [ ] Feed durable readable identity and readiness into Fleet/live payloads; suppress only validated replaced cards and preserve previous-terminal access.
- [ ] Add fresh guards before message/prompt/mode actions into a Fleet Codex terminal. Refuse disconnected/unknown targets without modifying draft or terminal state.
- [ ] Fix sidebar preview root-agent filtering and verify full conversation behavior remains correct.
- [ ] Run focused tests and typecheck; document the exact frontend payload/recovery contract for Task 3.

## Task 3: Seamless Conversation recovery UI

**Files:** src/preload/index.ts, src/renderer/types.d.ts, src/renderer/state/useFleet.ts, src/renderer/components/MainPane.tsx, src/renderer/components/ConversationView.tsx, src/renderer/state/pending.ts and focused tests/styles as required.

**Interfaces:** Consume Task 2's recovery and validated replacement payload. Preserve Conversation selection and draft/attachment identity; invoke manual retry only after automatic recovery fails. Existing sendKeys call continues through fresh main guards.

- [ ] Add failing tests for same-folder isolation, replacement selection remap without switching views, stale async result after selecting another session, draft/attachment preservation and manual retry failure.
- [ ] Render quiet reconnecting feedback while preserving transcript and editable draft. Send becomes usable only after the exact resumed thread is ready.
- [ ] Preserve access to the prior native terminal for its unsent draft, without a duplicate current conversation card.
- [ ] Keep unsupported identity states explicit; never disguise a newly launched conversation as recovery.
- [ ] Run renderer tests, typecheck and integration tests.

## Task 4: Primary review, lifecycle proof and delivery

- [ ] Review all diffs for spec compliance, security boundaries, resource bounds and backward compatibility.
- [ ] Run full existing tests and app build. Resolve failures attributable to these changes; report unrelated baseline failures separately.
- [ ] Run disposable actual-app-server/relay probes for session identity, connection recovery and pending prompt replay without touching user sessions.
- [ ] Apply reviewed commits to the user's checkout preserving its uncommitted changes, package the app and verify the running artifact before claiming it is installed.
