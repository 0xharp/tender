#!/usr/bin/env node
/**
 * One-off script: register `tendr.sol` on DEVNET.
 *
 * The wallet you load here (default: ~/.config/solana/id.json) becomes
 * the OWNER of `tendr.sol`. That same wallet is what must sign every
 * subdomain mint via `lib/sns/devnet/mint.ts`, so set the same key as
 * `TENDR_PARENT_OWNER_PRIVATE_KEY` in `apps/web/.env.local` after this
 * runs (the script prints what to paste).
 *
 * Cost: ~0.005 devnet SOL (rent + tx fees) + USDC charged by the SNS
 * registrar. Devnet USDC is freely faucet-able at:
 *   https://spl-token-faucet.com  (mint: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU)
 *   or via https://faucet.circle.com (Circle's official devnet faucet)
 *
 * Idempotency: re-running fails fast if `tendr.sol` is already
 * registered on devnet (the registrar reverts with an account-already-
 * in-use error). Safe to retry on transient RPC failures.
 *
 * Usage:
 *   node apps/web/scripts/register-tendr-devnet.mjs
 *
 * Env:
 *   SOLANA_RPC_URL  — defaults to public devnet
 *   KEYPAIR_PATH    — defaults to ~/.config/solana/id.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { devnet } from '@bonfida/spl-name-service';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js';

const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const KP =
  process.env.KEYPAIR_PATH ??
  path.join(process.env.HOME ?? '', '.config/solana/id.json');

const TENDR_NAME = 'tendr';
// Account data size for `tendr.sol`. The header (96 bytes) is mandatory;
// extra bytes go in the data section (used for SOL records, IPFS CIDs,
// etc.). 1000 bytes leaves room for any future records we attach to the
// parent domain without re-registering. Rent ~0.007 SOL.
const SPACE = 1000;

function loadKeypair(p) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, 'utf8'))));
}

async function main() {
  console.log(`RPC: ${RPC}`);
  console.log(`Keypair: ${KP}\n`);
  const connection = new Connection(RPC, 'confirmed');
  const buyer = loadKeypair(KP);
  console.log(`Buyer / parent owner: ${buyer.publicKey.toBase58()}`);

  // Derive the address tendr.sol would land at — lets us check existence
  // before doing anything expensive.
  const tendrPubkey = devnet.utils.getDomainKeySync(TENDR_NAME).pubkey;
  console.log(`tendr.sol PDA       : ${tendrPubkey.toBase58()}\n`);

  const existing = await connection.getAccountInfo(tendrPubkey);
  if (existing) {
    console.log('✓ tendr.sol is ALREADY registered on devnet');
    console.log(`  owner: ${existing.owner.toBase58()}`);
    console.log(`  data size: ${existing.data.length} bytes`);
    if (existing.owner.equals(devnet.constants.NAME_PROGRAM_ID)) {
      console.log('  ✓ correctly owned by the Name Service program');
    } else {
      console.log('  ✗ NOT owned by Name Service program — this is unexpected');
    }
    printEnvHelp(buyer);
    return;
  }

  // Pre-flight: make sure the buyer has a USDC ATA + enough USDC + enough SOL.
  const usdcMint = devnet.constants.USDC_MINT;
  const buyerUsdcAta = getAssociatedTokenAddressSync(
    usdcMint,
    buyer.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  console.log(`Buyer USDC ATA: ${buyerUsdcAta.toBase58()}`);
  const ataInfo = await connection.getAccountInfo(buyerUsdcAta);
  if (!ataInfo) {
    console.error('\n✗ Buyer has no devnet USDC token account.');
    console.error(
      `  Get devnet USDC at https://spl-token-faucet.com or https://faucet.circle.com`,
    );
    console.error(`  USDC mint: ${usdcMint.toBase58()}`);
    process.exit(1);
  }
  const solBalance = await connection.getBalance(buyer.publicKey);
  console.log(`Buyer SOL balance: ${(solBalance / 1e9).toFixed(4)}`);
  if (solBalance < 0.01 * 1e9) {
    console.error('\n✗ Buyer needs at least 0.01 devnet SOL for rent + fees.');
    console.error(`  Airdrop: solana airdrop 1 ${buyer.publicKey.toBase58()} --url devnet`);
    process.exit(1);
  }

  // Build registration tx via bonfida's devnet bindings.
  //
  // IMPORTANT: use `registerDomainName` (v1), NOT `registerDomainNameV2`.
  // v2 looks the payment mint up in `PYTH_PULL_FEEDS` from the SDK's
  // mainnet constants, which does NOT include the devnet USDC mint —
  // throws `PythFeedNotFoundError` immediately. v1 looks it up in the
  // devnet `PYTH_FEEDS` map (legacy oracle accounts) which DOES have
  // devnet USDC. The on-chain registrar program supports both code
  // paths; the v1 difference is just which Pyth account layout is
  // passed in the instruction. Swap to v2 once SNS ships devnet pull
  // feeds in the SDK.
  console.log('\nBuilding registration tx (v1, devnet legacy Pyth path)…');
  const ixGroups = await devnet.bindings.registerDomainName(
    connection,
    TENDR_NAME,
    SPACE,
    buyer.publicKey,
    buyerUsdcAta,
  );
  // v1 returns ix[][] (multi-tx-capable); flatten because for a single
  // 5-char domain the inner arrays trivially fit in one tx.
  const ixs = ixGroups.flat();

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({
    feePayer: buyer.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(...ixs);
  tx.sign(buyer);

  console.log(`Sending tx (${ixs.length} ix${ixs.length === 1 ? '' : 's'})…`);
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  console.log(`  signature: ${signature}`);
  const result = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (result.value.err) {
    console.error(`\n✗ Tx failed: ${JSON.stringify(result.value.err)}`);
    console.error(`  Solscan: https://solscan.io/tx/${signature}?cluster=devnet`);
    process.exit(1);
  }

  console.log('\n✓ tendr.sol registered on devnet');
  console.log(`  pubkey: ${tendrPubkey.toBase58()}`);
  console.log(`  tx: https://solscan.io/tx/${signature}?cluster=devnet`);

  printEnvHelp(buyer);
}

function printEnvHelp(buyer) {
  console.log('\n' + '─'.repeat(72));
  console.log('Next step: set TENDR_PARENT_OWNER_PRIVATE_KEY in apps/web/.env.local');
  console.log('─'.repeat(72));
  console.log(
    `\nCopy the following line into apps/web/.env.local (it's the contents of your`,
  );
  console.log(
    `keypair file at ${KP}, JSON-array form). The Next.js API route uses this`,
  );
  console.log(`to sign every subdomain mint:\n`);
  // Print the JSON array. This is sensitive — redirect operator's eyes
  // to the env file rather than relying on terminal scrollback.
  const secretJson = fs.readFileSync(KP, 'utf8').trim();
  console.log(`TENDR_PARENT_OWNER_PRIVATE_KEY=${secretJson}\n`);
  console.log(`Parent-owner pubkey for the record: ${buyer.publicKey.toBase58()}`);
}

main().catch((e) => {
  console.error('Errored:', e);
  process.exit(1);
});
