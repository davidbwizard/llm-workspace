#!/bin/sh
# llm-workspace status line feed ("Usage and context", usage design Part A).
#
# Claude Code runs this on every status update (debounced to 300ms) with a
# JSON snapshot of the session on stdin: context window use and, for Pro and
# Max, the 5-hour and weekly rate limits. It runs locally and costs no
# tokens. Shell, not Node, for the same reason as helper.sh: it runs inside
# every session, often.
#
# Write-only, like helper.sh: never reads app state, never prompts, prints
# nothing (the status line row stays empty) and always exits 0. One file per
# session, replaced by an atomic rename, so the app never reads a
# half-written snapshot, and a run Claude cancels mid-write leaves the last
# good one in place.
set -u

# C locale: byte-wise tr/sed, and [A-Za-z] means exactly ASCII letters.
LC_ALL=C
export LC_ALL

# The app only ever reads under $HOME; with no home there is nowhere
# private to write, so do nothing rather than fall back to a shared /tmp.
[ -n "${HOME:-}" ] || exit 0
DIR="$HOME/.llm-workspace/statusline"

# Files come out 0600 and every directory mkdir -p creates 0700.
umask 077
mkdir -p "$DIR" 2>/dev/null || exit 0

# mktemp creates the file exclusively (never follows a planted name).
TMP=$(mktemp "$DIR/.statusline.XXXXXX" 2>/dev/null) || exit 0
trap 'rm -f "$TMP" 2>/dev/null' EXIT
trap 'exit 0' HUP INT TERM PIPE

# Size cap: read at most one byte past 64 KB; anything longer is dropped.
head -c 65537 > "$TMP" 2>/dev/null || exit 0
SIZE=$(wc -c < "$TMP" 2>/dev/null | tr -d ' \t')
case "$SIZE" in ''|*[!0-9]*) exit 0 ;; esac
[ "$SIZE" -gt 0 ] && [ "$SIZE" -le 65536 ] || exit 0

# The top-level session_id. Splitting on , { } puts every key/value pair on
# its own line, so the pattern can be anchored to the whole line; a
# "session_id" quoted inside a string value is escaped (\") and never
# matches. Top-level session_id comes before any nested object, so the
# first match wins.
SID=$(tr ',{}' '\n\n\n' < "$TMP" 2>/dev/null \
  | sed -n 's/^[[:space:]]*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]*\)"[[:space:]]*$/\1/p' 2>/dev/null \
  | head -n 1)

# Only [A-Za-z0-9_-]{1,128} ever becomes a file name.
case "$SID" in ''|*[!A-Za-z0-9_-]*) exit 0 ;; esac
[ "${#SID}" -le 128 ] || exit 0

mv -f "$TMP" "$DIR/$SID.json" 2>/dev/null
exit 0
