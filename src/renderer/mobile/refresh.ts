/** Status can update at stream speed; transcript reads stay within their API budget. */
export function transcriptRefresh(read: () => Promise<void>) {
  let last = -Infinity; let running = false; let requested = false; let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function request(): void {
    if (closed) return; requested = true;
    if (running || timer) return;
    const delay = Math.max(0, last + 1000 - Date.now());
    timer = setTimeout(() => { timer = undefined; void run(); }, delay);
  }
  async function run(): Promise<void> {
    if (closed) return; requested = false; running = true; last = Date.now();
    try { await read(); }
    finally { running = false; if (requested) request(); }
  }
  return { request, close() { closed = true; clearTimeout(timer); } };
}
