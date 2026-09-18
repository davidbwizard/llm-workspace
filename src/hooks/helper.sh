#!/bin/sh
# llm-workspace hook helper. Spec §5.4.
#
# Runs inside the user's agent sessions, so it must be fast and must never
# block. Shell, not Node: node's startup alone is 40-80ms and this runs on
# every hook of every session.
#
# Writes ONE FILE PER EVENT with an atomic rename. Appending to a shared
# JSONL would interleave partial lines when several sessions fire at once,
# and the watcher could read a half-written record.
#
# Write-only by design: never reads app state, never prompts, always exits 0.
set -u

SPOOL="${LLMWS_SPOOL:-${HOME:-/tmp}/.llm-workspace/spool}"
# Spec §4 "Spool privacy": the spool now holds commands and plan text, so
# any directory this creates (including parents mkdir -p makes along the
# way) must come out 0700, not the default 0755. mkdir has no chmod step
# of its own -- umask is the only lever -- so it is set right before the
# one mkdir call that needs it.
umask 077
mkdir -p "$SPOOL" 2>/dev/null || exit 0

if command -v uuidgen >/dev/null 2>&1; then
  EVENT_ID=$(uuidgen)
else
  EVENT_ID="$(date -u +%s)-$$-${RANDOM:-0}"
fi

OCCURRED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP="$SPOOL/.$EVENT_ID.tmp"

# The hook payload arrives on stdin as JSON. Ancestry (PPID) is recorded as a
# hint only: hooks run with no controlling terminal, so this does NOT make
# process identity exact (spec §5.4, §7.2).
{
  printf '{"event_id":"%s","occurred_at":"%s","ppid":%s,"payload":' \
    "$EVENT_ID" "$OCCURRED" "${PPID:-0}"
  PAYLOAD=$(cat)
  case "$PAYLOAD" in
    \{*) printf '%s' "$PAYLOAD" ;;
    *)   printf '{"raw":"unparsed"}' ;;
  esac
  printf '}\n'
} > "$TMP" 2>/dev/null || exit 0

mv -f "$TMP" "$SPOOL/$EVENT_ID.json" 2>/dev/null || rm -f "$TMP" 2>/dev/null
exit 0
