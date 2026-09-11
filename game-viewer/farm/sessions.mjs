import { ACTIVITIES } from './definitions.mjs';

const boundedText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);

/** Validate the entire snapshot before its consumer mutates any farm state. */
export function normalizeSnapshot(input) {
  if (!input || input.version !== 1 || !Number.isSafeInteger(input.revision) || input.revision < 0
    || typeof input.connected !== 'boolean' || !Array.isArray(input.sessions) || input.sessions.length > 512) throw new Error('Invalid session snapshot.');
  const sessions = input.sessions.map(s => {
    if (!s || !boundedText(s.id, 160) || !boundedText(s.name, 80) || !boundedText(s.provider, 32)
      || !ACTIVITIES.includes(s.activity) || (s.parentId != null && !boundedText(s.parentId, 160))) throw new Error('Invalid session identity or activity.');
    let attention = null;
    if (s.attention != null) {
      const a = s.attention;
      if (!boundedText(a.id, 160) || !boundedText(a.kind, 40) || typeof a.text !== 'string' || a.text.length > 2000 || !a.text.trim()) throw new Error('Invalid session question.');
      attention = { id: a.id, kind: a.kind, text: a.text };
    }
    return { id: s.id, name: s.name, provider: s.provider, activity: s.activity, parentId: s.parentId ?? null, attention };
  });
  const byId = new Map(sessions.map(s => [s.id, s]));
  if (byId.size !== sessions.length) throw new Error('Session IDs must be unique.');
  const roots = new Map(sessions.filter(s => !s.parentId).map(s => [s.id, { ...s, descendants: [] }]));
  if (roots.size > 64) throw new Error('At most 64 root sessions are supported.');
  for (const s of sessions) {
    if (!s.parentId) continue;
    const seen = new Set([s.id]); let current = s;
    while (current.parentId) {
      if (seen.has(current.parentId)) throw new Error('Session ancestry contains a cycle.');
      seen.add(current.parentId); current = byId.get(current.parentId);
      if (!current) break; // Unattributed children do not become new farmers.
    }
    if (current && roots.has(current.id)) roots.get(current.id).descendants.push(s);
  }
  return { ...input, sessions, roots: [...roots.values()] };
}

/** Manual, deterministic demo source. It has no access to real processes. */
export function createSessionSimulator() {
  let revision = 1, nextId = 4, nextQuestion = 1, disposed = false;
  let sessions = ['Rowan', 'Mira', 'Ash'].map((name, i) => ({
    id: `demo-${i + 1}`, name, provider: 'demo', activity: 'working', parentId: null, attention: null,
  }));
  const listeners = new Set();
  const snapshot = () => structuredClone({ version: 1, revision, connected: true, sessions });
  const check = () => { if (disposed) throw new Error('Session simulator is closed.'); };
  const publish = () => { revision++; for (const cb of listeners) cb(snapshot()); };
  return {
    snapshot,
    subscribe(cb) { check(); if (typeof cb !== 'function') throw new Error('A snapshot callback is required.'); listeners.add(cb); cb(snapshot()); return () => listeners.delete(cb); },
    add() {
      check(); if (sessions.filter(s => !s.parentId).length >= 64 || sessions.length >= 512) throw new Error('The farm has reached its worker limit.');
      const n = nextId++, id = `demo-${n}`;
      sessions.push({ id, name: ['Juniper', 'Oak', 'Wren', 'Sage', 'Fern'][(n - 4) % 5] + (n > 8 ? ` ${n}` : ''), provider: 'demo', activity: 'working', parentId: null, attention: null });
      publish(); return id;
    },
    setActivity(id, activity, text = 'Should I continue with the current approach?') {
      check(); const s = sessions.find(s => s.id === id);
      if (!s || !ACTIVITIES.includes(activity)) throw new Error('Unknown session or activity.');
      if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('Question text must contain 1–2000 characters.');
      s.activity = activity;
      s.attention = activity.startsWith('waiting_') ? { id: `demo-question-${nextQuestion++}`, kind: activity === 'waiting_permission' ? 'permission' : 'question', text } : null;
      publish();
    },
    remove(id) {
      check(); if (!sessions.some(s => s.id === id)) throw new Error('Unknown session.');
      const removed = new Set([id]);
      for (let i = 0; i < sessions.length; i++) for (const s of sessions) if (removed.has(s.parentId)) removed.add(s.id);
      sessions = sessions.filter(s => !removed.has(s.id)); publish();
    },
    addChildren(id, count) {
      check(); const parent = sessions.find(s => s.id === id && !s.parentId);
      if (!parent || !Number.isInteger(count) || count < 1 || count > 64 || sessions.length + count > 512) throw new Error('Choose a root session and 1–64 child agents.');
      for (let i = 0; i < count; i++) { const n = nextId++; sessions.push({ id: `demo-${n}`, name: `Helper ${n}`, provider: 'demo', activity: 'working', parentId: id, attention: null }); }
      publish();
    },
    dispose() { listeners.clear(); disposed = true; },
  };
}
