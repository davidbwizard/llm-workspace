import { expect, it, vi } from 'vitest';
import { CodexSubscriptions } from '../../src/main/codexSubscriptions.ts';
function observer() { return { watch: vi.fn((_id: string, _changed: () => void) => {}), stop: vi.fn(), snapshot: vi.fn(() => null), answer: vi.fn(() => ({ status: 'refused' as const, reason: 'stale' as const })) }; }
it('shares a thread observer until the last client releases it', () => {
  const o = observer(); const factory = vi.fn(() => o); const p = new CodexSubscriptions(factory);
  const desktop = vi.fn(); const phone = vi.fn();
  p.watch('desktop', 'a', desktop); p.watch('phone', 'a', phone);
  expect(factory).toHaveBeenCalledOnce();
  o.watch.mock.calls[0]![1]();
  expect(desktop).toHaveBeenCalledOnce(); expect(phone).toHaveBeenCalledOnce();
  p.release('desktop'); expect(o.stop).not.toHaveBeenCalled();
  p.release('phone'); expect(o.stop).toHaveBeenCalledOnce();
});
it('does not replace another thread or route an answer to it', () => {
  const a = observer(); const b = observer();
  const p = new CodexSubscriptions(vi.fn().mockReturnValueOnce(a).mockReturnValueOnce(b));
  p.watch('desktop', 'a', () => {}); p.watch('phone', 'b', () => {});
  p.answer('b', 'key', {});
  expect(b.answer).toHaveBeenCalledWith('b', 'key', {}); expect(a.answer).not.toHaveBeenCalled();
  p.release('phone'); expect(a.stop).not.toHaveBeenCalled(); p.stop(); expect(a.stop).toHaveBeenCalledOnce();
});
