// Buffer polyfill is installed at the top of the root layout via the
// BufferPolyfillProvider client component (runs once, browser-only). We
// deliberately do NOT polyfill here - overwriting Node's native Buffer at
// SSR time breaks Next's response pipe ("val must be string, number or Buffer").

/**
 * Cloak SDK wrapper - funding ephemeral bidder wallets via shielded transfer.
 *
 * Uses Cloak's wallet-adapter signing path (no private key export). Phantom
 * pops a transaction-sign popup for the deposit; the SDK handles withdraw via
 * its relay (relay pays the fee, ephemeral wallet receives SOL with zero
 * pre-balance).
 *
 * Privacy property: provider main → Cloak shielded pool → ephemeral wallet.
 * The cryptographic link between deposit and withdraw is broken inside the
 * pool by the UTXO + ZK-proof model. Practical anonymity scales with pool
 * volume; for a real pitch the property is "no on-chain link main→ephemeral".
 *
 * Mandatory dynamic import - Cloak SDK adds ~1.6MB gzipped + ZK proving libs.
 * `prefetchCloak()` warms the chunk on bid composer mount so the later
 * `fundEphemeralWallet` call is instant from the user's perspective.
 */
import type { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';

export type CloakProgress =
  | { stage: 'derive_keypair'; pct: 5 }
  | { stage: 'depositing'; pct: 25 }
  | { stage: 'awaiting_settlement'; pct: 45 }
  | { stage: 'shielded_transfer'; pct: 65 }
  | { stage: 'awaiting_settlement_2'; pct: 80 }
  | { stage: 'relay_withdraw'; pct: 95 }
  | { stage: 'verifying'; pct: 100 };

/** Shape Cloak's `transact()` expects for the wallet-adapter signing path. */
export type WalletAdapterSignTransaction = <T extends Transaction | VersionedTransaction>(
  transaction: T,
) => Promise<T>;
export type WalletAdapterSignMessage = (message: Uint8Array) => Promise<Uint8Array>;

export interface FundEphemeralInput {
  /** Provider's main wallet pubkey. */
  walletPublicKey: PublicKey;
  /** Phantom-compatible signer that wraps a tx sign popup. */
  signTransaction: WalletAdapterSignTransaction;
  /** Phantom-compatible message-sign function (used by viewing-key registration). */
  signMessage: WalletAdapterSignMessage;
  /** Brand-new ephemeral wallet pubkey to receive SOL. */
  ephemeralPubkey: PublicKey;
  /** Lamports to deposit. ~0.005 SOL deducted as Cloak fee; rest reaches ephemeral. */
  depositLamports: bigint;
  connection: Connection;
  onProgress?: (p: CloakProgress) => void;
}

export interface FundEphemeralResult {
  depositSig: string;
  withdrawSig: string;
  ephemeralReceivedLamports: bigint;
}

export interface SweepEphemeralInput {
  /** The ephemeral keypair holding the SOL. We sign the Cloak deposit with it
   *  locally - no Phantom popup (the ephemeral keypair is in our memory). */
  ephemeralKeypair: import('@solana/web3.js').Keypair;
  /** Where the SOL should land. Typically the provider's main wallet. */
  destinationPubkey: import('@solana/web3.js').PublicKey;
  /** How much to sweep. Should leave enough on ephemeral to pay the deposit
   *  tx fee (~0.001 SOL) and Cloak fees (~0.005 SOL). */
  sweepLamports: bigint;
  connection: import('@solana/web3.js').Connection;
  onProgress?: (p: CloakProgress) => void;
}

export interface SweepEphemeralResult {
  depositSig: string;
  withdrawSig: string;
  destinationReceivedLamports: bigint;
}

let cloakModulePromise: Promise<typeof import('@cloak.dev/sdk-devnet')> | null = null;

/** Prefetch the Cloak chunk + warm circuit cache. Call on bid composer mount. */
export function prefetchCloak(): Promise<typeof import('@cloak.dev/sdk-devnet')> {
  if (!cloakModulePromise) {
    cloakModulePromise = import('@cloak.dev/sdk-devnet');
  }
  return cloakModulePromise;
}

/**
 * Same-origin proxy path that forwards to api.devnet.cloak.ag (see
 * `apps/web/app/api/cloak/[...path]/route.ts`). The Cloak relay doesn't
 * include CORS headers for our deployed origin, so direct browser calls
 * fail with `Failed to fetch`. Routing the SDK through `/api/cloak`
 * keeps everything same-origin from the browser's perspective.
 *
 * Override via NEXT_PUBLIC_CLOAK_RELAY_URL if you ever want to point the
 * SDK directly at the upstream relay (e.g., in a localhost dev setup
 * where Cloak's CORS already whitelists localhost).
 */
const CLOAK_RELAY_URL =
  process.env.NEXT_PUBLIC_CLOAK_RELAY_URL && process.env.NEXT_PUBLIC_CLOAK_RELAY_URL.length > 0
    ? process.env.NEXT_PUBLIC_CLOAK_RELAY_URL
    : '/api/cloak';

/**
 * Fund a fresh ephemeral wallet from the provider's main wallet via Cloak's
 * shielded UTXO pool. The provider signs ONE Phantom popup for the deposit;
 * everything after (shielded transfer + relay-paid withdraw) is signless from
 * the user's perspective.
 *
 * Trade-off: ~75s end-to-end (proof gen + settlement waits). The bid composer
 * should run this in the background while the user fills the bid form so the
 * latency is hidden by their typing time.
 */
export async function fundEphemeralWallet(input: FundEphemeralInput): Promise<FundEphemeralResult> {
  const {
    walletPublicKey,
    signTransaction,
    signMessage,
    ephemeralPubkey,
    depositLamports,
    connection,
    onProgress,
  } = input;

  onProgress?.({ stage: 'derive_keypair', pct: 5 });
  const sdk = await prefetchCloak();
  const {
    CLOAK_PROGRAM_ID,
    transact,
    fullWithdraw,
    createUtxo,
    createZeroUtxo,
    generateUtxoKeypair,
    isRootNotFoundError,
    NATIVE_SOL_MINT,
  } = sdk;

  // Per-fund recipient UTXO keypair. We don't expose it back to the user -
  // once the relay-paid withdraw lands, the SOL is on the ephemeral wallet
  // and the UTXO keypair has done its job.
  const recipientUtxo = await generateUtxoKeypair();

  // 1. Deposit - wallet-adapter signing path.
  onProgress?.({ stage: 'depositing', pct: 25 });
  const output = await createUtxo(depositLamports, recipientUtxo, NATIVE_SOL_MINT);
  const deposited = await transact(
    {
      inputUtxos: [await createZeroUtxo(NATIVE_SOL_MINT)],
      outputUtxos: [output],
      externalAmount: depositLamports,
      depositor: walletPublicKey,
    },
    {
      connection,
      programId: CLOAK_PROGRAM_ID,
      relayUrl: CLOAK_RELAY_URL,
      signTransaction,
      signMessage,
      depositorPublicKey: walletPublicKey,
      walletPublicKey,
      onProgress: (s) => {
        // forward Cloak's internal status strings to our coarse stages
        void s;
      },
    },
  );

  onProgress?.({ stage: 'awaiting_settlement', pct: 45 });

  // 2. Withdraw - relay-paid, no wallet popup, ephemeral receives SOL.
  // Built-in retry for stale-root errors (Cloak's recommended pattern).
  onProgress?.({ stage: 'relay_withdraw', pct: 95 });
  let withdraw: Awaited<ReturnType<typeof fullWithdraw>> | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      withdraw = await fullWithdraw(deposited.outputUtxos, ephemeralPubkey, {
        connection,
        programId: CLOAK_PROGRAM_ID,
        relayUrl: CLOAK_RELAY_URL,
        walletPublicKey,
        signMessage,
        cachedMerkleTree: deposited.merkleTree,
      });
      break;
    } catch (e) {
      if (!isRootNotFoundError(e) || attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }
  if (!withdraw) throw new Error('Cloak withdraw did not produce a result');

  onProgress?.({ stage: 'verifying', pct: 100 });
  await new Promise((r) => setTimeout(r, 5_000));
  const lamports = await connection.getBalance(ephemeralPubkey);

  return {
    depositSig: deposited.signature,
    withdrawSig: withdraw.signature,
    ephemeralReceivedLamports: BigInt(lamports),
  };
}

/**
 * Sweep SOL from the ephemeral wallet back to a destination wallet (typically
 * the provider's main) via Cloak's shielded pool. Mirror image of
 * `fundEphemeralWallet` - same cryptographic unlinkability property, just
 * reversed.
 *
 * We use Cloak's keypair signing path (`depositorKeypair: ephemeralKeypair`)
 * because we hold the ephemeral keypair locally - no wallet popup needed.
 */
export async function sweepEphemeralToDestination(
  input: SweepEphemeralInput,
): Promise<SweepEphemeralResult> {
  const { ephemeralKeypair, destinationPubkey, sweepLamports, connection, onProgress } = input;

  onProgress?.({ stage: 'derive_keypair', pct: 5 });
  const sdk = await prefetchCloak();
  const {
    CLOAK_PROGRAM_ID,
    transact,
    fullWithdraw,
    createUtxo,
    createZeroUtxo,
    generateUtxoKeypair,
    isRootNotFoundError,
    NATIVE_SOL_MINT,
  } = sdk;

  const recipientUtxo = await generateUtxoKeypair();

  // 1. Deposit (signed locally with ephemeral keypair - no popup).
  onProgress?.({ stage: 'depositing', pct: 25 });
  const output = await createUtxo(sweepLamports, recipientUtxo, NATIVE_SOL_MINT);
  const deposited = await transact(
    {
      inputUtxos: [await createZeroUtxo(NATIVE_SOL_MINT)],
      outputUtxos: [output],
      externalAmount: sweepLamports,
      depositor: ephemeralKeypair.publicKey,
    },
    {
      connection,
      programId: CLOAK_PROGRAM_ID,
      relayUrl: CLOAK_RELAY_URL,
      depositorKeypair: ephemeralKeypair,
      walletPublicKey: ephemeralKeypair.publicKey,
    },
  );

  onProgress?.({ stage: 'awaiting_settlement', pct: 45 });
  await new Promise((r) => setTimeout(r, 20_000));

  // 2. Relay-paid withdraw to destination.
  onProgress?.({ stage: 'relay_withdraw', pct: 95 });
  let withdraw: Awaited<ReturnType<typeof fullWithdraw>> | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      withdraw = await fullWithdraw(deposited.outputUtxos, destinationPubkey, {
        connection,
        programId: CLOAK_PROGRAM_ID,
        relayUrl: CLOAK_RELAY_URL,
        depositorKeypair: ephemeralKeypair,
        walletPublicKey: ephemeralKeypair.publicKey,
        cachedMerkleTree: deposited.merkleTree,
      });
      break;
    } catch (e) {
      if (!isRootNotFoundError(e) || attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }
  if (!withdraw) throw new Error('Cloak sweep withdraw did not produce a result');

  onProgress?.({ stage: 'verifying', pct: 100 });
  await new Promise((r) => setTimeout(r, 5_000));
  const lamports = await connection.getBalance(destinationPubkey);

  return {
    depositSig: deposited.signature,
    withdrawSig: withdraw.signature,
    destinationReceivedLamports: BigInt(lamports),
  };
}
