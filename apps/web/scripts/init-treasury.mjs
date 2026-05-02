#!/usr/bin/env node
// One-time setup: initialize the platform Treasury PDA + USDC ATA on devnet.
// Run once after a fresh program deploy. Idempotent-ish — re-running fails
// with `account already in use`, which is harmless.
//
// Usage:
//   node apps/web/scripts/init-treasury.mjs
//
// Env:
//   SOLANA_RPC_URL  — defaults to Helius devnet
//   KEYPAIR_PATH    — defaults to ~/.config/solana/id.json (becomes the
//                     treasury authority — stored on the Treasury PDA)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

const TENDER_PROGRAM_ID = new PublicKey('4RSbGBZQ7CDSv78DG3VoMcaKXBsoYvh9ZofEo6mTCvfQ');
// Circle's devnet USDC mint — same one MagicBlock Private Payments defaults to.
const DEVNET_USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

const RPC =
  process.env.SOLANA_RPC_URL ??
  'https://devnet.helius-rpc.com/?api-key=76d43e92-9e70-4cae-b442-0f17b9ad4dba';
const KP = process.env.KEYPAIR_PATH ?? path.join(process.env.HOME, '.config/solana/id.json');

function loadKeypair(p) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, 'utf8'))));
}

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const payer = loadKeypair(KP);
  console.log('Payer / authority:', payer.publicKey.toBase58());

  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('treasury')],
    TENDER_PROGRAM_ID,
  );
  console.log('Treasury PDA:', treasuryPda.toBase58());

  const treasuryAta = getAssociatedTokenAddressSync(
    DEVNET_USDC_MINT,
    treasuryPda,
    true, // allow owner-off-curve PDAs
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  console.log('Treasury ATA:', treasuryAta.toBase58());

  // Hand-rolled init_treasury ix. Discriminator: first 8 bytes of
  // sha256("global:init_treasury"). Authority pubkey passed as the only arg.
  const discriminator = Buffer.from([
    // sha256("global:init_treasury")[0..8] — computed once and pinned.
    // (Anchor: Sha256("global:" + ix_name)[0..8])
    0x7c, 0xa5, 0x0d, 0xc9, 0xa5, 0xe1, 0xfa, 0x3e,
  ]);
  // Actually, let's compute it at runtime to be safe:
  const { createHash } = await import('node:crypto');
  const computedDisc = createHash('sha256').update('global:init_treasury').digest().subarray(0, 8);
  const authorityBytes = payer.publicKey.toBytes();
  const data = Buffer.concat([Buffer.from(computedDisc), Buffer.from(authorityBytes)]);
  void discriminator;

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true }, // payer
      { pubkey: treasuryPda, isSigner: false, isWritable: true }, // treasury
      { pubkey: DEVNET_USDC_MINT, isSigner: false, isWritable: false }, // mint
      { pubkey: treasuryAta, isSigner: false, isWritable: true }, // treasury_ata
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: TENDER_PROGRAM_ID,
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.sign(payer);

  try {
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    console.log('Sent:', sig);
    await conn.confirmTransaction(sig, 'confirmed');
    console.log('✅ Treasury initialized.');
    console.log(`   https://solscan.io/tx/${sig}?cluster=devnet`);
  } catch (e) {
    if (String(e).includes('already in use')) {
      console.log('✅ Treasury already initialized — safe to ignore.');
    } else {
      console.error('❌ Failed:', e);
      process.exit(1);
    }
  }
}

void fileURLToPath;
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
