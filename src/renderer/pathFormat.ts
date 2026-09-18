/** Pure path formatting for MainPane's conversation header (no node
 *  imports -- same "safe to import from anywhere in src/renderer/**"
 *  contract as usageFormat.ts).
 *
 *  The renderer has no reach to the real machine's home directory
 *  (contextIsolation/sandbox, spec §11.1's own boundary) and that is not
 *  worth a new IPC channel just to learn one string. Home directories on
 *  every platform this app ships for already live at a recognisable,
 *  two-segment prefix -- /Users/<name> on macOS, /home/<name> on Linux --
 *  so this matches that shape directly off the cwd the renderer already
 *  has (OpenSession.cwd), rather than asking main for the real one. A path
 *  that doesn't match (Windows, anything unusual) comes back unchanged --
 *  the honest "skip the ~ part" case, never a guess dressed up as one. */
export function abbreviateHome(path: string): string {
  const m = /^\/(?:Users|home)\/[^/]+(\/.*)?$/.exec(path);
  if (!m) return path;
  return `~${m[1] ?? ''}`;
}
