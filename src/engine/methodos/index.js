// Methodos, the workflow manager's engine: recipes, operations, hand-offs, the runner, the adapters.
// A coordinator over the tools' engine, not a second engine: no page, no storage, plain ES modules
// that run in Node and in the worker alike (docs/plans/methodos.md, section 4).
export { OPERATIONS, isAvailable } from './operations.js';
export { TYPES, HandoffError, refsOf, refsDiffer, checkHandoff, isRef } from './handoffs.js';
export { RecipeError, check as checkRecipe, digest, canonical } from './recipe.js';
export { RECIPES } from './recipes/index.js';
export * as runner from './runner.js';
export { ADAPTERS, drive, runStep, stoppingKind, filesFor, problemOf } from './adapters.js';
