// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountFarm } from '../farm/app.mjs';
import { createFarm } from '../farm/model.mjs';
import { createSessionSimulator } from '../farm/sessions.mjs';

let root: HTMLElement;
let dispose: (() => void) | undefined;
beforeEach(() => {
  document.body.innerHTML = '<div id="test-farm"></div>';
  root = document.querySelector('#test-farm')!;
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Offline artwork')));
});
afterEach(() => { dispose?.(); dispose = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const click = (name: string) => {
  const button = [...root.querySelectorAll('button')].find(b => b.textContent?.trim() === name);
  expect(button, name).toBeTruthy(); button!.click();
};
const store = (state = createFarm()) => ({ load: () => ({ state, warning: null }), save: vi.fn() });

describe('farm management', () => {
  it('loads a saved farm before sessions subscribe and runs real manual commands', () => {
    const state = createFarm(); state.coins = 250;
    const saves = store(state);
    dispose = mountFarm(root, { sessionSource: createSessionSimulator(), saveStore: saves });
    click('Store & trade'); click('Buy 10 seeds · 8c');
    expect(state.coins).toBe(242);
    expect(state.inventory.seeds).toBe(30);
    expect(saves.save).toHaveBeenCalled();
    expect(root.querySelectorAll('[data-plot]')).toHaveLength(12);
  });
  it('shows exact attention text as text, and resolving demo questions resumes only that simulator', () => {
    const source = createSessionSimulator(); const id = source.snapshot().sessions[0].id;
    dispose = mountFarm(root, { sessionSource: source, saveStore: store() });
    source.setActivity(id, 'waiting_input', '<img src=x onerror=alert(1)> Please choose the branch.');
    click('Read question');
    expect(root.querySelector('[data-attention-text]')?.textContent).toBe('<img src=x onerror=alert(1)> Please choose the branch.');
    expect(root.querySelector('[data-attention-text] img')).toBeNull();
    click('Resolve demo question');
    expect(source.snapshot().sessions.find(s => s.id === id).activity).toBe('working');
  });
  it('leaves an unrecoverable save intact and does not subscribe or save', () => {
    const source = createSessionSimulator(); const subscribe = vi.spyOn(source, 'subscribe');
    const save = vi.fn();
    dispose = mountFarm(root, { sessionSource: source, saveStore: { load() { throw new Error('Corrupt save; no backup'); }, save } });
    expect(root.textContent).toContain('Corrupt save; no backup');
    expect(subscribe).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it('makes save failures visible with a retry action', () => {
    const saves = store(); saves.save.mockImplementation(() => { throw new Error('Storage full'); });
    dispose = mountFarm(root, { sessionSource: createSessionSimulator(), saveStore: saves });
    click('Store & trade'); click('Buy 10 seeds · 8c');
    expect(root.textContent).toContain('Storage full');
    saves.save.mockImplementation(() => {}); click('Retry save');
    expect(root.querySelector('[data-save-status]')?.textContent).toContain('Saved');
  });
  it('pauses simulation and removes subscriptions/timers on disposal', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] }); const state = createFarm(); const source = createSessionSimulator();
    dispose = mountFarm(root, { sessionSource: source, saveStore: store(state) });
    vi.advanceTimersByTime(1000); expect(state.time).toBe(1);
    click('Pause'); vi.advanceTimersByTime(1000); expect(state.time).toBe(1);
    click('Resume'); vi.advanceTimersByTime(1000); expect(state.time).toBe(2);
    dispose!(); dispose = undefined; vi.advanceTimersByTime(10000); expect(state.time).toBe(2);
    source.add(); expect(root.childElementCount).toBe(0);
  });
  it('rejects duplicate mounts without replacing the first farm', () => {
    dispose = mountFarm(root, { sessionSource: createSessionSimulator(), saveStore: store() });
    expect(() => mountFarm(root, { sessionSource: createSessionSimulator(), saveStore: store() })).toThrow(/already mounted/i);
    expect(root.querySelector('canvas')).not.toBeNull();
  });
});

it('requires explicit confirmation before consuming an animal', () => {
  const state = createFarm(); const saves = store(state);
  dispose = mountFarm(root, { sessionSource: createSessionSimulator(), saveStore: saves });
  click('Livestock'); click('Slaughter…'); expect(state.animals).toHaveLength(2);
  click('Keep animal'); expect(state.animals).toHaveLength(2);
  click('Slaughter…'); click('Confirm slaughter'); expect(state.animals).toHaveLength(1);
  expect(state.inventory.meat).toBe(5); expect(state.inventory.hide).toBe(2);
});

