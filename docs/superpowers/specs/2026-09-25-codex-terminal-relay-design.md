# Codex Terminal and Conversation identity

## Goal

Keep a native Codex TUI in Fleet's Terminal tab while Conversation follows the exact Codex thread, including `/new`, `/resume`, Fleet restarts, and two TUIs in the same directory.

## Design

Fleet launches each new Codex TUI through its own Unix socket relay. The relay forwards WebSocket bytes unchanged to the existing local Codex App Server daemon. It watches only the TUI's successful `thread/start`, `thread/resume`, and `thread/fork` responses and stores the resulting thread ID as a tmux session option. Fleet recovers the ID from tmux after a restart. The existing App Server client continues to subscribe to the selected thread for approval and question prompts.

The native TUI also starts ephemeral background threads for structured requests. Their `thread/start` request has `ephemeral: true`; the relay ignores it so the visible conversation remains bound to the TUI's persistent thread.

The relay runs in a separate tmux session, so it and the native TUI survive a Fleet window or process restart. It exits when its TUI tmux session ends. Both sockets are local and the Fleet socket is inside a private directory. New TUI sessions have a distinct `llmws-codex-relay-*` name, so Fleet can recognize them after a restart. Fleet accepts the mapping only while both tmux sessions are alive and the relay reports an active TUI connection. A pending switch, disconnect, malformed response, or missing relay leaves Conversation unbound rather than attached to an old thread; directory based matching is suppressed for these sessions.

Existing Codex sessions continue through the current discovery path. Claude is unchanged. No Codex hooks or global configuration are modified.

## Verification

Cover frame parsing, request/response correlation, failed switches, and tmux identity validation with existing Vitest tests. In the pilot worktree, launch a real Codex TUI through the relay, switch threads with `/new` and `/resume`, close/reopen Fleet, and check that Conversation follows the same ID. Verify typecheck, relevant tests, app build, and the actual Fleet UI before considering main.

## Limits

Codex's remote App Server transport is experimental. A relay crash disconnects its TUI until the relay is relaunched; Fleet must show that state instead of silently falling back to a different conversation. Already running bare Codex TUIs do not gain exact identity retroactively.
