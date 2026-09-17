import { createFarm, advanceFarm, command, applySessionSnapshot, upgradeFarm, moveFarmer, getInteractionTarget, nearPlot, nearAnimal, statsFor, BALANCE_GROUPS, BALANCE_FIELDS, DEFAULT_BALANCE } from './model.mjs';
import { CROPS, GOODS, GUARDS, SHOP, ANIMALS, POSTS, raidProfile, landCost, upgradeCost, guardStats } from './definitions.mjs';
import { createScene } from './scene.mjs';
import { createSessionSimulator, normalizeSnapshot } from './sessions.mjs';
import { createSaveStore, serializeFarm } from './storage.mjs';

const mounted = new WeakSet();
let mountSequence = 0;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const number = value => Math.floor(value);
const activityLabel = { working: 'Working', idle: 'Resting', waiting_input: 'Question waiting', waiting_permission: 'Permission waiting', error: 'Session error', unknown: 'Activity unknown' };
const button = (label, action, target = '', disabled = false, extra = '') => `<button type="button" data-act="${action}" data-target="${escape(target)}" data-focus="${action}:${escape(target)}" ${disabled ? 'disabled' : ''} ${extra}>${escape(label)}</button>`;
const reachLabel = (ready, near, label, verb) => ready && !near ? `Walk closer to ${verb}` : label;
const SUPPLIES = [
  ['Supplies', [['seeds', 'seeds'], ['feed', 'feed'], ['medicine', 'tonic']], 'blocked'],
  ['Goods', [['parsnip', 'parsnip'], ['wheat', 'wheat'], ['milk', 'milk'], ['wool', 'wool'], ['meat', 'meat'], ['hide', 'hide']], 'idle'],
];
const meter = (label, value, color = '') => `<div class="meter-row"><span>${label}</span><meter min="0" max="100" value="${value}" aria-label="${label}" class="${color}"></meter><span>${number(value)}%</span></div>`;
// Damageable stats have a configurable maximum, so their meter shows current/max, never a percentage.
const healthMeter = (label, value, max) => `<div class="meter-row"><span>${label}</span><meter min="0" max="${Math.max(1, max)}" value="${Math.min(value, max)}" aria-label="${label}"></meter><span>${number(value)} / ${number(max)}</span></div>`;

/** Mount an isolated farm. The caller owns its sessionSource/saveStore adapters.
 * onAttention receives (workerId, attention); the farm never answers host prompts.
 * Returns a synchronous, idempotent dispose function.
 */
