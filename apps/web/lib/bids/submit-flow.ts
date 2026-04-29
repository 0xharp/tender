/**
 * Provider-side commit_bid orchestrator. Encrypt-to-both flow.
 *
 *   1. Sign the provider derive-key message → derive provider's X25519 keypair
 *   2. Build SealedBidPlaintext JSON from form values
 *   3. ECIES-encrypt the SAME plaintext twice:
 *      - to the buyer's RFP encryption pubkey  (commit_hash on-chain references this)
 *      - to the provider's own X25519 pubkey   (so the provider can decrypt later)
 *   4. Build commit_bid instruction via Codama (uses the buyer-ciphertext's commit_hash)
 *   5. Wallet signs + sends the transaction
 *   6. Wait for confirmation
 *   7. POST both ciphertexts + metadata to /api/bids
 *
 * Plaintext is never persisted anywhere. Decryption stays client-side only
 * for both parties.
 */
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  type Address,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  type TransactionSendingSigner,
  appendTransactionMessageInstruction,
  createTransactionMessage,
  getBase58Decoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signAndSendTransactionMessageWithSigners,
} from '@solana/kit';
import { instructions, pdas } from '@tender/tender-client';

import {
  deriveProviderKeypair,
  deriveProviderSeedMessage,
} from '@/lib/crypto/derive-provider-keypair';
import { encryptBid } from '@/lib/crypto/ecies';

import type { BidFormValues, BidPostPayload, SealedBidPlaintext } from './schema';

export type BidSubmitStage =
  | 'deriving_provider_key'
  | 'encrypting'
  | 'building_tx'
  | 'awaiting_signature'
  | 'confirming_tx'
  | 'saving_metadata';

export interface SubmitBidInput {
  rfpId: string;
  rfpPda: Address;
  buyerEncryptionPubkeyHex: string;
  values: BidFormValues;
  providerWallet: Address;
  signMessage: (input: { message: Uint8Array }) => Promise<{ signature: Uint8Array }>;
  sendingSigner: TransactionSendingSigner;
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  onProgress?: (stage: BidSubmitStage) => void;
}

export interface SubmitBidResult {
  bidPda: string;
  txSignature: string;
  commitHashHex: string;
  ephemeralPubkeyHex: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd-length hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function submitBid({
  rfpId,
  rfpPda,
  buyerEncryptionPubkeyHex,
  values,
  providerWallet,
  signMessage,
  sendingSigner,
  rpc,
  rpcSubscriptions,
  onProgress,
}: SubmitBidInput): Promise<SubmitBidResult> {
  // Step 1 — derive provider's own X25519 keypair so they can decrypt their bid back
  onProgress?.('deriving_provider_key');
  const providerSeedMsg = deriveProviderSeedMessage();
  const { signature: providerSig } = await signMessage({ message: providerSeedMsg });
  const providerKp = deriveProviderKeypair(providerSig);

  // Step 2 — encrypt the bid TWICE: once to buyer pub, once to provider pub
  onProgress?.('encrypting');
  const plaintext: SealedBidPlaintext = {
    priceUsdc: values.price_usdc,
    scope: values.scope,
    timelineDays: values.timeline_days,
    milestones: values.milestones.map((m) => ({
      name: m.name,
      description: m.description,
      amountUsdc: m.amount_usdc,
    })),
    payoutPreference: {
      chain: 'solana',
      asset: 'USDC',
      address: values.payout_address,
    },
    notes: values.notes,
  };

  const plaintextBytes = new TextEncoder().encode(JSON.stringify(plaintext));
  const buyerPub = hexToBytes(buyerEncryptionPubkeyHex);
  const sealedForBuyer = encryptBid(plaintextBytes, buyerPub);
  const sealedForProvider = encryptBid(plaintextBytes, providerKp.x25519PublicKey);

  // Step 3 — find Bid PDA + build instruction (uses buyer commit_hash on-chain)
  onProgress?.('building_tx');
  const [bidPda] = await pdas.findBidPda({ rfp: rfpPda, provider: providerWallet });

  const ix = await instructions.getCommitBidInstructionAsync({
    provider: sendingSigner,
    rfp: rfpPda,
    bid: bidPda,
    commitHash: sealedForBuyer.commitHash,
    ciphertextStorageUri: `supabase://bid_ciphertexts/${bidPda}`,
  });

  // Step 4 — sign + send via wallet
  onProgress?.('awaiting_signature');
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(sendingSigner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstruction(ix, m),
  );

  const signatureBytes = await signAndSendTransactionMessageWithSigners(message);
  const txSignature = getBase58Decoder().decode(signatureBytes);

  // Step 5 — confirm
  onProgress?.('confirming_tx');
  await waitForSignatureConfirmed({ rpc, signature: txSignature });
  void rpcSubscriptions;

  // Step 6 — POST both ciphertexts
  onProgress?.('saving_metadata');
  const payload: BidPostPayload = {
    rfp_id: rfpId,
    rfp_pda: rfpPda,
    on_chain_pda: bidPda,
    ephemeral_pubkey_hex: bytesToHex(sealedForBuyer.ephemeralPub),
    commit_hash_hex: bytesToHex(sealedForBuyer.commitHash),
    ciphertext_base64: bytesToBase64(sealedForBuyer.blob),
    provider_ephemeral_pubkey_hex: bytesToHex(sealedForProvider.ephemeralPub),
    provider_ciphertext_base64: bytesToBase64(sealedForProvider.blob),
    storage_backend: 'supabase',
  };

  const res = await fetch('/api/bids', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      `commit_bid landed on-chain but ciphertext POST failed: ${
        body.error ?? `HTTP ${res.status}`
      }. tx: ${txSignature}, bid: ${bidPda}`,
    );
  }

  return {
    bidPda,
    txSignature,
    commitHashHex: payload.commit_hash_hex,
    ephemeralPubkeyHex: payload.ephemeral_pubkey_hex,
  };
}

async function waitForSignatureConfirmed({
  rpc,
  signature,
  timeoutMs = 60_000,
  pollIntervalMs = 1_000,
}: {
  rpc: Rpc<SolanaRpcApi>;
  signature: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await rpc
      // biome-ignore lint/suspicious/noExplicitAny: kit signature type expects Signature branded string
      .getSignatureStatuses([signature as any])
      .send();
    const status = value[0];
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      if (status.err) {
        throw new Error(`tx failed: ${JSON.stringify(status.err)}`);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`timed out waiting for ${signature} to confirm`);
}
