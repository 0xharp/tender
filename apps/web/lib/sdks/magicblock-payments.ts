/**
 * MagicBlock Private Payments API client.
 *
 * Used at MILESTONE RELEASE time to send the provider's USDC privately
 * (split + delay through the TEE-validator stash). Mixes payments across
 * multiple in-flight RFPs so a competitor watching can't reconstruct
 * "this provider is currently working on RFPs X, Y, Z."
 *
 * Treasury fee collection (2.5%) routes through the same path so platform
 * revenue isn't broadcast on chain.
 */
const PAYMENTS_BASE = 'https://payments.magicblock.app';

export interface PrivateTransferRequest {
  from: string; // pubkey base58
  to: string; // pubkey base58
  mint: string;
  amount: bigint;
  splitCount?: number; // 1-15
  maxDelayMs?: number; // 0..600_000
  initIfMissing?: boolean;
  initAtasIfMissing?: boolean;
}

export interface BuiltTx {
  transactionBase64: string;
  recentBlockhash: string;
  lastValidBlockHeight: bigint;
  sendTo: 'base' | 'ephemeral';
  requiredSigners: string[];
  validator: string;
}

export async function buildPrivateTransfer(req: PrivateTransferRequest): Promise<BuiltTx> {
  const body = {
    from: req.from,
    to: req.to,
    mint: req.mint,
    amount: req.amount.toString(),
    visibility: 'private',
    fromBalance: 'base',
    toBalance: 'base',
    initIfMissing: req.initIfMissing ?? true,
    initAtasIfMissing: req.initAtasIfMissing ?? true,
    initVaultIfMissing: false,
    minDelayMs: '0',
    maxDelayMs: String(req.maxDelayMs ?? 60_000),
    split: req.splitCount ?? 8,
    cluster: 'devnet',
  };
  const r = await fetch(`${PAYMENTS_BASE}/v1/spl/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.text().catch(() => '');
    throw new Error(`MB Payments transfer build failed: ${r.status} ${err}`);
  }
  const j = await r.json();
  return {
    transactionBase64: j.transactionBase64,
    recentBlockhash: j.recentBlockhash,
    lastValidBlockHeight: BigInt(j.lastValidBlockHeight ?? 0),
    sendTo: j.sendTo,
    requiredSigners: j.requiredSigners ?? [],
    validator: j.validator,
  };
}
