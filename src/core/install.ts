// How to install what this app depends on -- the part BOTH sides need.
//
// Lives in core/, not beside the probe in src/main/checks.ts, for one
// concrete reason: the renderer needs HOMEBREW_URL as a runtime value, and
// checks.ts imports node:child_process. Importing a value out of it drags
// the whole main-process module graph into the renderer bundle, which
// typecheck and the unit tests both pass straight through and only
// `npm run dist:mac` catches ("join is not exported by
// __vite-browser-external"). The convention this restores is the one the
// rest of the app already keeps: the renderer imports VALUES only from
// node-free core/ modules, and only TYPES from src/main.
//
// Nothing here may import from node:.

/** Where to get Homebrew, for a Mac that has not got it. Shown as a link,
 *  never as a command: Homebrew's own install line is a pipe-to-shell, and
 *  this app does not put one of those in front of anyone. Sending someone
 *  to the project's own page lets them read it first. */
export const HOMEBREW_URL = 'https://brew.sh';

/** One confirmed way to install a dependency.
 *
 *  A list, in preference order, rather than a single string, because
 *  "`brew install x`" is useless advice on a Mac without Homebrew -- and
 *  telling someone to install a package manager is a bigger ask than this
 *  app should make casually. `requires` is what makes that visible: the UI
 *  shows a route whose requirement is met as a command to run, and one
 *  whose requirement is missing as a command that needs something first.
 *
 *  Every command shipped is verified (see DEFINITIONS in
 *  src/main/checks.ts), and none of them is a pipe-to-shell. An unverified
 *  `curl ... | sh` is the worst kind of command to get wrong, so this app
 *  ships none. */
export interface InstallRoute {
  command: string;
  /** What must already be on the machine. null when it stands on its own. */
  requires: 'homebrew' | null;
  /** One line of context -- a prerequisite, or which one the vendor
   *  recommends. null when the command needs no explaining. */
  note: string | null;
}

/** Whether this machine can actually run this route right now. The one
 *  rule, shared, so the panel and anything else that asks cannot disagree
 *  about what is runnable. */
export function routeIsRunnable(route: InstallRoute, homebrew: boolean): boolean {
  return route.requires === null || homebrew;
}