it('stops time on hidden pages and resumes without catch-up', () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const state = createFarm();
  dispose = mountFarm(root, { sessionSource: createSessionSimulator(), saveStore: store(state) });
  vi.advanceTimersByTime(1000); expect(state.time).toBe(1);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange')); vi.advanceTimersByTime(60000); expect(state.time).toBe(1);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  document.dispatchEvent(new Event('visibilitychange')); vi.advanceTimersByTime(1000); expect(state.time).toBe(2);
});

it('freezes when a source disconnects and keeps duplicate snapshots from changing labor', () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const state = createFarm(); const source = createSessionSimulator(); let publish: (value: unknown) => void;
  dispose = mountFarm(root, { sessionSource: { subscribe(cb) { publish = cb; cb(source.snapshot()); return () => {}; } }, saveStore: store(state) });
  publish!({ ...source.snapshot(), connected: false, revision: 2 });
  vi.advanceTimersByTime(1000); expect(state.time).toBe(0);
  expect(root.querySelector('[data-connection]')?.textContent).toContain('paused');
  publish!(source.snapshot()); vi.advanceTimersByTime(1000); expect(state.time).toBe(0);
  publish!({ ...source.snapshot(), connected: true, revision: 3 });
  vi.advanceTimersByTime(1000); expect(state.time).toBe(1);
});

it('removes keyboard handling on pagehide as well as explicit disposal', () => {
  const remove = vi.spyOn(root, 'removeEventListener');
  dispose = mountFarm(root, { sessionSource: createSessionSimulator(), saveStore: store() });
  window.dispatchEvent(new Event('pagehide'));
  expect(remove.mock.calls.some(([type]) => type === 'keydown')).toBe(true);
});

it('updates an open question when the source replaces its attention item', () => {
  const source = createSessionSimulator(), id = source.snapshot().sessions[0].id;
  dispose = mountFarm(root, { sessionSource: source, saveStore: store() });
  source.setActivity(id, 'waiting_input', 'First question'); click('Read question');
  source.setActivity(id, 'waiting_input', 'Replacement question');
  expect(root.querySelector('[data-attention-text]')?.textContent).toBe('Replacement question');
});

it('validates injected saved state before subscribing or rendering controls', () => {
  const state = createFarm(); state.coins = -1; const source = createSessionSimulator();
  const subscribe = vi.spyOn(source, 'subscribe');
  dispose = mountFarm(root, { sessionSource: source, saveStore: store(state) });
  expect(root.textContent).toContain('Invalid farm save'); expect(subscribe).not.toHaveBeenCalled();
});

it('does not restore working sessions before an asynchronous source connects', () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const state = createFarm(); let publish: (snapshot: unknown) => void;
  dispose = mountFarm(root, { sessionSource: { subscribe(cb) { publish = cb; return () => {}; } }, saveStore: store(state) });
  vi.advanceTimersByTime(1000); expect(state.time).toBe(0); expect(state.connected).toBe(false);
  publish!(createSessionSimulator().snapshot()); vi.advanceTimersByTime(1000); expect(state.time).toBe(1);
});

it('shows a visible notice when Canvas is unavailable', () => {
  dispose = mountFarm(root, { sessionSource: createSessionSimulator(), saveStore: store() });
  expect(root.querySelector('[data-art-status]')?.textContent).toContain('Canvas');
});

it('exports a loadable save envelope with no session or question data', async () => {
  const { parseFarm } = await import('../farm/storage.mjs');
  let exported: Blob | undefined;
  vi.stubGlobal('URL', { createObjectURL(blob: Blob) { exported = blob; return 'blob:test'; }, revokeObjectURL() {} });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const source = createSessionSimulator(), id = source.snapshot().sessions[0].id;
  dispose = mountFarm(root, { sessionSource: source, saveStore: store() });
  source.setActivity(id, 'waiting_input', 'Private demo question'); click('Export save');
  const json = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(exported!); });
  expect(parseFarm(json).workers).toEqual([]); expect(json).not.toContain('Private demo question');
});

