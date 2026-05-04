/**
 * Devnet SNS constants — shared by both the v1 SDK adapter (write ops via
 * `@bonfida/spl-name-service`) and any direct `getProgramAccounts` calls
 * we make against devnet (read ops). These are NOT exported by
 * `@solana-name-service/sns-sdk-kit` (kit hardcodes mainnet); we keep our
 * own copy here so a single source of truth backs every devnet path.
 *
 * Source: https://github.com/SolanaNameService/sns-sdk/blob/main/js/src/devnet.ts
 * Verified live via `getAccountInfo` on 2026-05-04.
 *
 * IMPORTANT: the `.sol` TLD address is DIFFERENT on devnet vs mainnet.
 * Mainnet `.sol` lives at `58Pwt…JPkx`; that address on devnet is in a
 * "squat" state (System-Program-owned, not a real Name Service account).
 * Always use these constants for any devnet SNS work.
 */
import { PublicKey } from '@solana/web3.js';

/** SPL Name Service program — same program ID on every Solana cluster. */
export const NAME_PROGRAM_ID = new PublicKey(
  'namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX',
);

/** The devnet `.sol` TLD account. Parent of every devnet `.sol` domain. */
export const DEVNET_SOL_TLD = new PublicKey(
  '5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2',
);

/** Devnet domain registration program (paid registration via USDC). */
export const DEVNET_REGISTER_PROGRAM_ID = new PublicKey(
  'snshBoEQ9jx4QoHBpZDQPYdNCtw7RMxJvYrKFEhwaPJ',
);

/** Devnet reverse-lookup class — used to look up a wallet's primary domain. */
export const DEVNET_REVERSE_LOOKUP_CLASS = new PublicKey(
  '7NbD1vprif6apthEZAqhRfYuhrqnuderB8qpnfXGCc8H',
);

/** Devnet USDC mint — what the SNS registrar accepts as payment for
 *  `tendr.sol`. Devnet USDC is freely faucet-able. */
export const DEVNET_USDC_MINT = new PublicKey(
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
);

/**
 * The Tender parent domain we mint subdomains under. Resolves at runtime
 * by hashing the name + deriving the PDA against the devnet `.sol` TLD;
 * does NOT depend on the parent existing yet (that's a separate one-off
 * registration step — see `scripts/register-tendr-devnet.mts`).
 *
 * Imported lazily to keep this file free of `@bonfida/spl-name-service`
 * (which pulls in big web3.js v1 deps); callers that need the pubkey can
 * import via `getTendrParentPubkey()` below.
 */
export const TENDR_PARENT_NAME = 'tendr';

/**
 * Derive the on-chain account address for `tendr.sol` on devnet. Cheap +
 * deterministic — no RPC calls.
 */
export async function getTendrParentPubkey(): Promise<PublicKey> {
  const { devnet } = await import('@bonfida/spl-name-service');
  return devnet.utils.getDomainKeySync(TENDR_PARENT_NAME).pubkey;
}
