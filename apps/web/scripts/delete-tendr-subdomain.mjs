#!/usr/bin/env node
/**
 * One-off: delete a `<handle>.tendr.sol` subdomain on devnet so the
 * handle can be re-claimed (typically for re-recording the demo flow
 * where the handle was already claimed in a prior session).
 *
 * Why this isn't a built-in app feature: the claim route's comment
 * explicitly notes "user can rename later via a separate burn-then-claim
 * flow we'll build if needed" — that flow hasn't been built. This
 * script is the manual stand-in.
 *
 * Who signs: the CURRENT owner of the subdomain registry. After mint,
 * that's the user's main wallet (Tendr's parent-owner only signed at
 * mint time to atomically transfer ownership; post-mint it has no
 * authority over the subdomain). So this script needs the SAME wallet
 * keypair the user connects to tendr.bid with.
 *
 * Usage:
 *   USER_WALLET_KEYPAIR=/path/to/keypair.json HANDLE=harp \
 *     node apps/web/scripts/delete-tendr-subdomain.mjs
 *
 * Defaults:
 *   USER_WALLET_KEYPAIR → $HOME/.config/solana/id.json
 *   HANDLE              → harp
 *   PARENT              → tendr (i.e. <HANDLE>.tendr.sol)
 *   SOLANA_RPC_URL      → falls through to devnet public RPC
 *
 * After it succeeds:
 *   1. Hard-refresh the tendr.bid tab to clear the SNS cache
 *   2. Re-claim the handle via the normal modal flow on next sign-in
 */
import fs from 'node:fs';
import { homedir } from 'node:os';

import { NameRegistryState, devnet } from '@bonfida/spl-name-service';
import { TransactionInstruction } from '@solana/web3.js';

// SPL Name Service program ID — same on every Solana cluster.
const NAME_PROGRAM_ID = new PublicKey('namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX');

