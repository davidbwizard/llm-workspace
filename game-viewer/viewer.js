const $ = id => document.getElementById(id);
const labels = { character: 'Characters', animal: 'Animals', crop: 'Crops', enemy: 'Enemies', icon: 'Icons',
  object: 'Objects', tileset: 'Tilesets', ui: 'UI', unknown: 'Unknown', animation: 'Animation', static: 'Static image',
  'growth-stages': 'Growth stages', variants: 'Variants', mixed: 'Mixed sheet' };
const label = value => labels[value] ?? value;
const sizeLabel = size => Array.isArray(size) ? `${size[0]} × ${size[1]}` : 'Unknown';
const imageURL = id => `/images/${id}.png`;
const number = value => value.toLocaleString();
let options, type = '', folder = '', page = 1, pageCount = 0, sizeMode = 'cell';
let queryController, thumbnailController, observer, searchTimer;
let folderController, branchId = 0;
let detailController, selected, selectedBitmap;
let emptyNotice = false;

async function json(url, signal) {
  const response = await fetch(url, { signal });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status}).`);
  return value;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function notice(message, empty = false) {
  emptyNotice = empty;
  $('notice').hidden = false;
  $('notice-text').textContent = message;
  $('retry').textContent = empty ? 'Clear filters' : 'Try again';
}

function renderTypes() {
  folderController?.abort();
  folderController = new AbortController();
  $('types').replaceChildren();
  for (const item of [{ value: '', count: options.total }, ...options.types]) {
    const group = element('div', 'type-group');
    const button = element('button', 'type-button');
    button.type = 'button';
    button.dataset.type = item.value;
    button.setAttribute('aria-pressed', String(item.value === type && !folder));
    button.append(element('span', '', item.value ? label(item.value) : 'All types'), element('span', '', number(item.count)));
    button.addEventListener('click', () => { type = item.value; folder = ''; page = 1; renderTypes(); loadPage(); });
    group.append(button);
    $('types').append(group);
    if (item.value) button.setAttribute('aria-expanded', String(item.value === type));
    if (item.value && item.value === type) {
      group.classList.add('expanded-type');
      const tree = element('ul', 'folder-tree');
      tree.id = `folder-branch-${++branchId}`;
      tree.setAttribute('aria-label', `${label(type)} folders`);
      button.setAttribute('aria-controls', tree.id);
      group.append(tree);
      loadFolderBranch(tree, item.root, folderController.signal);
    }
  }
}

async function loadFolderBranch(list, path, signal) {
  if (list.dataset.state === 'loaded' || list.dataset.state === 'loading') return;
  list.dataset.state = 'loading';
  list.setAttribute('aria-busy', 'true');
  list.replaceChildren(element('li', 'folder-message', 'Loading folders…'));
  try {
    const result = await json(`/api/folders?${new URLSearchParams({ type, folder: path })}`, signal);
    if (signal.aborted || !list.isConnected) return;
    list.replaceChildren();
    list.dataset.state = 'loaded';
    for (const child of result.children) {
      const item = element('li');
      const row = element('div', 'folder-row');
      const button = element('button', 'folder-button');
      button.type = 'button'; button.dataset.folder = child.path;
      button.title = `${child.path} (${number(child.count)} sprites including subfolders)`;
      button.setAttribute('aria-pressed', String(folder === child.path));
      button.append(element('span', '', child.name), element('span', 'folder-count', number(child.count)));
      const children = element('ul', 'folder-children');
      children.hidden = true; children.id = `folder-branch-${++branchId}`;
      const toggle = element(child.hasChildren ? 'button' : 'span', 'folder-toggle', child.hasChildren ? '▸' : '');
      const expand = () => {
        children.hidden = false; toggle.textContent = '▾'; toggle.setAttribute('aria-expanded', 'true');
        return loadFolderBranch(children, child.path, signal);
      };
      if (child.hasChildren) {
        toggle.type = 'button'; toggle.dataset.expand = child.path;
        toggle.setAttribute('aria-label', `Toggle ${child.name} subfolders`);
        toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', children.id);
        toggle.addEventListener('click', () => {
          if (children.hidden) expand();
          else { children.hidden = true; toggle.textContent = '▸'; toggle.setAttribute('aria-expanded', 'false'); }
        });
      } else toggle.setAttribute('aria-hidden', 'true');
      button.addEventListener('click', () => { selectFolder(child.path); if (child.hasChildren) expand(); });
      row.append(toggle, button); item.append(row); list.append(item);
      if (child.hasChildren) {
        item.append(children);
        // Restore only the ancestors of a bookmarked selection, not the entire tree.
        if (folder.startsWith(`${child.path}/`)) expand();
      }
    }
    if (!result.children.length) list.append(element('li', 'folder-message', 'No subfolders.'));
  } catch (error) {
    if (signal.aborted || !list.isConnected) return;
    list.dataset.state = 'error';
    const message = element('li', 'folder-message', error.message);
    const retry = element('button', 'text-button', 'Retry folders'); retry.type = 'button';
    retry.addEventListener('click', () => loadFolderBranch(list, path, signal));
    message.append(retry); list.replaceChildren(message);
  } finally { if (!signal.aborted) list.setAttribute('aria-busy', 'false'); }
}

function selectFolder(path) {
  const root = options.types.find(item => item.value === type)?.root;
  folder = path === root ? '' : path;
  page = 1;
  for (const button of document.querySelectorAll('.folder-button')) button.setAttribute('aria-pressed', String(button.dataset.folder === folder));
  for (const button of document.querySelectorAll('.type-button')) button.setAttribute('aria-pressed', String(button.dataset.type === type && !folder));
  loadPage();
}

function renderBreadcrumbs() {
  const nav = $('folder-breadcrumbs');
  nav.hidden = !folder; nav.replaceChildren();
  if (!folder) return;
  const root = options.types.find(item => item.value === type)?.root ?? '';
  const parts = folder.split('/');
  const start = root ? root.split('/').length : 0;
  const crumbs = [{ name: label(type), path: root }, ...parts.slice(start).map((name, index) => ({ name, path: parts.slice(0, start + index + 1).join('/') }))];
  for (const crumb of crumbs) {
    const button = element('button', 'text-button', crumb.name); button.type = 'button';
    if (crumb.path === folder) button.setAttribute('aria-current', 'location');
    button.addEventListener('click', () => selectFolder(crumb.path));
    nav.append(button);
  }
}

function renderSizes(value = '') {
  $('size').replaceChildren(new Option('All sizes', ''));
  for (const item of options[sizeMode === 'cell' ? 'cellSizes' : 'imageSizes']) {
    $('size').add(new Option(`${item.value === 'unknown' ? 'Unknown size' : item.value.replace('x', ' × ')} (${number(item.count)})`, item.value));
  }
  $('size').value = value;
  $('size-help').textContent = sizeMode === 'cell' ? 'The size of one animation frame or grid cell.' : 'The dimensions of the entire PNG file.';
}

function parameters() {
  const params = new URLSearchParams({ page: String(page), limit: '36', sizeMode });
  for (const [key, value] of Object.entries({ type, folder, kind: $('kind').value, size: $('size').value,
    review: $('review').value, q: $('search').value.trim() })) if (value) params.set(key, value);
  return params;
}

function makeCard(asset) {
  const button = element('button', 'sprite-card');
  button.type = 'button';
  button.dataset.assetId = asset.id;
  const folder = asset.location.split('/').slice(1, -1).join(' / ');
  button.setAttribute('aria-label', `${asset.name}, ${label(asset.type)}, ${folder}, ${sizeLabel(asset.previewSize)}`);
  const preview = element('div', 'thumbnail');
  const canvas = element('canvas'); canvas.width = 128; canvas.height = 104; canvas.setAttribute('aria-hidden', 'true');
  const placeholder = element('span', 'thumbnail-label', asset.empty ? 'Transparent image' : 'Preview');
  preview.append(canvas, placeholder);
  const info = element('div', 'card-info');
  const title = element('span', 'card-name', asset.name); title.title = asset.name;
  const folderLabel = element('span', 'card-folder', folder); folderLabel.title = folder;
  const meta = element('div', 'card-meta');
  const descriptor = element('span', '', asset.warningCount ? 'Review' : label(asset.kind));
  if (asset.warningCount) descriptor.prepend(element('span', 'review-dot'));
  meta.append(element('span', 'size-chip', sizeLabel(sizeMode === 'cell' ? asset.previewSize : asset.imageSize)), descriptor);
  info.append(title, folderLabel, meta); button.append(preview, info);
  button.addEventListener('click', () => openDetail(asset.id));
  if (!asset.empty) observer.observe(button);
  return button;
}

async function loadThumbnail(card, asset, signal) {
  const placeholder = card.querySelector('.thumbnail-label');
  let bitmap;
  try {
    const response = await fetch(imageURL(asset.id), { signal });
    if (!response.ok) throw new Error('Preview unavailable');
    bitmap = await createImageBitmap(await response.blob());
    if (signal.aborted || !card.isConnected) return;
    const canvas = card.querySelector('canvas'), context = canvas.getContext('2d');
    const [width, height] = asset.previewSize ?? [bitmap.width, bitmap.height];
    const fit = Math.min(108 / width, 84 / height), scale = fit >= 1 ? Math.floor(fit) : fit;
    const w = width * scale, h = height * scale;
    context.imageSmoothingEnabled = false;
    context.drawImage(bitmap, 0, 0, width, height, Math.floor((128 - w) / 2), Math.floor((104 - h) / 2), w, h);
    placeholder.hidden = true;
    card.dataset.previewLoaded = 'true';
  } catch (error) {
    if (!signal.aborted && card.isConnected) placeholder.textContent = 'Preview unavailable';
  } finally { bitmap?.close(); }
}

async function loadPage() {
  if (!options) return;
  clearTimeout(searchTimer);
  queryController?.abort(); thumbnailController?.abort(); observer?.disconnect();
  const controller = new AbortController(); queryController = controller;
  $('gallery').replaceChildren(); $('gallery').setAttribute('aria-busy', 'true');
  $('notice').hidden = true; $('result-count').textContent = 'Finding sprites…';
  $('previous').disabled = true; $('next').disabled = true;
  const params = parameters();
  history.replaceState(null, '', `/?${params}`);
  $('results-title').textContent = folder ? folder.split('/').at(-1) : type ? label(type) : 'All assets';
  renderBreadcrumbs();
  try {
    const result = await json(`/api/assets?${params}`, controller.signal);
    if (controller.signal.aborted) return;
    pageCount = result.pages;
    if (pageCount && page > pageCount) { page = pageCount; await loadPage(); return; }
    thumbnailController = new AbortController();
    const signal = thumbnailController.signal;
    const assets = new Map(result.items.map(asset => [asset.id, asset]));
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        observer.unobserve(entry.target);
        loadThumbnail(entry.target, assets.get(entry.target.dataset.assetId), signal);
      }
    }, { rootMargin: '120px 0px' });
    $('gallery').append(...result.items.map(makeCard));
    $('result-count').textContent = result.total ? `${number(result.total)} matching sprites · showing ${number((page - 1) * result.limit + 1)}–${number(Math.min(page * result.limit, result.total))}` : 'No matching sprites';
    $('page-status').textContent = pageCount ? `Page ${page} of ${number(pageCount)}` : 'No results';
    $('previous').disabled = page <= 1; $('next').disabled = page >= pageCount;
    if (!result.total) notice('No sprites match these filters. Try another size, type, or search.', true);
  } catch (error) {
    if (!controller.signal.aborted) { $('result-count').textContent = 'Unable to load sprites'; notice(error.message); }
  } finally { if (!controller.signal.aborted) $('gallery').setAttribute('aria-busy', 'false'); }
}

function reset() {
  if (!options) return;
  type = ''; folder = ''; page = 1; sizeMode = 'cell';
  $('search').value = ''; $('kind').value = ''; $('review').value = '';
  document.querySelector('input[name=size-mode][value=cell]').checked = true;
  renderTypes(); renderSizes(); loadPage();
}

function closeDetail() {
  detailController?.abort(); selectedBitmap?.close(); selectedBitmap = null; selected = null;
  $('detail-canvas').width = 0; $('detail-canvas').height = 0;
}

function fact(name, value) {
  const group = element('div'); group.append(element('dt', '', name), element('dd', '', value)); return group;
}

function showDetails(asset) {
  $('detail-title').textContent = asset.name;
  $('detail-type').textContent = `${label(asset.type)} / ${label(asset.kind)}`;
  $('detail-path').textContent = asset.location;
  $('open-image').href = imageURL(asset.id);
  $('copy-path').textContent = 'Copy asset path';
  $('detail-json').textContent = JSON.stringify(asset, null, 2);
  $('detail-facts').replaceChildren(
    fact('Whole image', sizeLabel(asset.imageSize)),
    fact(asset.frameSize ? 'Frame size' : 'Cell size', sizeLabel(asset.frameSize ?? asset.cellSize)),
    fact('Animation frames', asset.frames ?? (asset.kind === 'animation' ? 'Unresolved' : 'Not applicable')),
    fact('Grid cells', asset.cellCount ?? 'Unmapped'),
    fact('Content', label(asset.kind)), fact('Review', asset.needsReview ? 'Needs attention' : 'No flags'),
  );
  $('detail-warnings').replaceChildren();
  if (asset.empty) $('detail-warnings').append(element('p', '', 'This PNG is fully transparent. It may be an intentional placeholder.'));
  if (asset.metadataNeeded?.length) $('detail-warnings').append(element('p', 'metadata-note', `Mapping needed: ${asset.metadataNeeded.map(value => value.replaceAll('-', ' ')).join(', ')}.`));
  for (const warning of asset.warnings ?? []) {
    const message = warning.code === 'documented-frame-conflict'
      ? `Frame counts disagree: the pack description says ${warning.documentedFrames}; the source says ${warning.sourceFrames}.`
      : 'The exported image does not fit the proposed animation layout. Check the sheet before using these frames.';
    $('detail-warnings').append(element('p', '', message));
  }
  const size = asset.frameSize ?? asset.cellSize;
  const validCells = size && asset.imageSize[0] % size[0] === 0 && asset.imageSize[1] % size[1] === 0;
  $('view-mode').options[1].disabled = !validCells;
  $('view-mode').value = validCells && ['animation', 'static'].includes(asset.kind) ? 'cell' : 'sheet';
  $('zoom').value = $('view-mode').value === 'cell' ? '4' : '1';
  $('show-grid').checked = false;
  $('cell-index').value = '0';
  $('cell-index').max = validCells ? String((asset.imageSize[0] / size[0]) * (asset.imageSize[1] / size[1]) - 1) : '0';
  $('detail-body').hidden = false;
}

function drawDetail() {
  if (!selectedBitmap || !selected) return;
  const size = selected.frameSize ?? selected.cellSize;
  const mode = $('view-mode').value, zoom = Number($('zoom').value), cell = Number($('cell-index').value);
  const canvas = $('detail-canvas');
  let x = 0, y = 0, width = selectedBitmap.width, height = selectedBitmap.height;
  if (mode === 'cell' && size) {
    const columns = selectedBitmap.width / size[0];
    x = (cell % columns) * size[0]; y = Math.floor(cell / columns) * size[1]; [width, height] = size;
  }
  canvas.width = width; canvas.height = height;
  canvas.style.width = `${width * zoom}px`; canvas.style.height = `${height * zoom}px`;
  const context = canvas.getContext('2d'); context.imageSmoothingEnabled = false;
  context.drawImage(selectedBitmap, x, y, width, height, 0, 0, width, height);
  if (mode === 'sheet' && size && $('show-grid').checked) {
    context.strokeStyle = '#7652ba99'; context.lineWidth = 1;
    context.beginPath();
    for (let x = size[0]; x < width; x += size[0]) { context.moveTo(x + .5, 0); context.lineTo(x + .5, height); }
    for (let y = size[1]; y < height; y += size[1]) { context.moveTo(0, y + .5); context.lineTo(width, y + .5); }
    context.stroke();
  }
  $('show-grid').disabled = mode === 'cell' || !size;
  $('cell-controls').hidden = mode !== 'cell';
  $('cell-label').textContent = `${cell + 1} / ${Number($('cell-index').max) + 1}`;
  $('preview-help').textContent = mode === 'cell' ? 'Cells are numbered left to right, then top to bottom. Transparent cells are included.'
    : 'Scroll within the preview to inspect larger sheets. Select “Single cell” when a grid size is known.';
}

async function openDetail(id) {
  closeDetail();
  const controller = new AbortController(); detailController = controller;
  $('detail-body').hidden = true; $('detail-status').textContent = 'Loading sprite…';
  $('detail-title').textContent = 'Asset details'; $('detail-type').textContent = 'Sprite';
  $('detail-canvas').width = 0;
  if (!$('inspector').open) $('inspector').showModal();
  try {
    const asset = await json(`/api/assets/${id}`, controller.signal);
    if (controller.signal.aborted) return;
    selected = asset; showDetails(asset);
    const response = await fetch(imageURL(id), { signal: controller.signal });
    if (!response.ok) throw new Error('The PNG could not be loaded. Check its location and restart the viewer after regenerating the catalog.');
    const bitmap = await createImageBitmap(await response.blob());
    if (controller.signal.aborted) { bitmap.close(); return; }
    selectedBitmap = bitmap;
    $('detail-status').textContent = ''; drawDetail();
  } catch (error) { if (!controller.signal.aborted) $('detail-status').textContent = error.message; }
}

async function initialize() {
  try {
    options = await json('/api/options');
    const params = new URLSearchParams(location.search);
    type = options.types.some(item => item.value === params.get('type')) ? params.get('type') : '';
    const root = options.types.find(item => item.value === type)?.root;
    const requestedFolder = params.get('folder') ?? '';
    folder = type && requestedFolder && (root === '' || requestedFolder.startsWith(`${root}/`)) ? requestedFolder : '';
    sizeMode = params.get('sizeMode') === 'image' ? 'image' : 'cell';
    page = /^\d+$/.test(params.get('page') ?? '') ? Math.max(1, Math.min(1_000_000, Number(params.get('page')))) : 1;
    $('search').value = (params.get('q') ?? '').slice(0, 200);
    $('library-count').textContent = `${number(options.total)} PNG assets`;
    $('kind').replaceChildren(new Option('All content', ''));
    for (const item of options.kinds) $('kind').add(new Option(`${label(item.value)} (${number(item.count)})`, item.value));
    $('kind').value = params.get('kind') ?? ''; $('review').value = params.get('review') ?? '';
    document.querySelector(`input[name=size-mode][value=${sizeMode}]`).checked = true;
    renderTypes(); renderSizes(params.get('size') ?? ''); await loadPage();
  } catch (error) { $('result-count').textContent = 'Catalog unavailable'; $('gallery').setAttribute('aria-busy', 'false'); notice(error.message); }
}

$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { page = 1; loadPage(); }, 250); });
for (const id of ['kind', 'size', 'review']) $(id).addEventListener('change', () => { page = 1; loadPage(); });
for (const radio of document.querySelectorAll('input[name=size-mode]')) radio.addEventListener('change', () => { if (!options) return; sizeMode = radio.value; page = 1; renderSizes(); loadPage(); });
$('reset').addEventListener('click', reset);
$('retry').addEventListener('click', () => emptyNotice ? reset() : options ? loadPage() : initialize());
for (const [id, offset] of [['previous', -1], ['next', 1]]) $(id).addEventListener('click', () => {
  page = Math.max(1, Math.min(pageCount, page + offset)); loadPage();
  $('results-title').scrollIntoView({ block: 'start' });
});
$('close-detail').addEventListener('click', () => $('inspector').close());
$('inspector').addEventListener('close', closeDetail);
for (const id of ['view-mode', 'zoom', 'show-grid']) $(id).addEventListener('change', drawDetail);
$('cell-index').addEventListener('input', drawDetail);
$('copy-path').addEventListener('click', async () => {
  if (!selected) return;
  try { await navigator.clipboard.writeText(selected.location); $('copy-path').textContent = 'Path copied'; }
  catch { $('copy-path').textContent = 'Copy unavailable — select the path above'; }
});
window.addEventListener('pagehide', () => { queryController?.abort(); folderController?.abort(); thumbnailController?.abort(); observer?.disconnect(); closeDetail(); });
initialize();
