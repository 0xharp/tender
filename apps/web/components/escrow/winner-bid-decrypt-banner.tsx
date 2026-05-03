'use client';

/**
 * Inline banners that let the buyer or winning provider decrypt the winning
 * bid plaintext on demand, so per-milestone success criteria + scope surface
 * in the milestone-management surfaces.
 *
 * Two variants because the decrypt mechanics differ per role:
 *   - Buyer: decrypt the buyer envelope using the buyer's per-RFP X25519 key.
 *     Standard `signMessage` from the connected wallet does the derive.
 *   - Provider: decrypt the provider envelope. In PUBLIC-mode RFPs the bid
 *     signer == the connected main wallet (simple). In PRIVATE-mode RFPs the
 *     bid signer is a per-RFP ephemeral wallet (deterministically derived
 *     from the main wallet) and we need ITS signMessage to derive the X25519
 *     key. The provider banner detects mode by fetching the bid on click,
 *     comparing bid.provider to the connected wallet, and branching.
 *
 * Both banners hide themselves once the parent has the plaintext - a single
 * decrypt unlocks every milestone row + the dispute UI together.
 */
import type { Address } from '@solana/kit';
import { useSelectedWalletAccount, useSignMessage } from '@solana/react';
import { KeyRoundIcon, ShieldCheckIcon } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  type DecryptStage,
  decryptWinnerBidAsBuyer,
  decryptWinnerBidAsProvider,
} from '@/lib/bids/decrypt-winner-bid';
import { friendlyBidError, humanizeStage } from '@/lib/bids/error-utils';
import type { SealedBidPlaintext } from '@/lib/bids/schema';
import { fetchBidCommit } from '@/lib/solana/chain-reads';
import { rpc } from '@/lib/solana/client';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/* Buyer variant                                                              */
/* -------------------------------------------------------------------------- */

export interface BuyerWinnerBidDecryptBannerProps {
  rfpPda: Address;
  rfpNonceHex: string;
  winnerBidPda: Address;
  onDecrypted: (plaintext: SealedBidPlaintext) => void;
  hasPlaintext: boolean;
}

export function BuyerWinnerBidDecryptBanner(props: BuyerWinnerBidDecryptBannerProps) {
  const [account] = useSelectedWalletAccount();
  if (!account) return null;
  if (props.hasPlaintext) return null;
  return <BuyerConnected account={account.address as Address} {...props} />;
}

