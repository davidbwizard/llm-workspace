export type PreviewOpenResult = { ok: true; url: string } | { ok: false; message: string };

/** Transcript links are untrusted. Accept explicit HTTP loopback origins,
 * not URL's alternative numeric IP spellings or arbitrary local services. */
export function parseLocalPreviewUrl(raw: unknown): { port: number; path: string } | null {
  if (typeof raw !== 'string' || raw.length > 8192 || /[\s\\\x00-\x1f\x7f]/.test(raw)) return null;
  const match = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):([0-9]{1,5})(?=\/|[?#]|$)/i.exec(raw);
  if (!match) return null;
  const port = Number(match[1]);
  if (port < 1024 || port > 65535) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    return { port, path: url.pathname + url.search + url.hash };
  } catch { return null; }
}