export function mountFarm(root, { sessionSource, saveStore, onAttention, assetLoader } = {}) {
  if (!root || !sessionSource || !saveStore) throw new Error('mountFarm requires a root, sessionSource and saveStore.');
  if (mounted.has(root)) throw new Error('A farm is already mounted in this root.');
  mounted.add(root);
  const mountId = `farm-${++mountSequence}`;
  let state, disposed = false, selected = 'p1', tab = 'workers', paused = false, speed = 1, attentionId = null, slaughterId = null, newFarmPrompt = false, latestSnapshot = null, balanceOpen = false, renderedBalance = null, renderedSupplies = null;
  const heldDirections = new Set(); let canvas = null, movementDirty = false;
  let unsubscribe = () => {}, stopScene = () => {}, tick = 0, saves = 0, ui = 0, last = performance.now();
  const cleanup = () => {
    if (disposed) return;
    disposed = true; clearInterval(tick); clearInterval(saves); clearInterval(ui);
    // An adapter failure must not strand the renderer or prevent a later mount.
    const errors = [];
    try { unsubscribe(); } catch (error) { errors.push(error); }
    try { stopScene(); } catch (error) { errors.push(error); }
    root.removeEventListener('click', handleClick); root.removeEventListener('change', handleChange); root.removeEventListener('input', handleSlider); root.removeEventListener('change', handleSlider); root.removeEventListener('keydown', keydown); root.removeEventListener('keyup', keyup);
    canvas?.removeEventListener('blur', clearMovement); window.removeEventListener('blur', clearMovement); heldDirections.clear();
    document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', pagehide);
    mounted.delete(root); root.replaceChildren();
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Farm cleanup failed.');
  };
  let loaded;
  try { loaded = saveStore.load(); state = upgradeFarm(loaded.state ?? createFarm()); state.workers = []; state.sessionRevision = -1; state.connected = false; }
  catch (error) {
    root.innerHTML = `<main class="farm-load-error"><h1>Your farm could not be opened</h1><p role="alert">${escape(error.message)}</p><p>The saved data has been kept. Recover the save or its backup before reloading this page.</p></main>`;
    return cleanup;
  }
  const demo = typeof sessionSource.setActivity === 'function' && typeof sessionSource.add === 'function';
  root.innerHTML = `
    <div class="farm-shell">
      <header class="farm-header"><div class="farm-brand"><span class="brand-sprout" aria-hidden="true">♧</span><div><h1>Little Meadow</h1><p>A living farm, a little company.</p></div></div>
        <div class="farm-totals"><span><b data-coins></b> coins</span><span><b data-ready></b> ready to harvest</span><span class="demo-badge">${demo ? 'Standalone demo' : 'Farm companion'}</span></div></header>
      <div class="farm-notice" data-connection role="status" hidden></div>
      <div class="farm-notice error" data-error role="alert" hidden></div>
      <section class="supply-strip" data-supplies aria-label="Inventory"></section>
      <div class="world-layout"><section class="world-section" aria-label="Farm meadow">
        <div class="world-toolbar"><div><span class="live-dot" data-live-dot></span><span data-world-status>Growing together</span></div><div class="time-controls">${button('Pause', 'pause')}${button('Balance', 'balance-toggle', '', false, `aria-expanded="false" aria-controls="${mountId}-balance-panel"`)}<label class="sr-only" for="${mountId}-speed">Game speed</label><select id="${mountId}-speed" data-change="speed" aria-label="Game speed"><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option></select></div></div>
        <div class="world-frame"><canvas tabindex="0" aria-describedby="${mountId}-world-help" aria-label="Pixel farm with twelve crop plots, a farmhouse, livestock and session farmers. Select plots using the numbered buttons below." role="application"></canvas></div>
        <div class="world-caption"><span id="${mountId}-world-help">Click the farm · Arrow keys move · Space attacks / harvests / collects</span><span data-game-time></span></div>
        <p class="interaction-hint" data-interaction role="status"></p><div class="threat-status" data-threat></div>
        <div class="plot-picker"><span>Choose a plot</span><div role="group" aria-label="Select a farm plot">${state.plots.map((plot, i) => `<button type="button" data-plot="${plot.id}" data-focus="plot:${plot.id}" aria-label="Select plot ${i + 1}" aria-pressed="${i === 0}">${i + 1}</button>`).join('')}</div></div>
      </section><aside class="plot-inspector" aria-label="Selected plot"><div data-inspector></div><div class="farmer-health"><h3>Your farmer</h3><div data-main-health></div>${button('Heal farmer · 1 medicine', 'heal', 'main')}<p>Manual care works even when your helpers rest.</p></div></aside></div>
      <section class="management" aria-label="Farm management"><div class="management-nav" role="tablist" aria-label="Farm management">${[['workers', 'Farmers'], ['inventory', 'Store & trade'], ['animals', 'Livestock'], ['guards', 'Protectors'], ['policies', 'Farm settings']].map(([id, name]) => `<button type="button" role="tab" id="${mountId}-tab-${id}" data-tab="${id}" aria-controls="${mountId}-management-panel" aria-selected="${id === tab}">${name}</button>`).join('')}</div><div id="${mountId}-management-panel" class="management-panel" role="tabpanel" tabindex="0" data-panel></div></section>
      ${demo ? `<details class="demo-controls"><summary>Session simulator <span>Try worker activity, questions and encounters</span></summary><p>These controls change demo sessions only. One root session creates one farmer; child agents share that farmer.</p><div class="button-row">${button('Add demo farmer', 'demo-add')}${button('Simulate encounter', 'raid')}</div><div data-demo-workers></div></details>` : ''}
      <details class="farm-journal"><summary>Farm journal <span data-latest-event></span></summary><ol data-events></ol></details>
      <footer class="farm-footer"><div><span data-save-status role="status">${loaded.warning ? escape(loaded.warning) : 'Farm loaded · saves automatically'}</span> ${button('Retry save', 'save', '', false, 'hidden data-retry-save')}${button('Save now', 'save-now')}${button('Export save', 'export')}${button('New farm…', 'new-farm-prompt')}</div><span>Time pauses while this page is hidden.</span></footer>
      <p class="art-status" data-art-status role="status" hidden></p>
      <div class="dialog-backdrop" data-dialog-backdrop hidden><section class="farm-dialog" role="dialog" aria-modal="true" aria-labelledby="${mountId}-dialog-title" tabindex="-1" data-dialog><h2 id="${mountId}-dialog-title" data-dialog-title>Farm detail</h2></section></div>
      <aside id="${mountId}-balance-panel" class="balance-panel" data-balance-panel role="region" aria-label="Live balance editor" hidden></aside>
    </div>`;
  const $ = selector => root.querySelector(selector);
  canvas = $('canvas');
  const showError = message => { $('[data-error]').textContent = message; $('[data-error]').hidden = !message; };
  function save() {
    if (disposed) return;
    try { saveStore.save(state); movementDirty = false; $('[data-save-status]').textContent = `Saved locally at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`; $('[data-retry-save]').hidden = true; }
    catch (error) { $('[data-save-status]').textContent = `Save failed: ${error.message}. Keep this page open and retry, or export your farm.`; $('[data-retry-save]').hidden = false; }
  }
  function preserveFocus(element, html, force = false) {
    const active = document.activeElement;
    if (!force && element.contains(active)) {
      const template = document.createElement('template'); template.innerHTML = html;
      // Keep the active control and its ancestor chain attached to the document.
      // Unrelated status content can still change while a native select is open.
      function refresh(current, replacement) {
        const existing = [...current.childNodes], incoming = [...replacement.childNodes];
        for (let i = 0; i < Math.max(existing.length, incoming.length); i++) {
          const before = existing[i], after = incoming[i];
          if (!before) { current.append(after); continue; }
          if (!after) { before.remove(); continue; }
          if (before.nodeType === 1 && after.nodeType === 1 && before.tagName === after.tagName && before.contains(active)) {
            if (before === active && before.matches('select,input,textarea')) continue;
            for (const attr of [...before.attributes]) if (!after.hasAttribute(attr.name)) before.removeAttribute(attr.name);
            for (const attr of after.attributes) if (before.getAttribute(attr.name) !== attr.value) before.setAttribute(attr.name, attr.value);
            refresh(before, after);
          } else if (!before.isEqualNode(after)) before.replaceWith(after);
        }
      }
      refresh(element, template.content);
      return;
    }
    const key = element.contains(active) ? active.dataset.focus : null;
    element.innerHTML = html;
    if (key) [...element.querySelectorAll('[data-focus]')].find(node => node.dataset.focus === key)?.focus({ preventScroll: true });
  }
  function renderInspector(force) {
    const plot = state.plots.find(p => p.id === selected); if (!plot) return;
    if (!plot.unlocked) {
      const cost = landCost(state);
      preserveFocus($('[data-inspector]'), `<div class="inspector-heading"><span class="plot-number">${selected.slice(1)}</span><div><h2>Unclaimed land</h2><p>A new bed for your growing farm</p></div></div><p>Unlock this plot to let you and your helpers cultivate it.</p><div class="inspector-actions">${button(`Unlock plot · ${cost}c`, 'unlockPlot', plot.id, state.coins < cost, 'class="primary"')}</div><p class="quiet">The next plot costs ${cost} coins. Each purchase increases the price of future land by 25 coins.</p>`, force);
      return;
    }
    const crop = CROPS[plot.crop], land = statsFor(state, 'plots', 'land');
    const progress = Math.min(100, plot.growth / crop.growTime * 100);
    const labels = { empty: 'Ready for the first furrow', tilled: 'Prepared for planting', growing: `${number(progress)}% grown`, ready: 'Ready to harvest', dead: 'Ruined — tend this plot to repair it' };
    const near = nearPlot(state, plot.id);
    preserveFocus($('[data-inspector]'), `<div class="inspector-heading"><span class="plot-number">${selected.slice(1)}</span><div><h2>${escape(crop.name)} plot</h2><p>${labels[plot.stage]}</p></div></div>
      <label class="field-label">Planting plan<select data-change="crop" data-focus="crop" ${['growing', 'ready'].includes(plot.stage) ? 'disabled' : ''}>${Object.entries(CROPS).map(([key, def]) => `<option value="${key}" ${plot.crop === key ? 'selected' : ''}>${escape(def.name)} · ${def.growTime}s</option>`).join('')}</select></label>
      <div class="plot-meters">${healthMeter('Health', plot.health, land.maxHealth)}${meter('Growth', progress)}${meter('Water', plot.water, 'water')}${meter('Weeds', plot.weeds, 'weeds')}</div>
      <p class="quiet">${land.armor} defense</p>
      <div class="inspector-actions">${button(reachLabel(true, near, 'Tend this plot', 'tend'), 'tend', plot.id, state.mainCooldown > 0 || !near)}${button(reachLabel(plot.stage === 'ready', near, 'Harvest plot', 'harvest'), 'harvest', plot.id, plot.stage !== 'ready' || !near, 'class="primary"')}${button('Harvest all ready', 'harvestAll', '', !state.plots.some(p => p.stage === 'ready'))}</div><p class="quiet">Helpers prepare, plant, water and weed automatically. Harvesting is yours unless enabled in settings.</p>`, force);
  }
  const assignmentOptions = worker => [['auto', 'Automatic care'], ['livestock', 'Livestock'], ...state.plots.filter(p => p.unlocked).map(p => [p.id, `Plot ${p.id.slice(1)}`])].map(([key, label]) => `<option value="${key}" ${worker.assignment === key ? 'selected' : ''}>${label}</option>`).join('');
  function panelMarkup() {
    if (tab === 'workers') return `<div class="panel-intro"><h2>A few helping hands</h2><p>Active sessions work. Idle farmers rest. Questions pause their work until resolved.</p></div><div class="worker-list">${state.workers.length ? state.workers.map((worker, i) => `<article class="worker-row"><span class="worker-avatar avatar-${i % 3}" aria-hidden="true">${escape(worker.name.slice(0, 1))}</span><div class="worker-copy"><h3>${escape(worker.name)} <span class="activity ${worker.activity === 'working' ? 'working' : ''}">${activityLabel[worker.activity] ?? 'Activity unknown'}</span></h3><p>${escape(worker.action)}</p></div><label>Assignment<select data-change="assign" data-target="${escape(worker.id)}" data-focus="assign:${escape(worker.id)}" aria-label="Assignment for ${escape(worker.name)}">${assignmentOptions(worker)}</select></label>${worker.attention ? button('Read question', 'attention', worker.id, false, 'class="attention-button"') : ''}</article>`).join('') : '<p class="empty-state">No sessions are open. Your farmer can still tend the plots manually.</p>'}</div>`;
    if (tab === 'inventory') return `<div class="panel-intro"><h2>The farm store</h2><p>Harvests stay in your store until you sell them. Buy supplies to keep the farm going.</p></div><div class="trade-layout"><div><h3>Supplies</h3>${Object.entries(SHOP).filter(([key]) => !ANIMALS[key]).map(([key, item]) => `<div class="trade-row"><span>${escape(item.name)} <b>${state.inventory[key] ?? 0}</b></span>${button(`Buy ${item.quantity > 1 ? item.quantity + ' ' : ''}${key} · ${item.cost}c`, 'buy', key, state.coins < item.cost)}</div>`).join('')}${button('Claim starter seeds', 'recover', '', state.inventory.seeds > 0 || state.coins >= (SHOP.seeds?.cost ?? 8))}</div><div><h3>Goods to sell</h3>${Object.entries(GOODS).map(([key, item]) => `<div class="trade-row"><span>${escape(item.name)} <b>${state.inventory[key] ?? 0}</b> <small>${item.price}c each</small></span>${button(`Sell ${key}`, 'sell', key, !state.inventory[key])}</div>`).join('')}</div></div>`;
    if (tab === 'animals') return `<div class="panel-intro"><h2>Life in the pasture</h2><p>Well-fed animals provide milk and wool. Stand nearby and press Space to milk or shear when ready. Automatic collection is ${state.policy.autoCollect ? 'on: active helpers collect ready products.' : 'off: collect products yourself.'} Slaughter permanently removes an animal for meat and hides.</p></div><div class="button-row">${Object.entries(ANIMALS).map(([key, item]) => button(`Buy ${key} · ${item.cost}c`, 'buy', key, state.coins < item.cost)).join('')}</div><div class="animal-list">${state.animals.map(animal => {
      const max = statsFor(state, 'animals', animal.kind).maxHealth, near = nearAnimal(state, animal.id);
      const collectLabel = animal.kind === 'cow' ? 'Milk' : 'Shear', collectVerb = animal.kind === 'cow' ? 'milk' : 'shear';
      return `<article class="animal-row"><div><h3>${escape(animal.name)} <span>${escape(animal.kind)}</span></h3><p>${animal.produce} ${ANIMALS[animal.kind].product} ready</p><p class="quiet">${animal.produce >= 10 ? 'Production paused: collect stored products' : animal.hunger <= 20 ? 'Production paused: animal needs feed' : `Next ${ANIMALS[animal.kind].product} in ${Math.ceil(Math.max(0, ANIMALS[animal.kind].productionTime - animal.production))}s`}</p></div><div class="animal-meters">${healthMeter('Health', animal.health, max)}${meter('Fed', animal.hunger)}</div><div class="button-row">${button(reachLabel(animal.produce > 0, near, collectLabel, collectVerb), 'collect', animal.id, !animal.produce || !near)}${button(reachLabel(state.inventory.medicine > 0 && animal.health < max, near, 'Heal', 'heal'), 'heal', animal.id, !state.inventory.medicine || animal.health >= max || !near)}${button(reachLabel(true, near, 'Slaughter…', 'slaughter'), 'slaughter-prompt', animal.id, !near, 'class="subtle-danger"')}</div></article>`; }).join('') || '<p>No animals in the pasture yet.</p>'}</div>`;
    if (tab === 'guards') return `<div class="panel-intro"><h2>Keep the meadow safe</h2><p>Scouts carry swords, knights add shields, and rangers use bows. Choose a patrol post to protect crops or livestock, or send an expedition for rewards. Protectors fight to the death and won't retreat on their own; send a wounded one home to heal, and it returns to patrol automatically at full health.</p></div><div class="button-row">${Object.entries(GUARDS).map(([key, item]) => button(`Hire ${item.name.toLowerCase()} · ${item.cost}c`, 'hire', key, state.coins < item.cost)).join('')}</div>${state.guards.map(guard => {
      const cost = upgradeCost(guard), stats = guardStats(guard, state.balance);
      return `<article class="guard-row"><div><h3>${escape(GUARDS[guard.kind].name)} · Level ${guard.level}</h3><p>Weapon: ${escape(GUARDS[guard.kind].weaponLabel)}</p><p>${number(guard.health)} / ${guard.maxHealth} health · ${stats.power} power</p></div><label>Duty<select data-change="guardMode" data-target="${escape(guard.id)}" data-focus="guardMode:${escape(guard.id)}" aria-label="Duty for ${escape(guard.id)}">${['home', 'patrol', 'expedition'].map(mode => `<option value="${mode}" ${guard.mode === mode ? 'selected' : ''}>${mode[0].toUpperCase() + mode.slice(1)}</option>`).join('')}</select></label><label>Patrol post<select data-change="guardPost" data-target="${escape(guard.id)}" data-focus="guardPost:${escape(guard.id)}" aria-label="Patrol post for ${escape(guard.id)}">${Object.keys(POSTS).map(post => `<option value="${post}" ${guard.post === post ? 'selected' : ''}>${escape(post[0].toUpperCase() + post.slice(1))}</option>`).join('')}</select></label><div class="button-row">${button(guard.level >= 3 ? 'Fully upgraded' : `Upgrade · ${cost}c`, 'upgradeGuard', guard.id, guard.level >= 3 || state.coins < cost)}${button('Heal', 'heal', guard.id, !state.inventory.medicine || guard.health >= guard.maxHealth)}</div></article>`;
    }).join('')}<p class="quiet">${state.monsters.length} enemies near the farm. Next encounter in about ${Math.ceil(state.raidTimer)} seconds of game time.</p>`;
    return `<div class="panel-intro"><h2>Set your own rhythm</h2><p>Routine care is automatic. Choose how much of the harvest and trading to hand over.</p></div><div class="policy-list">${[['autoHarvest', 'Harvest ripe crops', 'Helpers pick crops when they are ready.'], ['autoSell', 'Sell goods automatically', 'All trade goods are sold as they become available.'], ['autoCollect', 'Collect milk and wool', 'Helpers collect ready animal products.'], ['autoHeal', 'Use medicine automatically', 'Spend medicine on injured farmers and protectors.']].map(([key, label, detail]) => `<label class="policy-row"><input type="checkbox" data-change="policy" data-target="${key}" data-focus="policy:${key}" ${state.policy[key] ? 'checked' : ''}><span><strong>${label}</strong><small>${detail}</small></span></label>`).join('')}</div>`;
  }
  // The number input is the only element carrying data-change="balance"; the paired
  // range slider forwards its drags onto that input so validation stays in one place.
  function balanceField(group, kind, field) {
    const rule = BALANCE_FIELDS[field], value = statsFor(state, group, kind)[field], def = DEFAULT_BALANCE[group][kind][field];
    const id = `${mountId}-balance-${group}-${kind}-${field}`, errorId = `${id}-error`;
    const step = rule.integer ? 1 : rule.max <= 10 ? 0.05 : 1;
    const ceiling = { maxHealth: 200, armor: 20, power: 40 }[field];
    const sliderMax = ceiling ? Math.min(rule.max, Math.max(ceiling, def * 4, value)) : rule.max;
    return `<div class="balance-field${value === def ? '' : ' balance-changed'}">
      <label>${escape(rule.name)} <small>${escape(rule.unit)} · Default: ${def}</small>
        <div class="balance-controls">
          <input type="range" min="${rule.min}" max="${sliderMax}" step="${step}" value="${value}" data-balance-slider data-group="${group}" data-kind="${kind}" data-field="${field}" data-focus="balance-range:${group}:${kind}:${field}" aria-label="${escape(rule.name)} slider">
          <input type="number" id="${id}" min="${rule.min}" max="${rule.max}" step="${step}" value="${value}" data-change="balance" data-group="${group}" data-kind="${kind}" data-field="${field}" data-focus="balance:${group}:${kind}:${field}" aria-invalid="false" aria-describedby="${errorId}">
        </div>
      </label>
      <p class="balance-error" id="${errorId}" role="alert"></p>
    </div>`;
  }
  function balanceMarkup() {
    const groups = Object.entries(BALANCE_GROUPS).map(([group, groupDef]) => `<section class="balance-group"><h2>${escape(groupDef.name)}</h2>${Object.entries(groupDef.kinds).map(([kind, kindDef]) => `<article class="balance-entry" data-balance-entry data-group="${group}" data-kind="${kind}"><h3>${escape(kindDef.name)}</h3>${kindDef.fields.map(field => balanceField(group, kind, field)).join('')}</article>`).join('')}</section>`).join('');
    return `<div class="balance-head"><h2>Balance</h2>${button('Close balance editor', 'balance-close')}</div><div class="balance-body" data-balance-body>${groups}</div><div class="balance-foot">${button('Restore default stats', 'resetBalance')}</div>`;
  }
  /** Empty supplies block play, so they warn; empty goods are the ordinary state. */
  function suppliesMarkup() {
    return SUPPLIES.map(([name, items, zeroClass]) =>
      `<span class="supply-tag">${name}</span>${items.map(([key, label]) => {
        const held = state.inventory[key] ?? 0;
        return `<span class="supply-cell${held ? '' : ` ${zeroClass}`}"><b>${number(held)}</b> ${label}</span>`;
      }).join('')}`).join('<span class="supply-sep" aria-hidden="true"></span>');
  }
  const interactionHint = $('[data-interaction]');
  function refreshInteraction() {
    const interaction = getInteractionTarget(state);
    const label = interaction ? `Space: ${interaction.type === 'attack' ? 'Attack' : interaction.type === 'harvest' ? 'Harvest' : 'Collect'} ${interaction.name}` : 'Move near an enemy, ripe crop or ready animal to use Space.';
    if (interactionHint.textContent !== label) interactionHint.textContent = label;
  }
  /** Mutates existing Tend/Harvest/Milk/Shear/Heal/Slaughter buttons in place so they
   * light up the moment the farmer arrives, without waiting for the 1s panel render. */
  const sync = (el, disabled, text) => { if (!el) return; if (el.disabled !== disabled) el.disabled = disabled; if (el.textContent !== text) el.textContent = text; };
  function refreshProximity() {
    const plot = state.plots.find(p => p.id === selected);
    if (plot?.unlocked) {
      const near = nearPlot(state, plot.id);
      const tendBtn = $('[data-inspector] [data-act="tend"]');
      sync(tendBtn, state.mainCooldown > 0 || !near, reachLabel(true, near, 'Tend this plot', 'tend'));
      const harvestBtn = $('[data-inspector] [data-act="harvest"]');
      sync(harvestBtn, plot.stage !== 'ready' || !near, reachLabel(plot.stage === 'ready', near, 'Harvest plot', 'harvest'));
    }
    if (tab !== 'animals') return;
    for (const animal of state.animals) {
      const near = nearAnimal(state, animal.id), max = statsFor(state, 'animals', animal.kind).maxHealth;
      const collectBtn = root.querySelector(`[data-act="collect"][data-target="${animal.id}"]`);
      sync(collectBtn, !animal.produce || !near, reachLabel(animal.produce > 0, near, animal.kind === 'cow' ? 'Milk' : 'Shear', animal.kind === 'cow' ? 'milk' : 'shear'));
      const healBtn = root.querySelector(`[data-act="heal"][data-target="${animal.id}"]`);
      sync(healBtn, !state.inventory.medicine || animal.health >= max || !near, reachLabel(state.inventory.medicine > 0 && animal.health < max, near, 'Heal', 'heal'));
      const slaughterBtn = root.querySelector(`[data-act="slaughter-prompt"][data-target="${animal.id}"]`);
      sync(slaughterBtn, !near, reachLabel(true, near, 'Slaughter…', 'slaughter'));
    }
  }
  function render(force = false) {
    if (disposed) return;
    $('[data-coins]').textContent = state.coins;
    const threat = raidProfile(state.harvests);
    $('[data-threat]').innerHTML = `<div><strong>Threat · ${escape(threat.name)}</strong><span>${state.harvests} harvests</span></div><meter min="0" max="36" value="${Math.min(36, state.harvests)}" aria-label="Harvest threat progression"></meter><p>${threat.nextAt === null ? 'Highest threat reached. Further harvests do not increase raid strength.' : `Next threat at ${threat.nextAt} harvests.`} Milestones: 0 slimes · 6 raiders · 18 spitters · 36 brutes. Threat increases with harvests, not idle time. Enemies can attack crops and livestock.</p>`;
    refreshInteraction();
    $('[data-ready]').textContent = state.plots.filter(p => p.stage === 'ready').length;
    const supplies = suppliesMarkup();
    if (supplies !== renderedSupplies) { $('[data-supplies]').innerHTML = supplies; renderedSupplies = supplies; }
    $('[data-game-time]').textContent = `${Math.floor(state.time / 60)}m ${Math.floor(state.time % 60)}s on the farm`;
    $('[data-world-status]').textContent = paused ? 'Taking a breather' : state.connected ? `${state.workers.filter(w => w.activity === 'working').length} farmers at work` : 'Connection paused';
    $('[data-live-dot]').classList.toggle('paused', paused || !state.connected);
    $('[data-connection]').hidden = state.connected;
    $('[data-connection]').textContent = 'Session connection unavailable. The whole farm is paused until the source reconnects.';
    const mainMax = statsFor(state, 'farmer', 'main').maxHealth;
    $('[data-main-health]').innerHTML = healthMeter('Health', state.mainHealth, mainMax);
    const heal = root.querySelector('[data-act="heal"][data-target="main"]'); heal.disabled = !state.inventory.medicine || state.mainHealth >= mainMax;
    for (const el of root.querySelectorAll('[data-plot]')) { const plot = state.plots.find(p => p.id === el.dataset.plot); el.setAttribute('aria-pressed', String(el.dataset.plot === selected)); el.classList.toggle('ready', plot.stage === 'ready'); el.classList.toggle('locked', !plot.unlocked); el.title = `Plot ${plot.id.slice(1)}: ${plot.unlocked ? plot.stage : 'locked'}`; el.setAttribute('aria-label', `Select plot ${plot.id.slice(1)}${plot.unlocked ? '' : ', locked'}`); }
    for (const el of root.querySelectorAll('[data-tab]')) el.setAttribute('aria-selected', String(el.dataset.tab === tab));
    $('[data-panel]').setAttribute('aria-labelledby', `${mountId}-tab-${tab}`);
    renderInspector(force); preserveFocus($('[data-panel]'), panelMarkup(), force);
    // Diff-merge the balance popup on every render (ignoring the outer force flag) so a
    // focused slider/number input survives timer ticks and session updates untouched.
    // Panel content depends only on state.balance, and each edit installs a new
    // object. Rebuilding it on the timer discarded the reader's scroll position and
    // wiped any visible validation message, so only rebuild when the tuning changed.
    if (balanceOpen && renderedBalance !== state.balance) {
      const body = $('[data-balance-body]'), top = body ? body.scrollTop : 0;
      preserveFocus($('[data-balance-panel]'), balanceMarkup(), false);
      const next = $('[data-balance-body]'); if (next && top) next.scrollTop = top;
      renderedBalance = state.balance;
    }
    $('[data-balance-panel]').hidden = !balanceOpen;
    root.querySelector('[data-act="balance-toggle"]').setAttribute('aria-expanded', String(balanceOpen));
    if (demo) preserveFocus($('[data-demo-workers]'), state.workers.map(worker => `<div class="demo-worker"><strong>${escape(worker.name)}</strong><label class="sr-only" for="${mountId}-demo-${escape(worker.id)}">Demo activity for ${escape(worker.name)}</label><select id="${mountId}-demo-${escape(worker.id)}" data-change="demo-activity" data-target="${escape(worker.id)}" data-focus="demo:${escape(worker.id)}">${Object.entries(activityLabel).map(([key, label]) => `<option value="${key}" ${worker.activity === key ? 'selected' : ''}>${label}</option>`).join('')}</select>${button('Ask demo question', 'demo-question', worker.id)}${button('Add 20 child agents', 'demo-children', worker.id)}${button('Finish session', 'demo-remove', worker.id)}</div>`).join(''), force);
    $('[data-latest-event]').textContent = state.events[0]?.text ?? '';
    $('[data-events]').innerHTML = state.events.map(event => `<li><time>${Math.floor(event.time / 60)}:${String(Math.floor(event.time % 60)).padStart(2, '0')}</time> ${escape(event.text)}</li>`).join('');
    if (attentionId) {
      const worker = state.workers.find(w => w.id === attentionId);
      if (!worker?.attention) closeDialog();
      else { $('[data-attention-text]').textContent = worker.attention.text;  $('[data-dialog-title]').textContent = `${worker.name} needs your attention`; }
    }
  }
  let previousFocus = null;
  function closeDialog() { attentionId = null; slaughterId = null; newFarmPrompt = false; $('[data-dialog-backdrop]').hidden = true; const restore = previousFocus?.isConnected ? previousFocus : [...root.querySelectorAll('[data-focus]')].find(node => node.dataset.focus === previousFocus?.dataset.focus); restore?.focus?.({ preventScroll: true }); }
  function showDialog(markup) { previousFocus = document.activeElement; $('[data-dialog]').innerHTML = markup; $('[data-dialog-backdrop]').hidden = false; $('[data-dialog]').focus(); }
  function openAttention(id) {
    const worker = state.workers.find(w => w.id === id); if (!worker?.attention) return;
    attentionId = id;
    showDialog(`<h2 id="${mountId}-dialog-title" data-dialog-title>${escape(worker.name)} needs your attention</h2><p class="quiet">${demo ? 'Demo session question' : escape(worker.attention.kind)}</p><p class="attention-text" data-attention-text>${escape(worker.attention.text)}</p><div class="button-row">${demo ? button('Resolve demo question', 'demo-resolve', id) : onAttention ? button('Open session question', 'host-attention', id) : ''}${button('Close', 'dialog-close')}</div>`);
  }
  function act(action) { try { command(state, action); showError(''); save(); render(true); } catch (error) { showError(error.message); } }
  function exportSave() {
    // Session labels/questions are never included in exports.
    const url = URL.createObjectURL(new Blob([serializeFarm(state)], { type: 'application/json' }));
    try {
      const link = document.createElement('a'); link.href = url; link.download = 'little-meadow-farm.json'; link.click();
    } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
  }
  function handleClick(event) {
    const target = event.target.closest('button'); if (!target || !root.contains(target)) return;
    if (target.dataset.plot) { selected = target.dataset.plot; render(true); return; }
    if (target.dataset.tab) { tab = target.dataset.tab; render(true); return; }
    const kind = target.dataset.act, id = target.dataset.target; if (!kind) return;
    try {
      if (kind === 'pause') { paused = !paused; clearMovement(); last = performance.now(); target.textContent = paused ? 'Resume' : 'Pause'; render(); }
      else if (kind === 'balance-toggle') { balanceOpen = !balanceOpen; render(); }
      else if (kind === 'balance-close') { balanceOpen = false; render(); }
      else if (kind === 'resetBalance') act({ type: 'resetBalance' });
      else if (kind === 'save' || kind === 'save-now') save();
      else if (kind === 'attention') openAttention(id);
      else if (kind === 'dialog-close') closeDialog();
      else if (kind === 'host-attention') { const worker = state.workers.find(w => w.id === id); if (worker?.attention) Promise.resolve(onAttention(id, worker.attention)).catch(error => { if (!disposed) showError(`Could not open session question: ${error.message}`); }); }
      else if (kind === 'demo-add') sessionSource.add();
      else if (kind === 'demo-question') sessionSource.setActivity(id, 'waiting_input', 'This is a demo question: should I continue with the next task?');
      else if (kind === 'demo-resolve') { sessionSource.setActivity(id, 'working'); closeDialog(); }
      else if (kind === 'demo-remove') sessionSource.remove(id);
      else if (kind === 'demo-children') sessionSource.addChildren(id, 20);
      else if (kind === 'slaughter-prompt') {
        const animal = state.animals.find(a => a.id === id); if (!animal) return; slaughterId = id;
        const def = ANIMALS[animal.kind];
        showDialog(`<h2 id="${mountId}-dialog-title" data-dialog-title>Slaughter ${escape(animal.name)}?</h2><p>This permanently removes this ${escape(animal.kind)} and its future ${escape(def.product)} production. You receive ${def.meat} meat and ${def.hide} hides.</p><div class="button-row">${button('Confirm slaughter', 'slaughter-confirm', id, false, 'class="danger"')}${button('Keep animal', 'dialog-close')}</div>`);
      } else if (kind === 'slaughter-confirm' && slaughterId === id) { act({ type: 'slaughter', animalId: id }); closeDialog(); }
      else if (kind === 'new-farm-prompt') {
        newFarmPrompt = true;
        showDialog(`<h2 id="${mountId}-dialog-title" data-dialog-title>Start a new farm?</h2><p>This replaces your current farm with 35 coins and three unlocked plots. We will export your current farm first so you can keep its progress. Your session connection stays the same.</p><div class="button-row">${button('Export & start new farm', 'new-farm-confirm', '', false, 'class="danger"')}${button('Keep this farm', 'dialog-close')}</div>`);
      } else if (kind === 'new-farm-confirm' && newFarmPrompt) {
        exportSave();
        const fresh = createFarm();
        if (latestSnapshot) applySessionSnapshot(fresh, latestSnapshot);
        fresh.connected = state.connected;
        // Keep the old live state if storage rejects the replacement.
        saveStore.save(fresh);
        heldDirections.clear(); movementDirty = false; state = fresh; selected = 'p1'; last = performance.now();
        closeDialog(); showError(''); render(true);
        $('[data-save-status]').textContent = 'Previous farm exported · new farm saved';
        $('[data-retry-save]').hidden = true;
      } else if (kind === 'export') exportSave();
      else if (['tend', 'harvest', 'unlockPlot'].includes(kind)) act({ type: kind, plotId: id });
      else if (kind === 'upgradeGuard') act({ type: kind, guardId: id });
      else if (kind === 'collect') act({ type: kind, animalId: id });
      else if (kind === 'heal') act({ type: kind, targetId: id });
      else if (kind === 'hire') act({ type: kind, kind: id });
      else if (['buy', 'sell'].includes(kind)) act({ type: kind, item: id });
      else if (['harvestAll', 'raid', 'recover'].includes(kind)) act({ type: kind });
    } catch (error) { showError(error.message); }
  }
  function handleChange(event) {
    const target = event.target; const kind = target.dataset.change, id = target.dataset.target;
    if (!kind) return;
    if (kind === 'speed') { speed = Number(target.value); if (![1, 2, 4].includes(speed)) speed = 1; last = performance.now(); }
    else if (kind === 'crop') act({ type: 'crop', plotId: selected, crop: target.value });
    else if (kind === 'assign') act({ type: 'assign', workerId: id, targetId: target.value });
    else if (kind === 'guardMode') act({ type: 'guardMode', guardId: id, mode: target.value });
    else if (kind === 'guardPost') act({ type: 'guardPost', guardId: id, post: target.value });
    else if (kind === 'policy') act({ type: 'policy', key: id, value: target.checked });
    else if (kind === 'demo-activity') { try { sessionSource.setActivity(id, target.value); } catch (error) { showError(error.message); } }
    else if (kind === 'balance') applyBalanceEdit(target);
  }
  function handleSlider(event) {
    const target = event.target; if (!target.matches('[data-balance-slider]')) return;
    const { group, kind, field } = target.dataset;
    const paired = $(`[data-change="balance"][data-group="${group}"][data-kind="${kind}"][data-field="${field}"]`);
    if (!paired) return;
    paired.value = target.value;
    applyBalanceEdit(paired, event.type === 'change');
  }
  /** Blank/out-of-range edits fail visibly on the field itself: no save, no global error. */
  function applyBalanceEdit(input, persist = true) {
    const { group, kind, field } = input.dataset;
    const rule = BALANCE_FIELDS[field];
    const describedEl = $(`#${input.getAttribute('aria-describedby')}`);
    const fail = message => { input.setAttribute('aria-invalid', 'true'); if (describedEl) describedEl.textContent = message; };
    const raw = input.value.trim();
    if (raw === '') return fail(`${rule.name} is required.`);
    const value = Number(raw);
    if (!Number.isFinite(value)) return fail(`${rule.name} must be a number.`);
    try { command(state, { type: 'balance', group, kind, field, value }); }
    catch (error) { return fail(error.message); }
    input.setAttribute('aria-invalid', 'false'); if (describedEl) describedEl.textContent = '';
    showError(''); if (persist) save(); render(persist);
  }
  function clearMovement() {
    heldDirections.clear();
    if (state.farmer.action === 'walk') state.farmer.action = 'idle';
    if (movementDirty) save();
  }
  function keyup(event) {
    if (heldDirections.delete(event.key) && heldDirections.size === 0) clearMovement();
  }
  function visibility() { heldDirections.clear(); if (state.farmer.action === 'walk') state.farmer.action = 'idle'; last = performance.now(); if (document.hidden) save(); }
  function pagehide() { save(); cleanup(); }
  function keydown(event) {
    if (event.target === canvas && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      if (paused || !state.connected || document.hidden) return;
      if (event.key === ' ') { if (!event.repeat) act({ type: 'interact' }); }
      else if (!event.repeat) heldDirections.add(event.key);
      return;
    }
    if (!$('[data-dialog-backdrop]').hidden) {
      if (event.key === 'Escape') closeDialog();
      if (event.key === 'Tab') { const items = [...$('[data-dialog]').querySelectorAll('button:not(:disabled),select')]; const first = items[0], end = items.at(-1); if (event.shiftKey && (document.activeElement === first || document.activeElement === $('[data-dialog]'))) { event.preventDefault(); end?.focus(); } else if (!event.shiftKey && document.activeElement === end) { event.preventDefault(); first?.focus(); } }
    }
    const current = event.target.closest('[role="tab"]');
    if (current && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { const tabs = [...root.querySelectorAll('[role="tab"]')]; const index = tabs.indexOf(current); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; event.preventDefault(); tabs[next].click(); tabs[next].focus(); }
  };
  root.addEventListener('click', handleClick); root.addEventListener('change', handleChange); root.addEventListener('input', handleSlider); root.addEventListener('change', handleSlider); root.addEventListener('keydown', keydown); root.addEventListener('keyup', keyup);
  canvas.addEventListener('blur', clearMovement); window.addEventListener('blur', clearMovement);
  document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', pagehide);
  try {
    unsubscribe = sessionSource.subscribe(input => {
      if (disposed) return;
      try { const snapshot = normalizeSnapshot(input); if (applySessionSnapshot(state, snapshot)) { latestSnapshot = { version: snapshot.version, revision: snapshot.revision, connected: snapshot.connected, sessions: snapshot.sessions }; if (!state.connected) clearMovement(); render(true); } }
      catch (error) { state.connected = false; clearMovement(); showError(`Session update rejected: ${error.message}`); render(); }
    });
  } catch (error) { state.connected = false; clearMovement(); showError(`Session connection failed: ${error.message}`); }
  stopScene = createScene($('canvas'), { assetLoader, getState: () => state, getSelected: () => selected, isPaused: () => paused || !state.connected, onSelect: id => { selected = id; render(true); }, onAttention: openAttention, onArtError: message => { if (!disposed) { $('[data-art-status]').hidden = false; $('[data-art-status]').textContent = `Some artwork could not load (${message}). The farm controls still work. Reload to retry artwork.`; } } });
  render();
  tick = setInterval(() => {
    const now = performance.now(), seconds = (now - last) / 1000; last = now;
    if (!paused && !document.hidden && seconds >= 0 && seconds <= 2) {
      try {
        const focused = document.activeElement === canvas;
        const dx = focused ? Number(heldDirections.has('ArrowRight')) - Number(heldDirections.has('ArrowLeft')) : 0;
        const dy = focused ? Number(heldDirections.has('ArrowDown')) - Number(heldDirections.has('ArrowUp')) : 0;
        if (moveFarmer(state, dx, dy, seconds)) movementDirty = true;
        advanceFarm(state, seconds * speed);
        refreshInteraction(); refreshProximity();
      } catch (error) { paused = true; clearMovement(); showError(`Farm paused: ${error.message}`); }
    }
  }, 50);
  ui = setInterval(() => render(), 1000); saves = setInterval(save, 5000);
  return () => { if (!disposed) save(); cleanup(); };
}

async function bootstrap() {
  const root = document.querySelector('[data-farm-app]'); if (!root) return;
  if (!navigator.locks?.request) { root.innerHTML = '<main class="farm-load-error"><h1>This browser cannot protect your save</h1><p>Open this local farm in a browser with Web Locks support.</p></main>'; return; }
  try {
    await navigator.locks.request('little-meadow-standalone-save', { ifAvailable: true }, async lock => {
      if (!lock) { root.innerHTML = '<main class="farm-load-error"><h1>Your farm is already open</h1><p>Use the other tab, or close it and reload here. Only one tab can run and save this farm at a time.</p></main>'; return; }
      const source = createSessionSimulator();
      const dispose = mountFarm(root, { sessionSource: source, saveStore: createSaveStore(localStorage) });
      await new Promise(resolve => window.addEventListener('pagehide', resolve, { once: true }));
      dispose(); source.dispose();
    });
  } catch (error) { root.innerHTML = `<main class="farm-load-error"><h1>The farm could not start</h1><p role="alert">${escape(error.message)}</p></main>`; }
}
if (typeof document !== 'undefined' && document.querySelector('[data-farm-app]')) {
  let standaloneRun = bootstrap();
  window.addEventListener('pageshow', async event => {
    if (event.persisted) { await standaloneRun; standaloneRun = bootstrap(); }
  });
}