function BuyerConnected({
  account,
  rfpPda: _rfpPda,
  rfpNonceHex,
  winnerBidPda,
  onDecrypted,
}: BuyerWinnerBidDecryptBannerProps & { account: Address }) {
  const [accountObj] = useSelectedWalletAccount();
  // biome-ignore lint/suspicious/noExplicitAny: hook narrowing
  const signMessage = useSignMessage(accountObj as any);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<DecryptStage | null>(null);

  async function handleDecrypt() {
    setBusy(true);
    setStage(null);
    try {
      const result = await decryptWinnerBidAsBuyer({
        buyerWallet: account,
        winnerBidPda,
        rfpNonceHex,
        // biome-ignore lint/suspicious/noExplicitAny: hook return shape
        signMessage: signMessage as any,
        rpc,
        onProgress: setStage,
      });
      if (!result) {
        toast.error('Could not decrypt the winning bid', {
          description:
            'Bid envelope may be inaccessible (PER permission lapsed) or its plaintext failed schema validation.',
        });
        return;
      }
      onDecrypted(result.plaintext);
      toast.success('Acceptance bars unlocked', {
        description: 'Per-milestone success criteria + scope now visible inline.',
      });
    } catch (e) {
      toast.error('Decrypt failed', { description: friendlyBidError(e), duration: 12000 });
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  return <Banner roleLabel="buyer" busy={busy} stage={stage} onDecrypt={handleDecrypt} />;
}

/* -------------------------------------------------------------------------- */
/* Provider variant - handles public + private mode                            */
/* -------------------------------------------------------------------------- */

export interface ProviderWinnerBidDecryptBannerProps {
  /** RFP PDA - feeds the per-RFP ephemeral wallet derivation in private mode. */
  rfpPda: Address;
  /** On-chain `rfp.winner` (BidCommit PDA). */
  winnerBidPda: Address;
  onDecrypted: (plaintext: SealedBidPlaintext) => void;
  hasPlaintext: boolean;
}

export function ProviderWinnerBidDecryptBanner(props: ProviderWinnerBidDecryptBannerProps) {
  const [account] = useSelectedWalletAccount();
  if (!account) return null;
  if (props.hasPlaintext) return null;
  return <ProviderConnected mainWallet={account.address as Address} {...props} />;
}

function ProviderConnected({
  mainWallet,
  rfpPda,
  winnerBidPda,
  onDecrypted,
}: ProviderWinnerBidDecryptBannerProps & { mainWallet: Address }) {
  const [accountObj] = useSelectedWalletAccount();
  // biome-ignore lint/suspicious/noExplicitAny: hook narrowing
  const signMessage = useSignMessage(accountObj as any);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<DecryptStage | null>(null);

  /**
   * Build the right `bidSignerSignMessage` closure for this bid:
   *   - Public mode: bid.provider == mainWallet → return the connected
   *     wallet's signMessage as-is.
   *   - Private mode: bid.provider != mainWallet → derive the per-RFP
   *     ephemeral keypair (1 popup, deterministic from the main wallet sig
   *     over `deriveEphemeralBidWalletMessage(rfpPda)`), wrap its secret key
   *     in a noble-ed25519 sign closure.
   *
   * Mode detection requires a base-layer fetch of the bid - `bid.provider`
   * is the bid signer. Cheap (one RPC call) and only happens on first click.
   */
  const buildBidSignerSign = useCallback(async (): Promise<{
    bidSigner: Address;
    sign: (input: { message: Uint8Array }) => Promise<{ signature: Uint8Array }>;
  } | null> => {
    const bid = await fetchBidCommit(winnerBidPda);
    if (!bid) {
      toast.error('Could not load the winning bid from chain');
      return null;
    }
    const bidSigner = String(bid.provider) as Address;
    if (bidSigner === mainWallet) {
      // Public mode - main wallet is the signer.
      return {
        bidSigner,
        // biome-ignore lint/suspicious/noExplicitAny: signMessage hook return shape
        sign: signMessage as any,
      };
    }
    // Private mode - derive the per-RFP ephemeral keypair and wrap its
    // secret key. Same path used by submit-flow for signing bid txs.
    const { deriveEphemeralBidWalletMessage, deriveEphemeralBidKeypair } = await import(
      '@/lib/crypto/derive-ephemeral-bid-wallet'
    );
    const seedMsg = deriveEphemeralBidWalletMessage(rfpPda);
    // biome-ignore lint/suspicious/noExplicitAny: hook narrowing
    const seedSig = await (signMessage as any)({ message: seedMsg });
    const eph = await deriveEphemeralBidKeypair(seedSig.signature);
    if (eph.publicKey.toBase58() !== bidSigner) {
      toast.error('Ephemeral wallet derivation does not match the bid signer', {
        description:
          'You may be connected with a different main wallet than the one that placed this bid.',
      });
      return null;
    }
    // Wrap the ephemeral secret key in a sign closure using noble's ed25519.
    // The .js suffix on the subpath import matches @noble/curves@2.x's exports.
    // biome-ignore lint/suspicious/noExplicitAny: noble subpath types vary
    const ed = (await import('@noble/curves/ed25519.js')) as any;
    const ed25519 = ed.ed25519 ?? ed.default?.ed25519 ?? ed;
    const seed32 = eph.secretKey.slice(0, 32);
    return {
      bidSigner,
      sign: async ({ message }) => ({
        signature: new Uint8Array(ed25519.sign(message, seed32)),
      }),
    };
  }, [signMessage, mainWallet, rfpPda, winnerBidPda]);

  async function handleDecrypt() {
    setBusy(true);
    setStage(null);
    try {
      const closure = await buildBidSignerSign();
      if (!closure) return;
      const result = await decryptWinnerBidAsProvider({
        bidSignerWallet: closure.bidSigner,
        winnerBidPda,
        bidSignerSignMessage: closure.sign,
        rpc,
        onProgress: setStage,
      });
      if (!result) {
        toast.error('Could not decrypt the winning bid');
        return;
      }
      onDecrypted(result.plaintext);
      toast.success('Acceptance bars unlocked', {
        description: 'Per-milestone success criteria + scope now visible inline.',
      });
    } catch (e) {
      toast.error('Decrypt failed', { description: friendlyBidError(e), duration: 12000 });
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  return <Banner roleLabel="provider" busy={busy} stage={stage} onDecrypt={handleDecrypt} />;
}

/* -------------------------------------------------------------------------- */
/* Shared banner shell                                                         */
/* -------------------------------------------------------------------------- */

function Banner({
  roleLabel,
  busy,
  stage,
  onDecrypt,
}: {
  /** Named `roleLabel` (not `role`) so biome's a11y linter doesn't mistake it
   *  for an ARIA role. We also want the copy to differ slightly per side. */
  roleLabel: 'buyer' | 'provider';
  busy: boolean;
  stage: DecryptStage | null;
  onDecrypt: () => void;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-xl border border-dashed border-primary/30 bg-primary/5 p-3',
        'sm:flex-row sm:items-center sm:justify-between',
      )}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <ShieldCheckIcon className="size-4" />
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-foreground">Show per-milestone acceptance bars</p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            One wallet popup unlocks the success criteria + scope the{' '}
            {roleLabel === 'buyer' ? 'provider committed to' : 'you committed to'} for every
            milestone - useful when reviewing submitted work or settling a dispute. Plaintext stays
            in browser memory; nothing is sent or cached on chain.
          </p>
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        disabled={busy}
        onClick={onDecrypt}
        className="min-w-[12rem] justify-center"
      >
        <KeyRoundIcon className="size-3.5" />
        {busy ? humanizeStage(stage, 'Decrypting') : 'Decrypt acceptance bars'}
      </Button>
    </div>
  );
}
