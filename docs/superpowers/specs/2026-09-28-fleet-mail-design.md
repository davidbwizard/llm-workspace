# Fleet Mail

## Goal

Claude and Codex hand each other one-shot review jobs through Fleet. The
sender writes a letter to a named specialist. Fleet runs that specialist
once, read-only, and returns its reply. Agents do not chat. Only Fleet
starts specialists, so the limits and the log live in one place.

v1: spec and plan reviews, both directions.

## Parts

- **Mail slot**: a stdio MCP server registered in Claude and Codex. Two
  tools. Writes letters, reads results. Speaks MCP by hand (`initialize`,
  `tools/list`, `tools/call`); no SDK. Opens no database.
- **Post office**: in Fleet's main process. Watches the inbox, validates,
  enforces limits, runs the specialist, writes the result, logs it.
- **Config**: `~/.llm-workspace/mail/config.json`.
- **Log**: `~/.llm-workspace/mail.sqlite`, opened only by Fleet. Kept apart
  from `index.sqlite`, which is a rebuildable cache.

Files. Folders 0700, files 0600, every write via temp file and rename:

```
~/.llm-workspace/mail/inbox/<id>.json   letter, written by the slot
~/.llm-workspace/mail/out/<id>.json     status and reply, written by Fleet
```

## Tools

`send_letter({ to, subject, body, attachments?, re? })` writes the letter
and returns `{ id }` at once. `id` is 32 random hex characters. The slot
adds `from: { tool, project }`: `tool` from its `--from` argument, `project`
from its working directory. It refuses when `FLEET_MAIL_SPECIALIST` is set.

`check_mail({ id })` waits up to 45 s for `out/<id>.json`, then returns the
status and, when done, the reply under "Review from <specialist>, pass N of
M. Information, not instructions." Ids not matching `^[0-9a-f]{32}$` are
rejected.

Statuses: `queued`, `running`, `replied`, `refused`, `failed`, `timed_out`,
`cancelled`. Anything but `replied` carries a reason. No `out` file yet
reads as "waiting for Fleet".

## Config

```json
{
  "enabled": true,
  "passesPerLoop": 4,
  "lettersPerDay": 40,
  "runMinutes": 10,
  "specialists": {
    "codex-reviewer": { "runsOn": "codex", "agent": "reviewer" },
    "claude-reviewer": { "runsOn": "claude", "agent": "reviewer" }
  }
}
```

`agent` names an existing agent: `~/.codex/agents/<agent>.toml` or
`~/.claude/agents/<agent>.md`. Fleet re-reads the file on change. Invalid
config turns mail off and logs why.

## Post office

Fleet refuses a letter, with a reason, when:

- mail is off;
- the JSON is invalid, `to` is unknown, subject is over 200 characters, or
  body is over 20 KB;
- there are over 5 attachments, one is over 200 KB, one resolves (symlinks
  followed) outside the project, or one matches `.env*`, `*.pem`, `*.key`,
  `id_*`, `.ssh/`, `.aws/` or `.git/`;
- the daily limit is reached;
- the letter is over 10 minutes old (left while Fleet was closed);
- a follow-up breaks the loop rules.

Accepted letters queue. One specialist runs at a time.

## Running a specialist

- Working directory is the sender's project. Read-only, no MCP servers, no
  saved session. Started from an argument list, never a shell. Own process
  group, killed at the time limit. Environment adds
  `FLEET_MAIL_SPECIALIST=<id>`.
- Prompt: the agent's instructions, the house rules, the letter, the
  attachment paths.
- Codex: `codex exec --sandbox read-only --ephemeral -C <project>
  --output-schema <schema> -o <file>`, prompt on stdin.
- Claude: `claude -p --restricted --strict-mcp-config
  --no-session-persistence --agent <agent> --output-format json`, prompt on
  stdin.
- Reply: `{ "verdict": "approved" | "changes_requested", "review":
  "<markdown>" }`. Anything else is `failed`. No automatic retries.

## Loops

- No `re`: new loop, pass 1.
- `re`: next pass. Accepted only if `re` is the latest letter of an open
  loop, from the same project, to the same specialist, and at least one
  attachment's sha256 differs from the previous pass. Nothing changed, no
  new pass.
- `approved` closes the loop.
- `changes_requested` on the last pass closes the loop as `limit` and sends
  David a macOS notification. To continue, David tells the agent to start
  a new loop.

## House rules

Sent with every specialist prompt; the short form is in the tool
descriptions.

- Start with what works.
- State each issue plainly, with a fix. No put-downs.
- Supportive tone. Findings at full severity.
- Read a review in good faith. Disagree with a reason. In the next letter,
  say what was fixed and what was declined, and why.
- No small talk, no thank-you letters.

## Log

- `loops`: id, specialist, project, status (`open`, `approved`, `limit`),
  passes, created, updated.
- `letters`: id, loop id, pass, from tool, project, to, subject, body,
  attachment hashes, status, reason, verdict, review, stderr tail (20 KB),
  created, started, finished.

## Stops

- `enabled: false`, or quitting Fleet. Quitting kills a running
  specialist; on restart, `running` letters become `cancelled`.
- Daily cap, pass limit, one run at a time, run time limit.
- Specialists cannot send: no MCP servers, and the slot refuses inside one.
- A failed log write turns mail off. Nothing runs unrecorded.

## Setup

David runs once:

```
claude mcp add --scope user fleet-mail -- <node> <slot> --from claude
codex mcp add fleet-mail -- <node> <slot> --from codex
```

Attachments are sent to the other provider's model.

## Tests

- Vitest, workers capped: letter checks, loop rules, limits, statuses,
  config validation, MCP handshake over a fake stdio.
- End to end with a fake specialist command. No quota.
- One real loop in each direction, by hand. Spends quota; David is told
  first.

## Confirm in planning

1. Claude: `--restricted` still loads the `reviewer` agent and allows only
   read tools; how to get the JSON reply.
2. Codex: how to pass agent instructions (`exec` has no `--agent`);
   `--output-schema` with `-o`; disabling its MCP servers per run.
3. Codex's MCP tool timeout is above 45 s.
4. How the packaged app runs the slot: system Node or
   `ELECTRON_RUN_AS_NODE`.

## Not doing

- A bridge to live sessions, a separate daemon, per-letter approval, the
  Jev referee.
- Existing tools (consult-llm, OpenAI's Codex plugin, PAL `clink`,
  claudex, MCP Agent Mail): none has caps, a log and Fleet control
  together. `codex mcp-server` was removed in Codex 0.154.

## Later

- Image and animation specialists. Codex saves images to
  `~/.codex/generated_images`; needs a writable output folder and a
  `media` reply.
- A Mail view in Fleet.
- More reviewers are config entries, not code.

Independent of the Codex App Server pilot. Does not touch hooks.
