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

export interface FundEphemeralUsdcAtaInput {
  /** Buyer's main wallet pubkey — pays the deposit tx. */
  walletPublicKey: PublicKey;
  /** Phantom-compatible signer that wraps a tx sign popup. */
  signTransaction: WalletAdapterSignTransaction;
  /** Phantom-compatible message-sign function (used by viewing-key registration). */
  signMessage: WalletAdapterSignMessage;
  /** Brand-new ephemeral wallet pubkey to receive USDC at its associated
   *  token account. The ATA is pre-created (idempotently) before the
   *  shielded deposit so the relay's withdraw can land into it. */
  ephemeralPubkey: PublicKey;
  /** USDC base units (6 decimals) to deposit. Cloak fees come out of this. */
  depositMicroUsdc: bigint;
  /** USDC mint. On devnet this is Cloak's mock USDC at
   *  `61ro7AExqfk4dZYoCyRzTahahCC2TdUUZ4M5epMPunJf`. On mainnet it's the
   *  real Circle USDC. */
  mint: PublicKey;
  /** v2 — when provided, ATA-create + ALT-create + ALT-extend are signed
   *  AND paid by this keypair instead of `walletPublicKey` (which would
   *  publicly link main wallet to the ephemeral on chain). The Cloak
   *  deposit itself still signs with main wallet (it has to — USDC source
   *  is main's ATA), but everything that *only* sets up the ephemeral's
   *  side moves under this keypair. The keypair must hold enough SOL to
   *  cover ~0.005 SOL of rent + fees; preflight at the call site. */
  ephemeralBootstrapKeypair?: import('@solana/web3.js').Keypair;
  connection: Connection;
  onProgress?: (p: CloakProgress) => void;
}