it('drops a long scheduler gap instead of granting sleeping-time labor', () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  let clock = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const state = createFarm();
  dispose = mountFarm(root, { sessionSource: createSessionSimulator(), saveStore: store(state) });
  clock = 3_600_000; vi.advanceTimersByTime(250); expect(state.time).toBe(0);
  clock += 250; vi.advanceTimersByTime(250); expect(state.time).toBe(.25);
});

it('reacquires the standalone save lock after back-forward cache restoration', async () => {
  vi.resetModules(); root.setAttribute('data-farm-app', '');
  let acquired = 0;
  vi.stubGlobal('navigator', { locks: { request(_name, _options, callback) { acquired++; return callback({ name: 'farm' }); } } });
  await import('../farm/app.mjs');
  expect(root.querySelector('canvas')).not.toBeNull(); expect(acquired).toBe(1);
  window.dispatchEvent(new Event('pagehide')); expect(root.childElementCount).toBe(0);
  const restore = new Event('pageshow'); Object.defineProperty(restore, 'persisted', { value: true });
  window.dispatchEvent(restore);
  await vi.waitFor(() => { expect(acquired).toBe(2); expect(root.querySelector('canvas')).not.toBeNull(); });
  window.dispatchEvent(new Event('pagehide')); root.removeAttribute('data-farm-app');
});

it('explains a second-tab lock instead of starting another standalone simulation', async () => {
  vi.resetModules(); root.setAttribute('data-farm-app', '');
  vi.stubGlobal('navigator', { locks: { request(_name, _options, callback) { return callback(null); } } });
  await import('../farm/app.mjs');
  expect(root.textContent).toContain('Your farm is already open'); expect(root.querySelector('canvas')).toBeNull();
  root.removeAttribute('data-farm-app');
});

it('reports a rejected host question-navigation action without resolving attention', async () => {
  const source = createSessionSimulator(), id = source.snapshot().sessions[0].id;
  source.setActivity(id, 'waiting_input', 'Host question');
  const onAttention = vi.fn(async () => { throw new Error('Host navigation unavailable'); });
  dispose = mountFarm(root, { sessionSource: { subscribe: cb => source.subscribe(cb) }, saveStore: store(), onAttention });
  click('Read question'); click('Open session question');
  await vi.waitFor(() => expect(root.querySelector('[data-error]')?.textContent).toContain('Host navigation unavailable'));
  expect(source.snapshot().sessions[0].attention.text).toBe('Host question');
  expect(onAttention).toHaveBeenCalledWith(id, expect.objectContaining({ text: 'Host question' }));
});

it('uses an injected asset loader without catalog HTTP requests and aborts it on disposal', async () => {
  let signal: AbortSignal | undefined;
  const assetLoader = async options => { signal = options.signal; return {}; };
  dispose = mountFarm(root, { sessionSource: createSessionSimulator(), saveStore: store(), assetLoader });
  await Promise.resolve(); expect(signal).toBeInstanceOf(AbortSignal); expect(fetch).not.toHaveBeenCalled();
  dispose!(); dispose = undefined; expect(signal!.aborted).toBe(true);
});

it('keeps crop status and harvesting live without replacing the focused crop selector', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const { advanceFarm } = await import('../farm/model.mjs'); const state = createFarm();
  dispose = mountFarm(root, { sessionSource: createSessionSimulator(), saveStore: store(state) });
  const selector = root.querySelector<HTMLSelectElement>('[data-change="crop"]')!; selector.focus();
  advanceFarm(state, 60); advanceFarm(state, 40); vi.advanceTimersByTime(1000);
  expect(state.plots[0].stage).toBe('ready');
  expect(root.querySelector('[data-inspector]')?.textContent).toContain('Ready to harvest');
  expect(root.querySelector<HTMLButtonElement>('[data-act="harvest"]')!.disabled).toBe(false);
  expect(root.querySelector<HTMLMeterElement>('[data-inspector] meter[aria-label="Growth"]')!.value).toBe(100);
  expect(root.querySelector('[data-change="crop"]')).toBe(selector); expect(document.activeElement).toBe(selector);
});

