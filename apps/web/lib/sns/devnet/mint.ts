/**
 * Server-side `tendr.sol` subdomain minter — runs in Node (Next.js API
 * route handler). Uses the bonfida v1 SDK + `@solana/web3.js` v1, which
 * is the only path that has the right `devnet.bindings.createSubdomain`
 * + `devnet.bindings.transferSubdomain` for the address layout we need.
 *
 * The mint flow:
 *
 *   1. Build createSubdomain instruction(s) — these allocate the new
 *      `<handle>.tendr.sol` account owned by Tender's parent-domain
 *      owner (us), parented under devnet `tendr.sol`.
 *   2. Build transferSubdomain instruction with `isParentOwnerSigner=true`
 *      — this transfers ownership to the user wallet without requiring
 *      the user to sign.
 *   3. Bundle every instruction into ONE transaction, signed solely by
 *      the parent-owner keypair (loaded from env). The user receives
 *      ownership of the subdomain in a single round-trip; no popups.
 *
 * `import 'server-only'` enforces this never gets pulled into a client
 * bundle (would leak the parent-owner key handling).
 */
import 'server-only';

import { devnet } from '@bonfida/spl-name-service';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

import { TENDR_PARENT_NAME } from './constants';

// Use the same Helius devnet RPC as the rest of the app — public devnet
// is rate-limited + occasionally inconsistent, both of which are wrong
// trade-offs for a code path that submits real txs and reads accounts
// the SDK requires to be visible. Falls back through three options:
//   1. SOLANA_RPC_URL (explicit override for ops/CI)
//   2. NEXT_PUBLIC_HELIUS_RPC_URL (the standard devnet endpoint the app uses)
//   3. Public devnet (last-resort default; logs a warning at boot)
const DEVNET_RPC = (() => {
  if (process.env.SOLANA_RPC_URL && process.env.SOLANA_RPC_URL.length > 0) {
    return process.env.SOLANA_RPC_URL;
  }
  if (process.env.NEXT_PUBLIC_HELIUS_RPC_URL && process.env.NEXT_PUBLIC_HELIUS_RPC_URL.length > 0) {
    return process.env.NEXT_PUBLIC_HELIUS_RPC_URL;
  }
  console.warn(
    '[sns/devnet/mint] No SOLANA_RPC_URL or NEXT_PUBLIC_HELIUS_RPC_URL set; ' +
      'falling back to public devnet (rate-limited).',
  );
  return 'https://api.devnet.solana.com';
})();

/**
 * Lazy-loaded singleton — keypair lives in process memory once read.
 * Reads from `TENDR_PARENT_OWNER_PRIVATE_KEY`. Accepts either:
 *   - JSON array: `[1,2,...,64]` (64 ints) — what `solana-keygen` emits
 *   - Base58 string: standard private-key encoding
 *
 * Refusing both formats throws a clear error so the operator knows what
 * went wrong (rather than a downstream "invalid signature" surfacing).
 */
let _keypairCache: Keypair | null = null;
function loadParentOwnerKeypair(): Keypair {
  if (_keypairCache) return _keypairCache;
  const raw = process.env.TENDR_PARENT_OWNER_PRIVATE_KEY;
  if (!raw || raw.trim() === '') {
    throw new Error(
      'TENDR_PARENT_OWNER_PRIVATE_KEY env var is not set. ' +
        'This is the keypair that owns `tendr.sol` on devnet and signs ' +
        'every subdomain mint. See .env.example.',
    );
  }
  const trimmed = raw.trim();
  let secretKey: Uint8Array;
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as number[];
      if (!Array.isArray(arr) || arr.length !== 64) {
        throw new Error(`expected JSON array of 64 numbers, got length ${arr.length}`);
      }
      secretKey = Uint8Array.from(arr);
    } catch (e) {
      throw new Error(`TENDR_PARENT_OWNER_PRIVATE_KEY is not valid JSON-array format: ${(e as Error).message}`);
    }
  } else {
    // Base58. Use bs58 lazy-loaded since it's a transitive dep we may or may not have.
    // Prefer @solana/web3.js's internal bs58 helper to avoid adding a dep.
    // web3.js exposes nothing public, so we fall back to a hand-rolled tiny base58 decoder.
    secretKey = base58Decode(trimmed);
  }
  if (secretKey.byteLength !== 64) {
    throw new Error(
      `TENDR_PARENT_OWNER_PRIVATE_KEY decoded to ${secretKey.byteLength} bytes, expected 64.`,
    );
  }
  _keypairCache = Keypair.fromSecretKey(secretKey);
  return _keypairCache;
}

/**
 * Tiny self-contained base58 decoder — Bitcoin alphabet. Avoids adding a
 * runtime dep just for keypair env-var parsing. Throws on invalid chars.
 */
