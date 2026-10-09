# Reliable Fleet Codex conversations

## User intent

Fleet is the user's single place for LLM conversations. Codex sessions started in Fleet must behave seamlessly: several conversations in one folder stay distinct, restarting Fleet preserves the conversation, sending remains usable in Conversation mode, and the main agent's questions and approvals can be answered there. Recover automatically when possible; expose manual recovery only when automatic recovery fails or identity cannot be established safely.

## Existing behavior and evidence

- Claude supplies a verified process/session file. Codex uses a per-TUI relay to observe successful thread switches and stores thread identity in tmux options.
- A missing relay currently turns a known saved conversation into an unknown session. Sending only verifies a tmux terminal exists and can falsely report delivery to a disconnected TUI.
- The native Codex TUI retries its connection at the same endpoint for up to 120 seconds, preserving its draft and resuming the exact thread. An exhausted TUI needs a replacement.
- Codex 0.162.0 replays outstanding server requests after a thread/resume subscription. Fleet's observer can receive and answer these independently of the TUI.
- Fleet drops MCP elicitation prompts, uses request IDs without a connection generation, and has incomplete WebSocket bounds/validation.

## Design

Extend the existing native TUI, relay, daemon and observer flow. No provider replacement, new dependencies, global Codex configuration changes, or prompt auto-approval.

1. Separate the last verified conversation identity from connection readiness. Persist atomic, versioned relay state in tmux. Physical disconnection retains a verified thread; switching or invalid observation cannot keep a misleading live binding. Readable saved history does not grant permission to send.
2. Recover a missing relay at the same socket first, preserving a TUI that is still retrying. Serialize attempts and use bounded asynchronous backoff. Native reconnection must resume the same exact thread.
3. When the TUI has exhausted recovery, resume the verified thread through a replacement Fleet relay/TUI. Never launch a fresh thread as a substitute. Verify the resumed ID before selecting or reporting success. Preserve the previous native terminal and its draft, with durable predecessor/successor links; show one current conversation card. Do not create an unbounded chain of preserved terminals or retry processes.
4. Keep Conversation selected across replacement, preserve its draft/attachments, and transfer its live watch to the replacement PID. A stale asynchronous recovery must not steal selection from another conversation. Refuse sending until the target's fresh binding is ready.
5. Subscribe to the main thread for prompts and rely on server replay after reconnect. Bind action keys to the subscription generation. Display commands, file changes, requested permissions, blocking/nonblocking questions, and common MCP elicitation approvals/forms with server-derived choices. Keep unsupported/native verification ceremonies visible with a truthful fallback.
6. Build all responses in main from the stored request. Reject stale keys, wrong threads, invalid fields, unoffered persistence, and renderer-supplied permissions. Never automatically accept a prompt or verification ceremony.

## Scope and compatibility

- Prioritize sessions launched by Fleet. Ordinary external sessions retain their existing paths.
- Preserve Claude behavior and all unrelated working-copy edits.
- Fix the Codex sidebar's child-agent preview contamination as part of the session display repair; it is distinct from prompt delivery.
- Legacy relay metadata needs conservative compatibility: a proven ready binding is usable, but an invalidated old ID cannot silently become an authoritative live identity.
- Normal Fleet shutdown and tests must not terminate user TUIs, relays or the shared daemon.

## Verification

Use current Vitest tests and meaningful regression cases. Exercise two sessions sharing a folder, physical disconnection versus a pending/failed switch, missing relay recovery, exhausted native retry, repeated recovery, draft preservation, app observer restart with pending prompts, stale request ID reuse, wrong-thread prompts and malformed transport input. Run typecheck and the relevant suite, then the full suite and app build. Use disposable local socket/tmux sessions for lifecycle probes and the real installed app-server with a local mocked model endpoint if feasible. No test may restart the user's shared daemon. Verify the packaged/running build before claiming a deployed fix.

## Execution

The user explicitly requested Sol agents to do the work followed by primary-agent review. Work in the isolated fix/codex-conversation-recovery worktree. Implementation is sequential where files/interfaces overlap. Root reviews implementation and integration before applying or packaging it for the user's checkout.
