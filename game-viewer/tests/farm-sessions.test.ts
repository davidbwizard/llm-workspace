import { it, expect } from 'vitest';
import { createSessionSimulator } from '../farm/sessions.mjs';
import { createFarm, applySessionSnapshot } from '../farm/model.mjs';

it('emits complete ordered snapshots and disposes subscriptions', () => {
  const source = createSessionSimulator(); const received = [];
  const unsubscribe = source.subscribe(snapshot => received.push(snapshot));
  const first = received[0]; expect(first.sessions).toHaveLength(3);
  source.setActivity(first.sessions[0].id, 'waiting_input', 'Which crop?');
  expect(received[1].sessions[0].attention.text).toBe('Which crop?');
  source.addChildren(first.sessions[0].id, 30);
  const farm = createFarm(); applySessionSnapshot(farm, source.snapshot());
  expect(farm.workers).toHaveLength(3);
  source.remove(first.sessions[0].id);
  expect(source.snapshot().sessions).toHaveLength(2);
  expect(first.sessions).toHaveLength(3);
  expect(received.at(-1).revision).toBeGreaterThan(first.revision);
  unsubscribe(); const count = received.length; source.add();
  expect(received).toHaveLength(count); source.dispose();
});
