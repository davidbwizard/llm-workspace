/** The rules for a session name typed in the launch bar -- the ONE launch
 *  input a person writes free-hand.
 *
 *  Its own module, and deliberately not in identity.ts beside
 *  SESSION_ID_SAFE: identity.ts imports node:crypto, and the renderer may
 *  only take RUNTIME values from node-free modules under src/core (see
 *  tests/renderer/bundle.test.ts for what that rule costs when it is
 *  broken). LaunchBar checks these for immediate feedback; main checks them
 *  again at the IPC boundary (launchCommand, src/main/launch.ts) rather
 *  than trusting that it did -- the renderer's check is an affordance, not
 *  an enforcement. */

/** The longest session name this app will launch with. Claude Code sets no
 *  documented limit of its own; this one exists so a name can never grow
 *  into an unbounded string on a command line, and so a card or the
 *  conversation header has a bounded thing to render. */
export const SESSION_NAME_MAX = 64;

/** A session name safe to put on a command line. newSession
 *  (src/main/tmux.ts) hands its command to `tmux new-session` as a single
 *  string and tmux runs that string through a SHELL, so an unconstrained
 *  name containing `;`, `$(...)` or a backtick would execute. The quoting
 *  in launch.ts is the other half of that defence; neither replaces this.
 *
 *  The class admits letters, digits, space, '.', '_' and '-' and NOTHING
 *  else -- no shell metacharacter can appear at all, and neither can a
 *  control byte, a newline or a NUL. Two anchoring rules beyond the class:
 *
 *   - The FIRST character must be a letter or digit. A leading '-' is not
 *     shell-special, but `claude` itself would read it as another FLAG
 *     rather than as the value of -n ('-p', '--dangerously-skip-...').
 *   - The LAST character may not be a space, so a name is never silently
 *     different from the one that was typed.
 *
 *  Length is capped by the pattern itself as well as by SESSION_NAME_MAX
 *  above, so a caller that forgets the explicit length check still cannot
 *  get an oversized name past this. */
export const SESSION_NAME_SAFE = new RegExp(
  `^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,${SESSION_NAME_MAX - 2}}[A-Za-z0-9._-])?$`,
);

/** The one sentence the UI and main both show when a name is refused. Says
 *  what IS allowed, not just that something was wrong -- a person who typed
 *  "my/proj" needs to know what to type instead. */
export const SESSION_NAME_HELP =
  `Use letters, numbers, spaces, dots, dashes or underscores -- up to ${SESSION_NAME_MAX} characters, starting with a letter or number.`;

/** Shown wherever the name field is disabled. `codex --help` carries no
 *  launch-time name flag (checked 2026-09-22), so the field is disabled
 *  WITH THIS REASON rather than hidden -- the same call this app already
 *  makes for a missing dependency and for the mode chip on a session it did
 *  not launch. */
export const SESSION_NAME_CODEX_REASON =
  'Codex has no way to set a name when it starts. Launch it, then rename it from the session.';

/** The kind of name Claude derives for itself, used as the field's
 *  placeholder so the box explains itself without a line of help text. */
export const SESSION_NAME_PLACEHOLDER = 'llm-workspace-4a';
