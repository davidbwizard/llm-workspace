import { validateFarm } from './validation.mjs';
import { createFarmer } from './world.mjs';

export const SAVE_KEY = 'hearthfield.farm.v1';
export const BACKUP_KEY = `${SAVE_KEY}.backup`;
const MAX_SAVE_BYTES = 1_048_576;

/** Session identifiers/questions are transient, not part of the player's farm. */
function offlineFarm(state) {
  const farm = structuredClone(state);
  farm.workers = []; farm.connected = false; farm.sessionRevision = -1;
  farm.farmer ??= createFarmer();
  farm.farmer.action = 'idle'; farm.farmer.actionTime = 0;
  return farm;
}

export function serializeFarm(state) {
  validateFarm(state);
  const json = JSON.stringify({ version: 1, farm: offlineFarm(state) });
  if (json.length > MAX_SAVE_BYTES) throw new Error('Farm save is too large.');
  return json;
}

export function parseFarm(json) {
  if (typeof json !== 'string' || json.length > MAX_SAVE_BYTES) throw new Error('Farm save is missing or too large.');
  let document;
  try { document = JSON.parse(json); }
  catch (error) { throw new Error('Farm save contains invalid JSON.', { cause: error }); }
  if (!document || document.version !== 1 || !document.farm || document.farm.version !== 1) throw new Error('Unsupported farm save version.');
  validateFarm(document.farm);
  return offlineFarm(document.farm);
}

function tryParse(json) {
  if (json === null) return { state: null, error: null };
  try { return { state: parseFarm(json), error: null }; }
  catch (error) { return { state: null, error }; }
}

/** localStorage is atomic per key. A failed primary write leaves the backup intact. */
export function createSaveStore(storage) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') throw new Error('A save storage adapter is required.');
  return {
    load() {
      const primary = tryParse(storage.getItem(SAVE_KEY));
      if (primary.state) return { state: primary.state, warning: null };
      const backup = tryParse(storage.getItem(BACKUP_KEY));
      if (backup.state) return { state: backup.state, warning: 'The last save could not be loaded. Recovered the previous backup.' };
      if (!primary.error && !backup.error) return { state: null, warning: null };
      throw new Error('The farm save and backup could not be loaded. Your stored data has been preserved.', { cause: primary.error ?? backup.error });
    },
    save(state) {
      const serialized = serializeFarm(state);
      const previous = storage.getItem(SAVE_KEY);
      const parsedPrevious = tryParse(previous);
      if (parsedPrevious.state) storage.setItem(BACKUP_KEY, previous);
      else if (!tryParse(storage.getItem(BACKUP_KEY)).state) storage.setItem(BACKUP_KEY, serialized);
      storage.setItem(SAVE_KEY, serialized);
    },
  };
}
