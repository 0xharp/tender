'use client';

/**
 * "Show winning bid" panel — replaces the prior decrypt-only banners.
 *
 * Click → decrypt the bid plaintext → render the FULL agreement (price,
 * timeline, scope, milestone breakdown with descriptions + acceptance
 * bars + per-milestone payout amounts + delivery durations + notes).
 * The earlier inline acceptance-pill behaviour in milestone rows still
 * works as a quick reference, but the user has a clear "I decrypted, here
 * is what we agreed to" surface even when no per-milestone success
 * criteria were set (which was the silent-failure mode of the old banner
 * — decrypt succeeded but nothing visible changed).
 *
 * Two role variants:
 *   - BUYER decrypts the buyer envelope using the buyer's per-RFP X25519
 *     key (one wallet popup over the rfp_nonce).
 *   - PROVIDER decrypts the provider envelope. Public-mode bids: the bid
 *     signer IS the connected main wallet. Private-mode bids: the bid was
 *     signed by a per-RFP ephemeral wallet — we derive that locally and
 *     wrap its secret key in an ed25519 sign closure.
 *
 * Plaintext is cached in sessionStorage scoped to (viewer wallet, bid PDA)
 * so a refresh during the same tab session doesn't require another wallet
 * popup. Cache clears on tab close — we never persist bid plaintext to
 * disk.
 */
import type { Address } from '@solana/kit';
import { useSelectedWalletAccount, useSignMessage } from '@solana/react';
import { ChevronDownIcon, ChevronUpIcon, KeyRoundIcon, ShieldCheckIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
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
import { InlineMarkdown } from '@/components/ui/markdown';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/* Session-scoped plaintext cache                                              */
/* -------------------------------------------------------------------------- */

function cacheKey(viewerWallet: string, bidPda: string): string {
  return `tender:bid-plaintext:${viewerWallet}:${bidPda}`;
}

function readCache(viewerWallet: string, bidPda: string): SealedBidPlaintext | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(cacheKey(viewerWallet, bidPda));
    return raw ? (JSON.parse(raw) as SealedBidPlaintext) : null;
  } catch {
    return null;
  }
}

function writeCache(viewerWallet: string, bidPda: string, plaintext: SealedBidPlaintext): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(cacheKey(viewerWallet, bidPda), JSON.stringify(plaintext));
  } catch {
    // Quota exceeded or sessionStorage disabled - silently skip.
  }
}

/* -------------------------------------------------------------------------- */
/* Buyer variant                                                              */
/* -------------------------------------------------------------------------- */

export interface BuyerWinningBidPanelProps {
  rfpPda: Address;
  rfpNonceHex: string;
  winnerBidPda: Address;
  /** Called whenever the plaintext becomes available (initial decrypt OR
   *  cache restore). Lets the parent thread the plaintext into milestone
   *  rows for inline acceptance-bar pills. */
  onDecrypted: (plaintext: SealedBidPlaintext) => void;
  plaintext: SealedBidPlaintext | null;
}

export function BuyerWinningBidPanel(props: BuyerWinningBidPanelProps) {
  const [account] = useSelectedWalletAccount();
  if (!account) return null;
  return <BuyerInner viewerWallet={account.address} {...props} />;
}