it('updates passive livestock stats while preserving its focused action button', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const { advanceFarm } = await import('../farm/model.mjs'); const state = createFarm(); state.policy.autoCollect = false;
  dispose = mountFarm(root, { sessionSource: createSessionSimulator(), saveStore: store(state) });
  click('Livestock'); const action = root.querySelector<HTMLButtonElement>('[data-act="slaughter-prompt"]')!; action.focus();
  advanceFarm(state, 60); advanceFarm(state, 40); vi.advanceTimersByTime(1000);
  expect(root.querySelector('.animal-row')?.textContent).toContain('1 milk ready');
  expect(root.querySelector<HTMLButtonElement>('[data-act="collect"]')!.disabled).toBe(false);
  expect(document.activeElement).toBe(action);
});

it('releases all resources and permits remounting when unsubscribe throws', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const source = createSessionSimulator(); const failure = new Error('Unsubscribe failed');
  let signal: AbortSignal | undefined;
  const broken = { subscribe(cb) { const stop = source.subscribe(cb); return () => { stop(); throw failure; }; } };
  const stop = mountFarm(root, { sessionSource: broken, saveStore: store(), assetLoader: async options => { signal = options.signal; return {}; } });
  const remove = vi.spyOn(root, 'removeEventListener'); await Promise.resolve();
  expect(stop).toThrow(failure); expect(signal!.aborted).toBe(true);
  expect(root.childElementCount).toBe(0); expect(vi.getTimerCount()).toBe(0);
  for (const type of ['click', 'change', 'keydown']) expect(remove.mock.calls.some(([event]) => event === type)).toBe(true);
  expect(stop).not.toThrow();
  expect(() => { dispose = mountFarm(root, { sessionSource: createSessionSimulator(), saveStore: store() }); }).not.toThrow();
});

it('gives simultaneous farm mounts unique accessible label and dialog targets', () => {
  dispose = mountFarm(root, { sessionSource: createSessionSimulator(), saveStore: store() });
  const second = document.createElement('div'); document.body.append(second);
  const stop = mountFarm(second, { sessionSource: createSessionSimulator(), saveStore: store() });
  try {
    const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const farmRoot of [root, second]) for (const element of farmRoot.querySelectorAll('[for],[aria-controls],[aria-labelledby]')) {
      const id = element.getAttribute('for') ?? element.getAttribute('aria-controls') ?? element.getAttribute('aria-labelledby');
      expect(farmRoot.contains(document.getElementById(id!))).toBe(true);
    }
  } finally { stop(); }
});

it('explains protector weapons alongside their management controls', () => {
  const state = createFarm(); state.guards.push(
    { id: 'guard-knight', kind: 'knight', health: 130, maxHealth: 130, mode: 'home', progress: 0 },
    { id: 'guard-ranger', kind: 'ranger', health: 80, maxHealth: 80, mode: 'patrol', progress: 0 },
  );
  dispose = mountFarm(root, { sessionSource: createSessionSimulator(), saveStore: store(state) }); click('Protectors');
  const labels = [...root.querySelectorAll('.guard-row')].map(row => row.textContent);
  expect(labels[0]).toContain('Weapon: Sword'); expect(labels[1]).toContain('Weapon: Sword & shield'); expect(labels[2]).toContain('Weapon: Bow');
});

it('moves with held arrow keys only while the farm canvas has focus', () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const state = createFarm(); const saves = store(state);
  dispose = mountFarm(root, { sessionSource: createSessionSimulator(), saveStore: saves });
  const canvas = root.querySelector('canvas')!;
  expect(canvas.tabIndex).toBe(0); canvas.click(); expect(document.activeElement).toBe(canvas);
  const initial = state.farmer.x;
  canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); vi.advanceTimersByTime(300);
  expect(state.farmer.x).toBeGreaterThan(initial);
  canvas.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true })); const stopped = state.farmer.x;
  vi.advanceTimersByTime(300); expect(state.farmer.x).toBe(stopped); expect(saves.save).toHaveBeenCalled();
  const select = root.querySelector<HTMLSelectElement>('[data-change="crop"]')!; select.focus();
  select.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); vi.advanceTimersByTime(300);
  expect(state.farmer.x).toBe(stopped);
});