export interface FundEphemeralUsdcAtaResult {
  depositSig: string;
  withdrawSig: string;
  /** The ephemeral's USDC ATA that received the funds. */
  ephemeralAta: PublicKey;
  /** Tx that created the ephemeral's ATA (skipped if it already existed). */
  ataCreateSig?: string;
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

export interface SweepEphemeralUsdcInput {
  /** The ephemeral keypair holding the USDC. Signs ALL txs locally
   *  (ALT setup, deposit) — no wallet popup. */
  ephemeralKeypair: import('@solana/web3.js').Keypair;
  /** Where the USDC should land. The destination's USDC ATA is
   *  derived from this pubkey + mint. */
  destinationPubkey: import('@solana/web3.js').PublicKey;
  /** USDC base units to sweep (6 decimals — 1_000_000 = $1). Should
   *  leave enough USDC on the ephemeral to cover Cloak fees if any
   *  apply at withdraw time, and enough SOL for the ALT + deposit
   *  txs (~0.005 SOL). */
  sweepMicroUsdc: bigint;
  /** USDC mint (Cloak devnet mock or mainnet Circle). */
  mint: import('@solana/web3.js').PublicKey;
  connection: import('@solana/web3.js').Connection;
  onProgress?: (p: CloakProgress) => void;
}

export interface SweepEphemeralUsdcResult {
  depositSig: string;
  withdrawSig: string;
  /** The destination's USDC ATA — pre-created (idempotent) if it
   *  didn't exist. */
  destinationAta: import('@solana/web3.js').PublicKey;
  ataCreateSig?: string;
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
 * Fund an ephemeral wallet's USDC ATA from the buyer's main wallet via
 * Cloak's shielded UTXO pool. Mirrors `fundEphemeralWallet` but for
 * SPL tokens (USDC on devnet uses Cloak's mock mint) instead of SOL.
 *
 * Flow:
 *   1. Pre-create the ephemeral's USDC ATA from the main wallet via a
 *      regular `createAssociatedTokenAccountIdempotent` tx. Costs a
 *      few thousand lamports of rent. Done first because Cloak's relay
 *      withdraw expects the destination ATA to exist.
 *   2. Cloak shielded deposit: main wallet's USDC → Cloak shield pool.
 *      One Phantom popup. The deposit pulls USDC out of the main
 *      wallet's USDC ATA and consumes ~tens of thousands of lamports
 *      of SOL for the proof tx.
 *   3. Cloak shielded withdraw: pool → ephemeral's USDC ATA. Relay-paid,
 *      no popup. The ephemeral's USDC ATA receives the funds; the
 *      cryptographic link between deposit and withdraw is broken inside
 *      the pool by the UTXO + ZK-proof model.
 *
 * Privacy implication of step 1: the ATA-create tx is signed by the
 * main wallet, so anyone watching the main wallet sees `main ->
 * ATA(mint, ephemeral)`. The ATA address embeds the ephemeral pubkey
 * but observers can't deconvolve the derivation without the ephemeral
 * being public elsewhere. After the Cloak deposit/withdraw, the funds
 * are on the ephemeral's ATA with no shielded-pool-internal link to
 * the main. This is the same "ATA-create leaks the ephemeral" gap
 * Cloak's own faucet docs note; eliminating it cleanly would require
 * the relay to create ATAs (Cloak roadmap). For v2 we accept the
 * minimal leak and note it in the docs.
 */
export async function fundEphemeralUsdcAta(
  input: FundEphemeralUsdcAtaInput,
): Promise<FundEphemeralUsdcAtaResult> {
  const {
    walletPublicKey,
    signTransaction,
    signMessage,
    ephemeralPubkey,
    depositMicroUsdc,
    mint,
    ephemeralBootstrapKeypair,
    connection,
    onProgress,
  } = input;
  // When a bootstrap keypair is provided, ATA-create + ALT-setup are
  // routed through it (signed locally, paid from its lamports) so main
  // wallet never appears on chain as the rent-payer for the ephemeral's
  // accounts. Main wallet is still the Cloak deposit signer below — that
  // signature is unavoidable since USDC moves from main's ATA into the
  // shielded pool. The bootstrap keypair must already hold enough SOL
  // (~0.005 SOL covers ATA + ALT + tx fees); the orchestrator is
  // responsible for topping it up via Cloak before calling.
  const useBootstrap = !!ephemeralBootstrapKeypair;
  const bootstrapPayer: PublicKey = ephemeralBootstrapKeypair?.publicKey ?? walletPublicKey;

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
    // SPL-token-specific helper — returns the four pool PDAs for a given
    // (programId, mint) pair. Per Cloak's SDK skill, we must include
    // these in the ALT (along with sysvars + system programs) so the
    // deposit/withdraw txs fit under Solana's 1232-byte legacy tx limit.
    getShieldPoolPDAs,
  } = sdk;

  // Lazy-load spl-token + web3.js — both heavy and only needed on this
  // private-fund path. Same dynamic-import discipline as Cloak SDK.
  const {
    AddressLookupTableProgram,
    ComputeBudgetProgram,
    SystemProgram,
    SYSVAR_INSTRUCTIONS_PUBKEY,
    SYSVAR_SLOT_HASHES_PUBKEY,
    Transaction,
  } = await import('@solana/web3.js');
  const splToken = await import('@solana/spl-token');
  const ephemeralAta = await splToken.getAssociatedTokenAddress(mint, ephemeralPubkey, false);
  // Note: we deliberately do NOT pre-compute or pass main's USDC ATA
  // (the deposit's USDC source) anywhere here. Cloak's SDK derives the
  // depositor's source ATA internally from `depositor: walletPublicKey`
  // and references it in the deposit tx's static keys. We used to
  // pre-compute it as `payerAta` and stuff it in the ALT alongside the
  // ephemeral's ATA — that bundling let an analyst link main wallet ↔
  // ephemeral via a single on-chain account. Since any ATA reveals its
  // owner via on-chain `Account.owner`, putting an ATA in the ALT is
  // informationally identical to putting the owner there.

  // 1. Pre-create the ephemeral's USDC ATA. Idempotent — re-running is
  // a no-op + costs only the tx fee. Payer is the bootstrap keypair when
  // provided (signed locally, no popup, no main-wallet linkage on chain),
  // otherwise main wallet (legacy public-buyer path).
  let ataCreateSig: string | undefined;
  const existingAta = await connection.getAccountInfo(ephemeralAta);
  if (!existingAta) {
    const createIx = splToken.createAssociatedTokenAccountIdempotentInstruction(
      bootstrapPayer, // payer
      ephemeralAta, // ata to create
      ephemeralPubkey, // owner
      mint,
    );
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction().add(createIx);
    tx.feePayer = bootstrapPayer;
    tx.recentBlockhash = blockhash;
    let raw: Buffer;
    if (useBootstrap && ephemeralBootstrapKeypair) {
      tx.sign(ephemeralBootstrapKeypair);
      raw = tx.serialize();
    } else {
      const signed = await signTransaction(tx);
      raw = signed.serialize();
    }
    ataCreateSig = await connection.sendRawTransaction(raw, { skipPreflight: false });
    await connection.confirmTransaction(ataCreateSig, 'confirmed');
  }

  // 2. Build + activate Address Lookup Table (ALT). Required by the
  // Cloak SDK for SPL deposits — its `transact` will auto-create one
  // signed by `depositor` (= main wallet, with a popup) if we don't
  // pre-build. Pre-building lets us control two things:
  //   1. Signer: bootstrap keypair (= buyer-eph in HD-private mode) so
  //      the on-chain ALT-create tx isn't another main-wallet signature
  //      tied to this RFP.
  //   2. Contents: ONLY non-user-identifying addresses (sysvars + system
  //      programs + Cloak protocol PDAs). User-specific ATAs (main's
  //      USDC ATA, ephemeral's USDC ATA) deliberately do NOT go in the
  //      ALT — they live in their respective txs' static keys.
  //      Rationale: any ATA in the ALT == its owner in the ALT, since
  //      anyone can fetch the ATA account on chain and read its `owner`
  //      field. Putting both ATAs in the same ALT bundles main wallet
  //      with the ephemeral in a single on-chain account, defeating the
  //      Cloak entry's anonymity-set protection. With contents
  //      stripped, the ALT just publishes "buyer-eph used Cloak with
  //      mint X" — buyer-eph is already on-chain as rfp.buyer, so no
  //      new info is leaked.
  onProgress?.({ stage: 'derive_keypair', pct: 5 });
  const solPoolPdas = getShieldPoolPDAs(CLOAK_PROGRAM_ID);
  const tokenPoolPdas = getShieldPoolPDAs(CLOAK_PROGRAM_ID, mint);
  const altAccounts: Array<import('@solana/web3.js').PublicKey> = [
    SystemProgram.programId,
    SYSVAR_INSTRUCTIONS_PUBKEY,
    SYSVAR_SLOT_HASHES_PUBKEY,
    ComputeBudgetProgram.programId,
    CLOAK_PROGRAM_ID,
    splToken.TOKEN_PROGRAM_ID,
    ...Object.values(solPoolPdas),
    ...Object.values(tokenPoolPdas),
  ];
  // Dedupe (some PDAs may overlap between SOL + token bundles in
  // theory; cheap to filter regardless).
  const uniqAltAccounts = Array.from(new Map(altAccounts.map((a) => [a.toBase58(), a])).values());

  // ALT creation can transiently fail with "not a recent slot" if the
  // RPC's getSlot drifted ahead of what the runtime accepts. Skill
  // recommends retrying up to 3 times with a 2s pause. Authority + payer
  // are the bootstrap keypair when provided so the on-chain ALT account
  // (which bundles main's ATA + ephemeral's ATA in its address list) is
  // owned/funded by the ephemeral, not main.
  let altAddress: import('@solana/web3.js').PublicKey | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const slot = await connection.getSlot('finalized');
      const [createIx, derivedAddr] = AddressLookupTableProgram.createLookupTable({
        authority: bootstrapPayer,
        payer: bootstrapPayer,
        recentSlot: slot,
      });
      const extendIx = AddressLookupTableProgram.extendLookupTable({
        payer: bootstrapPayer,
        authority: bootstrapPayer,
        lookupTable: derivedAddr,
        addresses: uniqAltAccounts,
      });
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction().add(createIx, extendIx);
      tx.feePayer = bootstrapPayer;
      tx.recentBlockhash = blockhash;
      let raw: Buffer | Uint8Array;
      if (useBootstrap && ephemeralBootstrapKeypair) {
        tx.sign(ephemeralBootstrapKeypair);
        raw = tx.serialize();
      } else {
        const signed = await signTransaction(tx);
        raw = signed.serialize();
      }
      const sig = await connection.sendRawTransaction(raw, {
        skipPreflight: false,
      });
      await connection.confirmTransaction(sig, 'confirmed');
      altAddress = derivedAddr;
      break;
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (attempt < 3 && /not a recent slot/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 2_000));
        continue;
      }
      throw e;
    }
  }
  if (!altAddress) throw new Error('ALT creation did not succeed after 3 attempts');

  // Poll until the ALT is active. Skill recommends 30 attempts × 500ms;
  // we go to 40 to give some headroom on slow validators.
  let altAccount: import('@solana/web3.js').AddressLookupTableAccount | null = null;
  for (let i = 0; i < 40; i++) {
    const resp = await connection.getAddressLookupTable(altAddress);
    if (resp.value?.isActive()) {
      altAccount = resp.value;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!altAccount) throw new Error('ALT activation timed out');

  // Per-fund recipient UTXO keypair. Single-use — once the relay-paid
  // withdraw lands, the USDC is on the ephemeral's ATA and the UTXO
  // keypair has done its job.
  const recipientUtxo = await generateUtxoKeypair();

  // 3. Deposit — wallet-adapter signing path. Cloak pulls USDC from
  // the main wallet's USDC ATA into the shielded pool. ALT is now
  // attached so the v0 tx fits.
  onProgress?.({ stage: 'depositing', pct: 25 });
  const output = await createUtxo(depositMicroUsdc, recipientUtxo, mint);
  const deposited = await transact(
    {
      inputUtxos: [await createZeroUtxo(mint)],
      outputUtxos: [output],
      externalAmount: depositMicroUsdc,
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
      addressLookupTableAccounts: [altAccount],
      onProgress: (s) => {
        void s;
      },
    },
  );

  onProgress?.({ stage: 'awaiting_settlement', pct: 45 });

  // 4. Withdraw — relay-paid, no wallet popup. Destination must be the
  // ephemeral WALLET pubkey (on Ed25519 curve), NOT the ATA — recent
  // Cloak relay versions validate `recipient` is on-curve and reject
  // PDAs with "Recipient address is not on the Ed25519 curve". The
  // relay derives the ATA itself from (recipient, mint). Same ALT
  // attached + root-stale retry pattern as the SOL path.
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
        addressLookupTableAccounts: [altAccount],
      });
      break;
    } catch (e) {
      if (!isRootNotFoundError(e) || attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }
  if (!withdraw) throw new Error('Cloak USDC withdraw did not produce a result');

  onProgress?.({ stage: 'verifying', pct: 100 });
  await new Promise((r) => setTimeout(r, 5_000));

  return {
    depositSig: deposited.signature,
    withdrawSig: withdraw.signature,
    ephemeralAta,
    ataCreateSig,
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

/**
 * Sweep USDC from the ephemeral wallet's ATA back to a destination
 * wallet (typically the user's main) via Cloak's shielded pool. Mirror
 * of `fundEphemeralUsdcAta` with the signer flipped: the ephemeral
 * keypair signs everything locally (no popup); the destination's USDC
 * ATA is pre-created (idempotent) before the relay-paid withdraw.
 *
 * Pre-flight: requires ~0.005 SOL on the ephemeral for ALT setup +
 * deposit fees. Caller should validate balance and surface a friendly
 * error if insufficient.
 */
export async function sweepEphemeralUsdcToDestination(
  input: SweepEphemeralUsdcInput,
): Promise<SweepEphemeralUsdcResult> {
  const { ephemeralKeypair, destinationPubkey, sweepMicroUsdc, mint, connection, onProgress } =
    input;

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
    getShieldPoolPDAs,
  } = sdk;

  // Lazy-load web3.js + spl-token (heavy; only needed on this path).
  const {
    AddressLookupTableProgram,
    ComputeBudgetProgram,
    SystemProgram,
    SYSVAR_INSTRUCTIONS_PUBKEY,
    SYSVAR_SLOT_HASHES_PUBKEY,
    Transaction,
  } = await import('@solana/web3.js');
  const splToken = await import('@solana/spl-token');

  // Source ATA (the ephemeral's USDC ATA that holds the swept USDC) is
  // referenced by Cloak SDK internally via depositorKeypair; we don't
  // need to bundle it in our ALT (would leak ephemeral ↔ destination
  // grouping on chain). Same applies to destinationAta below — only the
  // create-idempotent path needs it locally.
  const destinationAta = await splToken.getAssociatedTokenAddress(mint, destinationPubkey, false);

  // 1. Pre-create the destination's USDC ATA if needed. Funded by
  // the ephemeral so the destination wallet doesn't need to do
  // anything to receive. Idempotent — re-running is a no-op.
  let ataCreateSig: string | undefined;
  const existingDestAta = await connection.getAccountInfo(destinationAta);
  if (!existingDestAta) {
    const createIx = splToken.createAssociatedTokenAccountIdempotentInstruction(
      ephemeralKeypair.publicKey, // payer = ephemeral
      destinationAta,
      destinationPubkey,
      mint,
    );
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction().add(createIx);
    tx.feePayer = ephemeralKeypair.publicKey;
    tx.recentBlockhash = blockhash;
    tx.sign(ephemeralKeypair);
    ataCreateSig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(ataCreateSig, 'confirmed');
  }

  // 2. Build + activate ALT — same recipe as the deposit path. SPL
  // shielded transfers reference too many accounts to fit in a legacy
  // tx; the ALT collapses them into 1-byte indices.
  // ALT contents — only non-user-identifying addresses. Both the
  // ephemeral's USDC ATA and the destination's USDC ATA leak their
  // owners (any ATA reveals owner via on-chain Account.owner), so
  // bundling them in one ALT would group ephemeral + destination on
  // chain — defeating the point of routing through Cloak. We let those
  // ATAs land in their respective txs' static keys instead.
  onProgress?.({ stage: 'derive_keypair', pct: 5 });
  const solPoolPdas = getShieldPoolPDAs(CLOAK_PROGRAM_ID);
  const tokenPoolPdas = getShieldPoolPDAs(CLOAK_PROGRAM_ID, mint);
  const altAccounts: Array<import('@solana/web3.js').PublicKey> = [
    SystemProgram.programId,
    SYSVAR_INSTRUCTIONS_PUBKEY,
    SYSVAR_SLOT_HASHES_PUBKEY,
    ComputeBudgetProgram.programId,
    CLOAK_PROGRAM_ID,
    splToken.TOKEN_PROGRAM_ID,
    splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
    mint,
    ...Object.values(solPoolPdas),
    ...Object.values(tokenPoolPdas),
  ];
  const uniqAltAccounts = Array.from(new Map(altAccounts.map((a) => [a.toBase58(), a])).values());

  let altAddress: import('@solana/web3.js').PublicKey | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const slot = await connection.getSlot('finalized');
      const [createIx, derivedAddr] = AddressLookupTableProgram.createLookupTable({
        authority: ephemeralKeypair.publicKey,
        payer: ephemeralKeypair.publicKey,
        recentSlot: slot,
      });
      const extendIx = AddressLookupTableProgram.extendLookupTable({
        payer: ephemeralKeypair.publicKey,
        authority: ephemeralKeypair.publicKey,
        lookupTable: derivedAddr,
        addresses: uniqAltAccounts,
      });
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction().add(createIx, extendIx);
      tx.feePayer = ephemeralKeypair.publicKey;
      tx.recentBlockhash = blockhash;
      tx.sign(ephemeralKeypair);
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      await connection.confirmTransaction(sig, 'confirmed');
      altAddress = derivedAddr;
      break;
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (attempt < 3 && /not a recent slot/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 2_000));
        continue;
      }
      throw e;
    }
  }
  if (!altAddress) throw new Error('ALT creation did not succeed after 3 attempts');

  let altAccount: import('@solana/web3.js').AddressLookupTableAccount | null = null;
  for (let i = 0; i < 40; i++) {
    const resp = await connection.getAddressLookupTable(altAddress);
    if (resp.value?.isActive()) {
      altAccount = resp.value;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!altAccount) throw new Error('ALT activation timed out');

  const recipientUtxo = await generateUtxoKeypair();

  // 3. Deposit — signed locally with ephemeral keypair (no popup).
  // Pulls USDC from the ephemeral's ATA into the shielded pool.
  onProgress?.({ stage: 'depositing', pct: 25 });
  const output = await createUtxo(sweepMicroUsdc, recipientUtxo, mint);
  const deposited = await transact(
    {
      inputUtxos: [await createZeroUtxo(mint)],
      outputUtxos: [output],
      externalAmount: sweepMicroUsdc,
      depositor: ephemeralKeypair.publicKey,
    },
    {
      connection,
      programId: CLOAK_PROGRAM_ID,
      relayUrl: CLOAK_RELAY_URL,
      depositorKeypair: ephemeralKeypair,
      walletPublicKey: ephemeralKeypair.publicKey,
      addressLookupTableAccounts: [altAccount],
    },
  );

  onProgress?.({ stage: 'awaiting_settlement', pct: 45 });
  await new Promise((r) => setTimeout(r, 20_000));

  // 4. Withdraw — relay-paid, no popup. Recipient must be the
  // destination WALLET pubkey (on Ed25519 curve), not the ATA — the
  // Cloak relay validates `recipient` is on-curve and rejects PDAs
  // ("Recipient address is not on the Ed25519 curve"). The relay
  // derives the ATA itself from (recipient, mint).
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
        addressLookupTableAccounts: [altAccount],
      });
      break;
    } catch (e) {
      if (!isRootNotFoundError(e) || attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }
  if (!withdraw) throw new Error('Cloak USDC sweep withdraw did not produce a result');

  onProgress?.({ stage: 'verifying', pct: 100 });
  await new Promise((r) => setTimeout(r, 5_000));

  return {
    depositSig: deposited.signature,
    withdrawSig: withdraw.signature,
    destinationAta,
    ataCreateSig,
  };
}
