// Namespace re-exports avoid name collisions between sibling barrels
// (e.g. `BID_COMMIT_DISCRIMINATOR` exists in both accounts/ and instructions/).
export * as accounts from './generated/accounts/index.js';
export * as errors from './generated/errors/index.js';
export * as instructions from './generated/instructions/index.js';
export * as pdas from './generated/pdas/index.js';
export * as types from './generated/types/index.js';

// Program ID + program-level constants live at the root for ergonomics.
export * from './generated/programs/index.js';

// Manual PDA helpers (codama can't auto-derive when seeds include instruction args)
export * from './pdas-manual.js';