it('clears held movement after blur and pause so it cannot restart by itself', () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const state = createFarm(); dispose = mountFarm(root, { sessionSource: createSessionSimulator(), saveStore: store(state) });
  const canvas = root.querySelector('canvas')!; canvas.focus();
  canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); vi.advanceTimersByTime(200);
  root.querySelector<HTMLSelectElement>('[data-change="speed"]')!.focus(); const blurred = state.farmer.x;
  canvas.focus(); vi.advanceTimersByTime(200); expect(state.farmer.x).toBe(blurred);
  canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); click('Pause'); click('Resume');
  canvas.focus(); vi.advanceTimersByTime(200); expect(state.farmer.x).toBe(blurred);
});

it('harvests a nearby ripe plot with Space and ignores auto-repeated keydown', () => {
  const state = createFarm(); const plot = state.plots[0]; plot.stage = 'ready'; plot.growth = 75;
  dispose = mountFarm(root, { sessionSource: createSessionSimulator(), saveStore: store(state) });
  state.farmer.x = 230; state.farmer.y = 160;
  const canvas = root.querySelector('canvas')!; canvas.focus();
  canvas.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, repeat: false }));
  expect(state.inventory.parsnip).toBe(3); expect(plot.stage).toBe('empty');
  canvas.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, repeat: true }));
  expect(state.inventory.parsnip).toBe(3); expect(root.querySelector<HTMLElement>('[data-error]')!.hidden).toBe(true);
});

it.each(['disconnect', 'invalid update'])('clears held movement and walking pose on %s', connection => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const state = createFarm(); const source = createSessionSimulator(); let publish: (snapshot: unknown) => void;
  dispose = mountFarm(root, { sessionSource: { subscribe(cb) { publish = cb; cb(source.snapshot()); return () => {}; } }, saveStore: store(state) });
  const canvas = root.querySelector('canvas')!; canvas.focus();
  canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); vi.advanceTimersByTime(200);
  expect(state.farmer.action).toBe('walk');
  publish!({ ...source.snapshot(), version: connection === 'disconnect' ? 1 : 99, connected: false, revision: 2 });
  expect(state.farmer.action).toBe('idle'); const stopped = state.farmer.x;
  publish!({ ...source.snapshot(), revision: 3 });
  canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true, bubbles: true })); vi.advanceTimersByTime(200);
  expect(state.farmer.x).toBe(stopped);
});

it('leaves modified arrow shortcuts to the browser instead of moving', () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const state = createFarm(); dispose = mountFarm(root, { sessionSource: createSessionSimulator(), saveStore: store(state) });
  const canvas = root.querySelector('canvas')!; canvas.focus(); const before = state.farmer.x;
  const shortcut = new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, cancelable: true, bubbles: true }); canvas.dispatchEvent(shortcut);
  expect(shortcut.defaultPrevented).toBe(false); vi.advanceTimersByTime(200); expect(state.farmer.x).toBe(before);
});

it('keeps Shift+Tab trapped inside question dialogs despite canvas shortcut filtering', () => {
  const source = createSessionSimulator(); source.setActivity(source.snapshot().sessions[0].id, 'waiting_input', 'Demo question');
  dispose = mountFarm(root, { sessionSource: source, saveStore: store() }); click('Read question');
  const dialog = root.querySelector<HTMLElement>('[data-dialog]')!;
  const first = dialog.querySelector<HTMLButtonElement>('button')!; first.focus();
  const backwards = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }); first.dispatchEvent(backwards);
  expect(backwards.defaultPrevented).toBe(true); expect(document.activeElement?.textContent).toBe('Close');
  dialog.focus(); const fromContainer = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }); dialog.dispatchEvent(fromContainer);
  expect(fromContainer.defaultPrevented).toBe(true); expect(document.activeElement?.textContent).toBe('Close');
});

it('attacks a nearby slime with Space through the model and shows an attack pose', async () => {
  const { monsterPosition } = await import('../farm/world.mjs'); const state = createFarm(); state.guards = [];
  state.monsters = [{ id: 'slime-keyboard', health: 30, maxHealth: 30, progress: .7 }];
  dispose = mountFarm(root, { sessionSource: createSessionSimulator(), saveStore: store(state) });
  const target = monsterPosition(state.monsters[0]); state.farmer.x = target.x - 25; state.farmer.y = target.y;
  const canvas = root.querySelector('canvas')!; canvas.focus();
  canvas.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
  expect(state.monsters[0].health).toBe(18); expect(state.farmer.action).toBe('attack'); expect(state.farmer.actionTime).toBeGreaterThan(0);
});
