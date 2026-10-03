// The recipes Methodos ships, each checked and given its digest when this module is loaded.
import { check, digest } from '../recipe.js';
import mapYourData from './map-your-data.js';
import publishADataset from './publish-a-dataset.js';

const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };

/** Each recipe, checked, frozen, with its digest. */
export const RECIPES = Object.fromEntries([mapYourData, publishADataset].map((r) => {
  check(r);
  return [r.key, deepFreeze({ ...r, digest: digest(r) })];
}));
