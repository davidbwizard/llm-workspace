export type HostApp = 'iterm2' | 'terminal' | 'vscode' | 'claude-app' | 'codex-app' | 'unknown';

export interface LiveProcess {
  pid: number;
  tty: string | null;
  cwd: string | null;
  host: HostApp;
}

/** Parse `pgrep -x claude` output. */
export function parsePgrep(out: string): number[] {
  return out.split('\n')
    .map(l => l.trim())
    .filter(l => /^\d+$/.test(l))
    .map(Number);
}

/** Parse `ps -o tty= -p <pid>`. `??` means no controlling terminal. */
export function parseTty(out: string): string | null {
  const t = out.trim();
  return !t || t === '??' || t === '?' ? null : t;
}

/** Parse `lsof -a -p <pid> -d cwd -Fn` — the cwd is the `n`-prefixed line. */
export function parseLsofCwd(out: string): string | null {
  for (const line of out.split('\n')) {
    if (line.startsWith('n')) return line.slice(1).trim() || null;
  }
  return null;
}

/** Map a process ancestry chain to its terminal host. Spec §7.3 — this
 *  decides which jump action is offered, and VS Code deliberately gets a
 *  weaker one because a specific tab cannot be targeted.
 *
 *  `chain[0]` is the process being classified (the `claude`/`codex` CLI
 *  itself), not an ancestor — only entries after it say what spawned it.
 *  Excluded here: without this, a bare `claude` at index 0 collides with
 *  the claude-app check below and every unmatched chain misclassifies as
 *  claude-app instead of falling through to unknown. */
export function classifyHost(chain: string[]): HostApp {
  const names = chain.slice(1).map(n => n.toLowerCase());
  if (names.some(n => n.includes('iterm'))) return 'iterm2';
  if (names.some(n => n === 'code' || n.includes('code helper'))) return 'vscode';
  if (names.some(n => n === 'terminal')) return 'terminal';
  if (names.some(n => n === 'claude')) return 'claude-app';
  if (names.some(n => n.includes('chatgpt') || n.includes('codex'))) return 'codex-app';
  return 'unknown';
}
