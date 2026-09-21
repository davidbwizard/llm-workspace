# Design: first-run checks, so the app works on someone else's Mac

Status: drafted 2026-09-21, not approved, not built. Written after David asked
how to get the app in front of other people. The packaging answer (sign and
notarise, $99/year, GitHub Releases) is deliberately NOT this document: it is
the smaller problem. This is the one that decides whether a stranger's copy
does anything at all.

## 1. The finding this rests on

**A packaged app launched from Finder cannot see the tools this app depends
on.** A GUI process on macOS inherits a minimal `PATH` -- roughly
`/usr/bin:/bin:/usr/sbin:/sbin` -- not the one a shell builds from the user's
profile. `tmux` lives in `/opt/homebrew/bin` on this machine; `claude` and
`codex` live wherever their installer put them. None of those are on a
Finder-launched app's `PATH`.

`src/main/tmux.ts:30` calls `execFileSync('tmux', ...)`, resolved from whatever
`PATH` the process was handed. Nothing anywhere in `src/` reads, repairs or
even mentions `PATH`. The app works today only because it is always started
from a terminal with `npm run dev`.

So the first question is not "is tmux installed", it is "can this process see
it". On a packaged build, today, the answer is no -- for every dependency, on
every Mac, including David's. This would look exactly like "the app is broken",
and it would be the first thing every new user hit.

## 2. Resolving the real PATH

Ask the user's login shell once, at startup, and cache it for the process:

```
$SHELL -ilc 'printf %s "$PATH"'
```

Constraints, none optional:

- **Bounded.** A login shell runs the user's profile, which can be slow or can
  hang. Short timeout, SIGKILL on expiry, and fall back to the inherited `PATH`
  rather than blocking startup. `execFileSoft` in `src/discovery/live.ts`
  already has this shape; reuse it rather than writing a second one.
- **Take the PATH and nothing else.** Read one variable. Never evaluate the
  shell's output, never import the rest of its environment.
- **Validate before use.** Split on `:`, drop entries that are empty, relative,
  or absurdly long. A profile is user-controlled input, not a trusted source.
- **Never run it as a shell string.** Every later call stays `execFile` with an
  argument array and an explicit `env`, as the codebase already does.

This is not optional polish: without it, every check in section 3 reports
"missing" on a machine where everything is installed.

## 3. What gets checked

Three dependencies, each with a free, non-prompting probe. **No probe may ever
send a prompt to a model.** Every command below is local and costs nothing.

| Dependency | Probe | What it proves |
|---|---|---|
| tmux | `tmux -V` | present, and which version |
| Claude Code | `claude --version`, then `claude doctor` | present; installation healthy |
| Codex | `codex --version`, then `codex doctor` | present; installation, config and auth healthy |

Both CLIs ship a `doctor` subcommand for exactly this. `claude doctor`'s own
help states it reads settings in the current directory **without a trust
prompt**, which is what makes it safe to run unattended. `codex doctor`
diagnoses installation, config, auth and runtime health.

**Treat `doctor` as a signal, not a data source.** Use the exit code and keep
the output for the person to read. Do not parse it for meaning: it is a
human-facing diagnostic whose wording will change, and an app that infers state
from its phrasing becomes wrong silently on the next release. This is the same
mistake the mode switcher spec made by reading preset names out of a binary --
see `2026-09-21-mode-switcher-design.md` §3.2.

Version is recorded but nothing is gated on it. A minimum version is a promise
this app cannot keep: it has been tested against exactly one of each.

## 4. Degrade per provider, never refuse to start

The app has three independent capabilities, and a missing tool should cost
exactly one of them:

- **No tmux:** no launching and no attaching -- the core is gone. But the
  history the app has already indexed is still readable, so it opens read-only
  and says why, rather than refusing to run.
- **No `claude`:** Codex still launches. The Claude option in the launch bar is
  disabled with the reason attached, not hidden.
- **No `codex`:** the mirror of the above.

Disabled-with-a-reason beats hidden. A control that vanished teaches the person
nothing; one that is visible and explains itself teaches them what to install.

## 5. What the person sees

A first-run screen listing each dependency with its state, and for anything
missing: one line on what it is for, and the exact command, copyable. A
**Check again** button that re-runs section 3 without a restart, so a person can
fix things in a terminal and carry on without relaunching.

It is reachable afterwards from settings, because a dependency can disappear
later -- an uninstall, a Homebrew cleanup, a PATH change.

**The app does not install anything.** It does not run `brew`, it does not
download, it does not elevate. It says what is missing and what command fixes
it. Running installers on someone's machine on their behalf is a much larger
promise -- about privilege, failure and partial state -- than this app has any
reason to make.

## 6. The hooks install is consent, not a step

The app writes hooks into the user's Claude Code configuration. On the author's
own machine that is invisible; on a stranger's it is the app modifying a config
file they own.

- Show exactly what will be written, and to which file, before writing it.
- Ask once, and take no for an answer -- the app still runs, with less.
- Offer a clean uninstall that removes what it added and nothing else.
- Never rewrite entries the app did not put there.

A tool that quietly edits your config is a tool you stop trusting the moment
you notice, and the noticing is always worse than the asking.

## 7. Verification

- Unit: the PATH parser, against a slow shell, a shell that fails, empty
  output, and a profile emitting junk entries. Each must fall back rather than
  throw or hang.
- Unit: each probe's handling of present, missing, non-zero exit and timeout.
  The four must be distinguishable -- "missing" and "broken" are different
  sentences to the person.
- Integration: run the probes against the real binaries on this machine.
- **By eye, and this is the one that matters: a packaged build, launched from
  Finder, not from a terminal.** Every claim in section 1 is about that case,
  and `npm run dev` cannot test it. Build with `npm run dist:mac`, open the
  `.app` from Finder, and confirm the checks pass on a machine where everything
  is installed.

## 8. Open questions for David

1. Should the app remember "do not ask me again" for a missing optional
   provider, or re-check every launch?
2. If `doctor` reports unhealthy but the binary runs, does the app block that
   provider or warn and continue? Warn-and-continue is my recommendation --
   `doctor` is advisory and the app should not be stricter than the tool.
3. Is read-only-without-tmux worth building, or should no-tmux simply be a wall
   with instructions? It depends whether the history view stands on its own,
   which is David's call, not mine.