function base58Decode(s: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const ALPHABET_MAP: Record<string, number> = Object.fromEntries(
    [...ALPHABET].map((c, i) => [c, i]),
  );
  if (s.length === 0) return new Uint8Array(0);
  // Count leading '1' chars — each represents a leading 0x00 byte.
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  // Convert from base58 to base256 via repeated division.
  const b58 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const v = ALPHABET_MAP[s[i]!];
    if (v === undefined) throw new Error(`invalid base58 char '${s[i]}'`);
    b58[i] = v;
  }
  const decoded: number[] = [];
  let start = 0;
  while (start < b58.length) {
    let carry = 0;
    let allZero = true;
    for (let i = start; i < b58.length; i++) {
      const v = b58[i]! + carry * 58;
      b58[i] = (v / 256) | 0;
      carry = v % 256;
      if (b58[i] !== 0) allZero = false;
    }
    decoded.push(carry);
    if (allZero) break;
    while (start < b58.length && b58[start] === 0) start++;
  }
  decoded.reverse();
  const out = new Uint8Array(zeros + decoded.length);
  for (let i = 0; i < decoded.length; i++) out[zeros + i] = decoded[i]!;
  return out;
}

/** The on-chain pubkey that owns `tendr.sol` (derived from the env var). */
export function getParentOwnerPubkey(): PublicKey {
  return loadParentOwnerKeypair().publicKey;
}

export interface MintTendrSubdomainResult {
  txSignature: string;
  subdomainPubkey: string;
  ownerPubkey: string;
  fullName: string;
}

/**
 * Mint a `<handle>.tendr.sol` subdomain on devnet, transferring ownership
 * to `userWallet` in the same transaction. Tender (parent owner) signs +
 * pays rent; user does NOT need to sign anything.
 *
 * Throws if the handle is already taken (caller should pre-check via the
 * resolver — but the on-chain create instruction will also fail with
 * "account already in use" as a defense-in-depth).
 */
export async function mintTendrSubdomain(
  handle: string,
  userWallet: string,
): Promise<MintTendrSubdomainResult> {
  const parentOwner = loadParentOwnerKeypair();
  const userPk = new PublicKey(userWallet);
  const subdomain = `${handle}.${TENDR_PARENT_NAME}.sol`;
  const connection = new Connection(DEVNET_RPC, 'confirmed');

  // Defensive pre-flight: confirm tendr.sol is visible from THIS connection
  // before asking bonfida to derive subdomain ix(s) against it. The bonfida
  // SDK's createSubdomain calls `NameRegistryState.retrieve` on the parent
  // internally and throws a generic "The name account does not exist" if
  // it can't see the parent — we surface the same precondition here with
  // a more diagnosable message that includes the connection URL.
  const tendrParentPk = devnet.utils.getDomainKeySync(`${TENDR_PARENT_NAME}.sol`).pubkey;
  const parentInfo = await connection.getAccountInfo(tendrParentPk, 'confirmed');
  if (!parentInfo) {
    throw new Error(
      `tendr.sol parent (${tendrParentPk.toBase58()}) not visible from RPC ${DEVNET_RPC}. ` +
        `Verify with: solana account ${tendrParentPk.toBase58()} --url ${DEVNET_RPC}`,
    );
  }

  // Step 1: build createSubdomain instructions. The bonfida bindings
  // return ix[][] (outer = potential multi-tx split for very long names).
  // For our short handles (<=20 chars) this always collapses to a single
  // inner array, but we flatten defensively.
  const createIxs: TransactionInstruction[][] = await devnet.bindings.createSubdomain(
    connection,
    subdomain,
    parentOwner.publicKey,
  );

  // Step 2: build transferSubdomain instruction. Two important params:
  //
  //   - `isParentOwnerSigner=true`: signals WE (the parent domain owner)
  //     are signing the transfer rather than the current subdomain owner
  //     — the key that lets the mint happen in one tx without the user's
  //     signature.
  //
  //   - `owner=parentOwner.publicKey` (5th positional): MUST pass this.
  //     If left undefined, the SDK calls `NameRegistryState.retrieve` on
  //     the subdomain to look up its current owner — but the subdomain
  //     doesn't exist on chain yet (we're creating it in the SAME tx),
  //     so the lookup fails with "The name account does not exist".
  //     At this point in the create+transfer pipeline the soon-to-be-
  //     created subdomain WILL be owned by `parentOwner.publicKey`
  //     (createSubdomain assigns owner = parent_owner), so we hand the
  //     SDK that fact directly.
  const transferIx: TransactionInstruction = await devnet.bindings.transferSubdomain(
    connection,
    subdomain,
    userPk,
    true /* isParentOwnerSigner */,
    parentOwner.publicKey /* owner — skip the on-chain lookup that would 404 here */,
  );

  // Combine + send. flat() handles the ix[][] from createSubdomain.
  const allIxs: TransactionInstruction[] = [...createIxs.flat(), transferIx];
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({
    feePayer: parentOwner.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(...allIxs);
  tx.sign(parentOwner);

  const rawTx = tx.serialize();
  const txSignature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  await confirmTx(connection, txSignature, blockhash, lastValidBlockHeight);

  // Derive the subdomain's pubkey to return — same derivation the
  // bindings used internally, so the caller can immediately resolve.
  const subdomainKey = devnet.utils.getDomainKeySync(subdomain).pubkey;

  return {
    txSignature,
    subdomainPubkey: subdomainKey.toBase58(),
    ownerPubkey: userWallet,
    fullName: subdomain,
  };
}

/**
 * Confirm a tx with sane defaults. Polls every second up to 60s.
 */
async function confirmTx(
  connection: Connection,
  signature: string,
  blockhash: string,
  lastValidBlockHeight: number,
): Promise<void> {
  const result = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (result.value.err) {
    throw new Error(`Mint tx failed: ${JSON.stringify(result.value.err)}`);
  }
}
