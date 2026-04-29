// Namespace re-exports avoid name collisions between sibling barrels
// (e.g. `BID_COMMIT_DISCRIMINATOR` exists in both accounts/ and instructions/).
export * as accounts from './generated/accounts';
export * as errors from './generated/errors';
export * as instructions from './generated/instructions';
export * as pdas from './generated/pdas';
export * as types from './generated/types';

// Program ID + program-level constants live at the root for ergonomics.
export * from './generated/programs';

// Manual PDA helpers (codama can't auto-derive when seeds include instruction args)
export * from './pdas-manual';
