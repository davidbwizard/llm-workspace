// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIndex, queryAssets, queryFolders } from '../serve-viewer.mjs';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'viewer.html'), 'utf8');
let observers, fetchMock, index;
const $ = id => document.getElementById(id);
beforeEach(() => {
  vi.resetModules();
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.replaceChildren(...parsed.body.childNodes);
  history.replaceState(null, '', '/');
  observers = [];
  vi.stubGlobal('IntersectionObserver', class {
    callback; observed = new Set();
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(node) { this.observed.add(node); }
    unobserve(node) { this.observed.delete(node); }
    disconnect() { this.observed.clear(); }
  });
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 128, height: 96, close: vi.fn() })));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() } as never);
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
  const assets = Array.from({ length: 80 }, (_, n) => ({
    name: n === 0 ? '<img src=x onerror=alert(1)>' : `Sprite ${n}`,
    location: `${n < 35 ? "Pack/Character/PNG/Idle/Hair's" : n < 70 ? 'Pack/Character/Pre-made' : 'Pack/Animals'}/${n}.png`,
    type: n < 70 ? 'character' : 'animal', kind: 'animation',
    imageSize: [128, 96], frameSize: n < 70 ? [32, 32] : [16, 16], cellSize: null,
    cellCount: n < 70 ? 12 : 48, frames: 4, empty: false, needsReview: false,
    metadataNeeded: [], warnings: [], source: null,
  }));
  index = createIndex({ schemaVersion: 3, assets, sources: [] });
  fetchMock = vi.fn(async value => {
    const url = new URL(value, location.origin);
    let data;
    if (url.pathname === '/api/options') data = index.options;
    else if (url.pathname === '/api/folders') data = queryFolders(index, url.searchParams);
    else if (url.pathname === '/api/assets') data = queryAssets(index, url.searchParams);
    else if (url.pathname.startsWith('/api/assets/')) { const record = index.byId.get(url.pathname.split('/').at(-1)); data = { id: record.id, ...record.asset }; }
    return { ok: true, json: async () => data, blob: async () => new Blob() };
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { window.dispatchEvent(new Event('pagehide')); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('viewer on-demand interface', () => {
  it('loads folders only on expansion and selects descendants without fetching PNGs', async () => {
    await import('../viewer.js');
    await vi.waitFor(() => expect(document.querySelectorAll('.sprite-card')).toHaveLength(36));
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/folders'))).toHaveLength(0);
    [...document.querySelectorAll('.type-button')].find(button => button.textContent.startsWith('Characters')).click();
    await vi.waitFor(() => expect(document.querySelectorAll('.folder-button')).toHaveLength(2));
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/folders'))).toHaveLength(1);
    expect([...document.querySelectorAll('.folder-button')].map(button => button.dataset.folder)).toEqual(['Pack/Character/PNG', 'Pack/Character/Pre-made']);
    document.querySelector('[data-expand="Pack/Character/PNG"]').click();
    await vi.waitFor(() => expect(document.querySelector('[data-folder="Pack/Character/PNG/Idle"]')).not.toBeNull());
    document.querySelector('[data-expand="Pack/Character/PNG/Idle"]').click();
    await vi.waitFor(() => expect(document.querySelectorAll('.folder-button')).toHaveLength(4));
    const hair = [...document.querySelectorAll('.folder-button')].find(button => button.textContent.startsWith("Hair's"));
    hair.click();
    await vi.waitFor(() => expect(document.querySelectorAll('.sprite-card')).toHaveLength(35));
    expect(hair.getAttribute('aria-pressed')).toBe('true');
    expect(new URLSearchParams(location.search).get('folder')).toBe("Pack/Character/PNG/Idle/Hair's");
    expect($('folder-breadcrumbs').textContent).toContain("Hair's");
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('/images/'))).toHaveLength(0);
    $('reset').click();
    await vi.waitFor(() => expect(document.querySelectorAll('.sprite-card')).toHaveLength(36));
    expect(new URLSearchParams(location.search).has('folder')).toBe(false);
    expect(document.querySelectorAll('.folder-button')).toHaveLength(0);
  });
  it('restores the selected folder from the URL and expands only its ancestors', async () => {
    history.replaceState(null, '', `/?${new URLSearchParams({ type: 'character', folder: "Pack/Character/PNG/Idle/Hair's" })}`);
    await import('../viewer.js');
    await vi.waitFor(() => expect(document.querySelector('.folder-button[aria-pressed=true]')).not.toBeNull());
    expect(document.querySelector('.folder-button[aria-pressed=true]').textContent).toContain("Hair's");
    await vi.waitFor(() => expect(document.querySelectorAll('.sprite-card')).toHaveLength(35));
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/folders'))).toHaveLength(3);
  });
  it('retries failed folder requests and reuses branches after collapse', async () => {
    const serve = fetchMock.getMockImplementation();
    let fail = true;
    fetchMock.mockImplementation(async value => {
      if (value.startsWith('/api/folders') && fail) {
        fail = false;
        return { ok: false, json: async () => ({ error: 'Folder request failed.' }) };
      }
      return serve(value);
    });
    await import('../viewer.js');
    await vi.waitFor(() => expect(document.querySelectorAll('.sprite-card')).toHaveLength(36));
    [...document.querySelectorAll('.type-button')].find(button => button.textContent.startsWith('Characters')).click();
    await vi.waitFor(() => expect(document.querySelector('.folder-message').textContent).toContain('Folder request failed.'));
    document.querySelector('.folder-message button').click();
    await vi.waitFor(() => expect(document.querySelectorAll('.folder-button')).toHaveLength(2));
    const toggle = document.querySelector('[data-expand="Pack/Character/PNG"]');
    toggle.click();
    await vi.waitFor(() => expect(document.querySelectorAll('.folder-button')).toHaveLength(3));
    const childList = $(toggle.getAttribute('aria-controls'));
    toggle.click();
    expect(childList.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    expect(childList.hidden).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/folders'))).toHaveLength(3);
  });
  it('ignores a late branch response after switching types', async () => {
    const serve = fetchMock.getMockImplementation();
    let resolveBranch, branchSignal;
    fetchMock.mockImplementation(async (value, options) => {
      const url = new URL(value, location.origin);
      if (url.pathname === '/api/folders' && url.searchParams.get('type') === 'character') {
        branchSignal = options.signal;
        return new Promise(resolve => { resolveBranch = () => resolve(serve(value)); });
      }
      return serve(value);
    });
    await import('../viewer.js');
    await vi.waitFor(() => expect(document.querySelectorAll('.sprite-card')).toHaveLength(36));
    [...document.querySelectorAll('.type-button')].find(button => button.textContent.startsWith('Characters')).click();
    await vi.waitFor(() => expect(resolveBranch).toBeTypeOf('function'));
    [...document.querySelectorAll('.type-button')].find(button => button.textContent.startsWith('Animals')).click();
    expect(branchSignal.aborted).toBe(true);
    resolveBranch();
    await vi.waitFor(() => expect($('result-count').textContent).toContain('10 matching sprites'));
    expect($('results-title').textContent).toBe('Animals');
    expect(document.querySelectorAll('.folder-button')).toHaveLength(0);
    expect(document.querySelector('.folder-message').textContent).toBe('No subfolders.');
  });
  it('fetches no PNGs or detail records until needed and treats filenames as text', async () => {
    await import('../viewer.js');
    await vi.waitFor(() => expect(document.querySelectorAll('.sprite-card')).toHaveLength(36));
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('/images/'))).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/assets/'))).toHaveLength(0);
    expect(document.querySelector('.card-name').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(document.querySelectorAll('#gallery img')).toHaveLength(0);
    const cards = [...document.querySelectorAll('.sprite-card')];
    observers.at(-1).callback(cards.slice(0, 2).map(target => ({ target, isIntersecting: true })));
    await vi.waitFor(() => expect(document.querySelectorAll('[data-preview-loaded=true]')).toHaveLength(2));
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('/images/'))).toHaveLength(2);
    cards[0].click();
    await vi.waitFor(() => expect($('detail-body').hidden).toBe(false));
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/assets/'))).toHaveLength(1);
    expect($('detail-title').textContent).toBe('<img src=x onerror=alert(1)>');
    await vi.waitFor(() => expect($('detail-status').textContent).toBe(''));
    expect($('view-mode').value).toBe('cell');
    $('cell-index').value = '3'; $('cell-index').dispatchEvent(new Event('input'));
    expect($('cell-label').textContent).toBe('4 / 12');
    $('close-detail').click();
    expect($('inspector').open).toBe(false);
  });
  it('pages metadata and filters by type, frame size, and whole-image size', async () => {
    await import('../viewer.js');
    await vi.waitFor(() => expect(document.querySelectorAll('.sprite-card')).toHaveLength(36));
    $('next').click();
    await vi.waitFor(() => expect($('page-status').textContent).toBe('Page 2 of 3'));
    expect(document.querySelector('.card-name').textContent).toBe('Sprite 36');
    [...document.querySelectorAll('.type-button')].find(button => button.textContent.startsWith('Animals')).click();
    await vi.waitFor(() => expect(document.querySelectorAll('.sprite-card')).toHaveLength(10));
    $('size').value = '16x16'; $('size').dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect($('result-count').textContent).toContain('10 matching sprites'));
    const imageMode = document.querySelector('input[value=image]'); imageMode.checked = true; imageMode.dispatchEvent(new Event('change'));
    $('size').value = '128x96'; $('size').dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('.size-chip').textContent).toBe('128 × 96'));
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('/images/'))).toHaveLength(0);
  });
  it('provides a recoverable empty state', async () => {
    await import('../viewer.js');
    await vi.waitFor(() => expect(document.querySelectorAll('.sprite-card')).toHaveLength(36));
    $('review').value = 'empty'; $('review').dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect($('notice').hidden).toBe(false));
    expect($('notice-text').textContent).toContain('No sprites match');
    $('retry').click();
    await vi.waitFor(() => expect(document.querySelectorAll('.sprite-card')).toHaveLength(36));
    expect($('review').value).toBe('');
  });
});
