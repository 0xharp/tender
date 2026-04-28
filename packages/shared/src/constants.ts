export const TENDER_PROGRAM_ID = 'Tender1111111111111111111111111111111111111';

export const RFP_CATEGORIES = [
  'audit',
  'design',
  'engineering',
  'legal',
  'marketing',
  'market_making',
  'other',
] as const;
export type RfpCategory = (typeof RFP_CATEGORIES)[number];

export const MIN_MILESTONE_COUNT = 1;
export const MAX_MILESTONE_COUNT = 8;

export const USDC_DECIMALS = 6;

export const AI_SIDECAR_DEFAULT_PORT = 7777;
export const AI_SIDECAR_DEFAULT_URL = `http://localhost:${AI_SIDECAR_DEFAULT_PORT}`;