function BuyerInner({
  viewerWallet,
  rfpPda: _rfpPda,
  rfpNonceHex,
  winnerBidPda,
  plaintext,
  onDecrypted,
}: BuyerWinningBidPanelProps & { viewerWallet: string }) {
  const [accountObj] = useSelectedWalletAccount();
  // biome-ignore lint/suspicious/noExplicitAny: signMessage hook narrowing
  const signMessage = useSignMessage(accountObj as any);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<DecryptStage | null>(null);
  const [expanded, setExpanded] = useState(true);

  // On mount, hydrate from sessionStorage if a plaintext was cached for
  // this (viewer, bid). Avoids forcing a re-decrypt on every refresh.
  useEffect(() => {
    if (plaintext) return;
    const cached = readCache(viewerWallet, winnerBidPda);
    if (cached) onDecrypted(cached);
  }, [plaintext, viewerWallet, winnerBidPda, onDecrypted]);

  async function handleDecrypt() {
    setBusy(true);
    setStage(null);
    try {
      const result = await decryptWinnerBidAsBuyer({
        buyerWallet: viewerWallet as Address,
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
      writeCache(viewerWallet, winnerBidPda, result.plaintext);
      onDecrypted(result.plaintext);
      setExpanded(true);
      toast.success('Winning bid decrypted', {
        description: 'Full bid contents (price, scope, milestone breakdown) now visible below.',
      });
    } catch (e) {
      toast.error('Decrypt failed', { description: friendlyBidError(e), duration: 12000 });
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  return (
    <Shell
      roleLabel="buyer"
      plaintext={plaintext}
      busy={busy}
      stage={stage}
      expanded={expanded}
      onToggle={() => setExpanded((e) => !e)}
      onDecrypt={handleDecrypt}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Provider variant - handles public + private mode                            */
/* -------------------------------------------------------------------------- */

export interface ProviderWinningBidPanelProps {
  rfpPda: Address;
  winnerBidPda: Address;
  onDecrypted: (plaintext: SealedBidPlaintext) => void;
  plaintext: SealedBidPlaintext | null;
}

export function ProviderWinningBidPanel(props: ProviderWinningBidPanelProps) {
  const [account] = useSelectedWalletAccount();
  if (!account) return null;
  return <ProviderInner mainWallet={account.address as Address} {...props} />;
}

function ProviderInner({
  mainWallet,
  rfpPda,
  winnerBidPda,
  plaintext,
  onDecrypted,
}: ProviderWinningBidPanelProps & { mainWallet: Address }) {
  const [accountObj] = useSelectedWalletAccount();
  // biome-ignore lint/suspicious/noExplicitAny: signMessage hook narrowing
  const signMessage = useSignMessage(accountObj as any);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<DecryptStage | null>(null);
  const [expanded, setExpanded] = useState(true);

  // Cache hydrate (same pattern as buyer)
  useEffect(() => {
    if (plaintext) return;
    const cached = readCache(mainWallet, winnerBidPda);
    if (cached) onDecrypted(cached);
  }, [plaintext, mainWallet, winnerBidPda, onDecrypted]);

  /**
   * Build the right `bidSignerSignMessage` closure for this bid:
   *   - Public mode: bid.provider == mainWallet → return the connected
   *     wallet's signMessage as-is.
   *   - Private mode: bid.provider != mainWallet → derive the per-RFP
   *     ephemeral keypair (1 popup, deterministic from the main wallet sig
   *     over `deriveEphemeralBidWalletMessage(rfpPda)`), wrap its secret
   *     key in a noble-ed25519 sign closure.
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
      return {
        bidSigner,
        // biome-ignore lint/suspicious/noExplicitAny: hook return shape
        sign: signMessage as any,
      };
    }
    const { deriveEphemeralBidWalletMessage, deriveEphemeralBidKeypair } = await import(
      '@/lib/crypto/derive-ephemeral-bid-wallet'
    );
    const seedMsg = deriveEphemeralBidWalletMessage(rfpPda);
    // biome-ignore lint/suspicious/noExplicitAny: signMessage hook narrowing
    const seedSig = await (signMessage as any)({ message: seedMsg });
    const eph = await deriveEphemeralBidKeypair(seedSig.signature);
    if (eph.publicKey.toBase58() !== bidSigner) {
      toast.error('Ephemeral wallet derivation does not match the bid signer', {
        description:
          'You may be connected with a different main wallet than the one that placed this bid.',
      });
      return null;
    }
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
      writeCache(mainWallet, winnerBidPda, result.plaintext);
      onDecrypted(result.plaintext);
      setExpanded(true);
      toast.success('Winning bid decrypted', {
        description: 'Full bid contents (price, scope, milestone breakdown) now visible below.',
      });
    } catch (e) {
      toast.error('Decrypt failed', { description: friendlyBidError(e), duration: 12000 });
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  return (
    <Shell
      roleLabel="provider"
      plaintext={plaintext}
      busy={busy}
      stage={stage}
      expanded={expanded}
      onToggle={() => setExpanded((e) => !e)}
      onDecrypt={handleDecrypt}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Shared visual shell                                                         */
/* -------------------------------------------------------------------------- */

function Shell({
  roleLabel,
  plaintext,
  busy,
  stage,
  expanded,
  onToggle,
  onDecrypt,
}: {
  /** Named `roleLabel` (not `role`) so biome's a11y linter doesn't mistake
   *  it for an ARIA role. Drives the per-side copy in the prompt. */
  roleLabel: 'buyer' | 'provider';
  plaintext: SealedBidPlaintext | null;
  busy: boolean;
  stage: DecryptStage | null;
  expanded: boolean;
  onToggle: () => void;
  onDecrypt: () => void;
}) {
  // Pre-decrypt: prompt for the one wallet sig
  if (!plaintext) {
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
            <p className="text-xs font-medium text-foreground">Show winning bid</p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              One wallet popup decrypts the agreed price, scope, milestone breakdown, and any
              acceptance criteria the {roleLabel === 'buyer' ? 'provider' : 'you'} committed to.
              Cached for this tab session — refresh-safe, never persisted to disk.
            </p>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={onDecrypt}
          className="min-w-[10rem] justify-center"
        >
          <KeyRoundIcon className="size-3.5" />
          {busy ? humanizeStage(stage, 'Decrypting') : 'Show winning bid'}
        </Button>
      </div>
    );
  }

  // Post-decrypt: full bid card with collapse toggle
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheckIcon className="size-4 text-primary" />
          <span className="font-display text-sm font-semibold">Winning bid</span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            decrypted
          </span>
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-background/60 px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
        >
          {expanded ? <ChevronUpIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
          {expanded ? 'Hide' : 'Show'}
        </button>
      </div>

      {expanded && <BidPlaintextDetails plaintext={plaintext} />}
    </div>
  );
}

function BidPlaintextDetails({ plaintext }: { plaintext: SealedBidPlaintext }) {
  return (
    <div className="flex flex-col gap-4 text-xs">
      {/* Top-line summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Price">
          <span className="font-mono text-sm text-foreground">{plaintext.priceUsdc} USDC</span>
        </Field>
        <Field label="Timeline">
          <span className="font-mono text-sm text-foreground">{plaintext.timelineDays} days</span>
        </Field>
        <Field label="Milestones">
          <span className="font-mono text-sm text-foreground">{plaintext.milestones.length}</span>
        </Field>
      </div>

      {/* Scope — full markdown render. Bid scope can be markdown (AI-drafted
          or user-typed). The provider also sees this same render in
          your-bid-panel; consistency matters since they're looking at the
          same string from two angles. */}
      <Field label="Scope">
        <InlineMarkdown source={plaintext.scope} className="flex flex-col gap-2 text-[11px]" />
      </Field>

      {/* Milestone breakdown */}
      <div className="flex flex-col gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          Milestone breakdown
        </span>
        <ol className="flex flex-col gap-2">
          {plaintext.milestones.map((m, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: milestones are positionally identified by index in the bid envelope
              key={i}
              className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-card/40 p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-display text-sm font-semibold">
                  {i + 1}. {m.name}
                </span>
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {m.amountUsdc} USDC · {m.durationDays > 0 ? `${m.durationDays}d` : 'no deadline'}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-foreground/80">
                {m.description}
              </p>
              {m.successCriteria ? (
                <div className="flex flex-col gap-0.5 rounded-md border border-primary/15 bg-primary/5 px-2.5 py-1.5">
                  <span className="font-mono text-[9px] uppercase tracking-wider text-primary/70">
                    Acceptance bar
                  </span>
                  <p className="text-[11px] leading-relaxed text-foreground/85">
                    {m.successCriteria}
                  </p>
                </div>
              ) : (
                <p className="text-[10px] italic text-muted-foreground">
                  No acceptance bar set for this milestone.
                </p>
              )}
            </li>
          ))}
        </ol>
      </div>

      {/* Notes (optional) */}
      {plaintext.notes && (
        <Field label="Notes">
          <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-foreground/85">
            {plaintext.notes}
          </p>
        </Field>
      )}

      {/* Payout destination */}
      <Field label="Payout">
        <span className="font-mono text-[11px] text-muted-foreground">
          {plaintext.payoutPreference.asset} on {plaintext.payoutPreference.chain} →{' '}
          {plaintext.payoutPreference.address.slice(0, 6)}…
          {plaintext.payoutPreference.address.slice(-6)}
        </span>
      </Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}