// Build the DELETE ix by hand (opcode 3). We bypass Bonfida's high-level
// `deleteNameRegistry` because its internal PDA derivation calls
// `getHashedNameSync('demouser')` without the SNS subdomain null-byte
// prefix, producing a DIFFERENT PDA than `getDomainKeySync('demouser.tendr.sol')`.
// The high-level call would throw `DomainDoesNotExist` even when the
// registry exists. Building the ix directly with the explicit PDA we
// already derived correctly sidesteps that bug.
function buildDeleteInstruction(nameAccountKey, refundTarget, owner) {
  return new TransactionInstruction({
    programId: NAME_PROGRAM_ID,
    keys: [
      { pubkey: nameAccountKey, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: refundTarget, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([3]),
  });
}
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

// Inline base58 decoder — bs58 isn't installed in the workspace and we
// only need ~30 lines for this one-off. Bitcoin alphabet (matches what
// Phantom/Backpack/solana-keygen all use).
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(s) {
  const map = new Map();
  for (let i = 0; i < BASE58_ALPHABET.length; i++) map.set(BASE58_ALPHABET[i], i);
  const bytes = [0];
  for (const c of s) {
    const v = map.get(c);
    if (v === undefined) throw new Error(`invalid base58 char: ${c}`);
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Preserve leading zeros (each leading "1" in input = 0x00 byte)
  for (const c of s) {
    if (c !== '1') break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

const HANDLE = process.env.HANDLE ?? 'harp';
const PARENT = process.env.PARENT ?? 'tendr'; // resolves to <HANDLE>.tendr.sol
const RPC_URL =
  process.env.SOLANA_RPC_URL ??
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ??
  'https://api.devnet.solana.com';
const KEYPAIR_PATH = process.env.USER_WALLET_KEYPAIR ?? `${homedir()}/.config/solana/id.json`;

console.log('Config:');
console.log(`  Handle:     ${HANDLE}.${PARENT}.sol`);
console.log(`  RPC:        ${RPC_URL}`);
console.log(`  Keypair:    ${KEYPAIR_PATH}`);

// Load owner keypair — accepts either solana-keygen JSON array OR a
// base58 string (matches the Tendr parent-owner loader's tolerance).
function loadKeypair(path) {
  let raw = fs.readFileSync(path, 'utf8').trim();
  // Tolerate JSON-quoted base58 string (e.g. `"4aq3J..."`).
  if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
  if (raw.startsWith('[')) {
    return Keypair.fromSecretKey(new Uint8Array(JSON.parse(raw)));
  }
  // Base58 (e.g. exported from Phantom / Backpack)
  return Keypair.fromSecretKey(base58Decode(raw));
}

const userKeypair = loadKeypair(KEYPAIR_PATH);
console.log(`  Owner pubkey: ${userKeypair.publicKey.toBase58()}`);

const connection = new Connection(RPC_URL, 'confirmed');

// Derive the parent (.sol TLD on devnet — IMPORTANT: differs from mainnet,
// see apps/web/lib/sns/devnet/constants.ts comment for why).
const parentPk = devnet.utils.getDomainKeySync(`${PARENT}.sol`).pubkey;
console.log(`  Parent PDA:   ${parentPk.toBase58()}`);

// Derive the subdomain PDA we're about to delete (so we can verify
// ownership pre-delete and print it for any post-mortem).
const subdomainKey = devnet.utils.getDomainKeySync(`${HANDLE}.${PARENT}.sol`).pubkey;
console.log(`  Subdomain PDA: ${subdomainKey.toBase58()}`);

console.log('\nVerifying registry on chain + reading current owner...');

// Retrieve the registry directly from the PDA we computed via
// getDomainKeySync (the correct subdomain derivation, includes the
// null-byte prefix for the SNS subdomain convention). This both
// validates the account exists AND tells us the current owner — the
// pubkey that needs to sign the delete ix.
const registry = await NameRegistryState.retrieve(connection, subdomainKey);
console.log(`  Current owner on chain: ${registry.registry.owner.toBase58()}`);
if (!registry.registry.owner.equals(userKeypair.publicKey)) {
  console.error(
    `\n✗ Owner mismatch. The subdomain is owned by ${registry.registry.owner.toBase58()},`,
  );
  console.error(`  but the keypair you provided is ${userKeypair.publicKey.toBase58()}.`);
  console.error('  Make sure USER_WALLET_KEYPAIR points to the wallet that originally claimed it.');
  process.exit(1);
}

console.log('Building delete instruction...');
const deleteIx = buildDeleteInstruction(
  subdomainKey, // the correct PDA we already derived
  userKeypair.publicKey, // refund target (rent comes back to us)
  userKeypair.publicKey, // owner (must sign)
);

const tx = new Transaction().add(deleteIx);
console.log('Sending tx...');

try {
  const sig = await sendAndConfirmTransaction(connection, tx, [userKeypair], {
    commitment: 'confirmed',
    skipPreflight: false,
  });
  console.log('\n✓ Deleted.');
  console.log(`  Tx: https://solscan.io/tx/${sig}?cluster=devnet`);
  console.log(`\nNext steps:`);
  console.log(`  1. Hard-refresh https://tendr.bid (Cmd-Shift-R / Ctrl-Shift-R)`);
  console.log(`  2. Re-claim "${HANDLE}" via the identity modal on next sign-in`);
} catch (e) {
  console.error('\n✗ Delete failed:', e.message);
  console.error('\nCommon causes:');
  console.error(
    "  - Wrong keypair: the user wallet at $USER_WALLET_KEYPAIR isn't the current subdomain owner",
  );
  console.error(`    Run \`solana address -k ${KEYPAIR_PATH}\` and confirm it matches`);
  console.error('    the wallet you used to claim the handle on tendr.bid');
  console.error('  - Subdomain already deleted (no registry account at the PDA above)');
  console.error('  - RPC issue — try setting SOLANA_RPC_URL to a paid devnet endpoint');
  process.exit(1);
}
