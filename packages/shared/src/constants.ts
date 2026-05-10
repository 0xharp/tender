/**
 * Tender on-chain program ID. Read from `NEXT_PUBLIC_TENDER_PROGRAM_ID`
 * so the deployed program address is configured in one place
 * (`apps/web/.env.local`) and propagated everywhere — including
 * canonical message construction (fund-auth, bid-binding) where a
 * mismatch with the on-chain `crate::ID` causes silent
 * `InvalidAttestation` errors.
 *
 * Throws at module load if the env var is missing — better to fail
 * loudly during tests / build than to silently sign messages with the
 * wrong program ID at runtime.
 *
 * Note: Next.js inlines `NEXT_PUBLIC_*` references at build time even
 * inside workspace packages like this one, so the browser bundle ends
 * up with the literal string (no runtime env lookup in the browser).
 * Server-side / Node tests read it via the standard `process.env` path.
 */
const PROGRAM_ID = process.env.NEXT_PUBLIC_TENDER_PROGRAM_ID;

if (!PROGRAM_ID) {
  throw new Error(
    '@tender/shared: NEXT_PUBLIC_TENDER_PROGRAM_ID is not set. ' +
      'Configure it in apps/web/.env.local (and any test runner env) — see .env.example.',
  );
}

export const TENDER_PROGRAM_ID = PROGRAM_ID;

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
