import { expect, it, vi } from 'vitest';
import { transcriptRefresh } from '../../src/renderer/mobile/refresh.ts';
it('coalesces live events while keeping transcript reads under the read budget', async () => {
  vi.useFakeTimers();
  try {
    const read = vi.fn(async () => {}); const refresh = transcriptRefresh(read);
    for (let i = 0; i < 240; i++) { refresh.request(); await vi.advanceTimersByTimeAsync(250); }
    expect(read.mock.calls.length).toBeLessThanOrEqual(61); expect(read.mock.calls.length).toBeGreaterThan(50);
    refresh.close(); const before = read.mock.calls.length; await vi.advanceTimersByTimeAsync(5000); expect(read).toHaveBeenCalledTimes(before);
  } finally { vi.useRealTimers(); }
});
