'use client';

/**
 * "Claim win into public rep" CTA — surfaces on completed RFPs the user
 * won via an HD bidder ephemeral. One click flips `bid.winner_attested`
 * on chain and merges the stranded ephemeral provider rep counters into
 * the main wallet's `ProviderReputation`.
 *
 * Two-step signing flow:
 *   1. signMessage — main wallet signs the canonical bid-binding message
 *      (`tender-bid-binding-v1\nprogram=...\nrfp=...\nbid=...\nmain=...`).
 *      This is the same message format the provider's `_bidBinding`
 *      signature captures at bid-submit time, but we regenerate live to
 *      avoid having to decrypt the cached bid envelope just to read it
 *      back. Deterministic for (rfp, bid, main) — same data, same sig.
 *   2. signTransaction — main wallet signs the attest_win tx envelope
 *      containing [setComputeUnitLimit, Ed25519SigVerify(binding sig),
 *      attest_win]. The on-chain ix introspects the Ed25519 ix to verify
 *      ownership before merging eph rep into main rep.
 *
 * Mirror of `attest-rfp-button` for the buyer side, with the additional
 * Ed25519 step (provider needs to prove eph→main binding; buyer doesn't
 * because they're attesting their OWN main wallet's connection to a
 * completed RFP — no ephemeral identity in play).
 *
 * Wallet portability: signs via `useTendrSignMessage` +
 * `useTendrSignTransactions` boundary — works for any wallet
 * implementing `solana:signMessage` + `solana:signTransaction`.
 */
import { CheckIcon, LoaderCircleIcon, ShieldCheckIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { TxToastDescription } from '@/components/primitives/tx-toast';
import { Button } from '@/components/ui/button';
import { type TendrAccount, triggerActivityRefresh } from '@/lib/wallet';

interface AttestWinButtonProps {
  /** RFP PDA whose winning bid we're claiming. */
  rfpPda: string;
  /** Bid PDA — the on-chain BidCommit account that gets `winner_attested = true`. */
  bidPda: string;
  /** Already-resolved wallet handle from `useTendrAccount`. Required —
   *  this main wallet is the one claiming credit. */
  account: TendrAccount;
  /** Wallet's signMessage hook from `useTendrSignMessage` — used to sign
   *  the canonical bid-binding message. */
  signMessage: (input: { message: Uint8Array }) => Promise<{ signature: Uint8Array }>;
  /** Wallet's signTransactions hook from `useTendrSignTransactions` —
   *  used to sign the attest_win tx envelope. */
  // biome-ignore lint/suspicious/noExplicitAny: wallet-standard hook
  signTransactions: any;
  /** Optional callback after successful attestation. */
  onAttested?: () => void;
}

export function AttestWinButton({
  rfpPda,
  bidPda,
  account,
  signMessage,
  signTransactions,
  onAttested,
}: AttestWinButtonProps) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function handleAttest() {
    setBusy(true);
    try {
      // Lazy-load heavy deps — same discipline as attest-rfp-button.
      const [{ instructions, pdas }, { buildBidBindingMessage }, kit] = await Promise.all([
        import('@tender/tender-client'),
        import('@/lib/crypto/derive-ephemeral-bid-wallet'),
        import('@solana/kit'),
      ]);

      // Step 1 — main wallet signs the canonical binding message live.
      // Format must match `attest_win::build_binding_message` byte-for-byte
      // (which equals select_bid's binding message — single shared
      // construction). Triggers one wallet popup.
      const bindingMessage = buildBidBindingMessage(rfpPda, bidPda, account.address);
      const { signature: bindingSig } = await signMessage({ message: bindingMessage });
      if (bindingSig.byteLength !== 64) {
        throw new Error(`Expected 64-byte ed25519 signature, got ${bindingSig.byteLength}.`);
      }

      // Step 2 — build attest_win ix + the prepended Ed25519SigVerify ix.
      // The on-chain handler reads the instructions sysvar at
      // `current_index - 1` and verifies the Ed25519 ix matches the
      // canonical binding format with the main wallet pubkey.
      //
      // ProviderReputation PDA = `[provider_rep, <wallet>]`. Codama's
      // `findAttestWinMainRepPda` uses exactly that seed pair, so we can
      // reuse it for both the main rep (seed = main_wallet) AND the eph
      // rep (seed = bid.provider eph pubkey) — same derivation, just
      // different second seed input.
      const { fetchBidCommit } = await import('@/lib/solana/chain-reads');
      const bidChain = await fetchBidCommit(bidPda as never);
      if (!bidChain) throw new Error('Bid not found on-chain');
      const ephPubkey = String(bidChain.provider);

      const [ephRepReal] = await pdas.findAttestWinMainRepPda({
        mainWallet: ephPubkey as never,
      });
      const [mainRep] = await pdas.findAttestWinMainRepPda({
        mainWallet: account.address as never,
      });

      const mainWalletSigner = kit.createNoopSigner(account.address as never);
      const attestIx = await instructions.getAttestWinInstructionAsync({
        mainWallet: mainWalletSigner,
        bid: bidPda as never,
        rfp: rfpPda as never,
        ephemeralRep: ephRepReal,
        mainRep,
      });

      // Build the Ed25519SigVerify ix with the same byte layout the on-
      // chain `verify_binding_signature` expects. Inlined here (not
      // shared with award-fund-flow's helper) to keep this component
      // self-contained — duplicate is ~25 LoC.
      const addressEncoder = kit.getAddressEncoder();
      const pubkeyBytes = new Uint8Array(addressEncoder.encode(account.address as never));
      if (pubkeyBytes.byteLength !== 32) {
        throw new Error('main wallet pubkey did not encode to 32 bytes');
      }
      const msgSize = bindingMessage.byteLength;
      const ed25519Data = new Uint8Array(112 + msgSize);
      ed25519Data[0] = 1; // num_signatures
      ed25519Data[1] = 0; // padding
      const dataView = new DataView(ed25519Data.buffer);
      dataView.setUint16(2, 16, true); // sig_offset
      dataView.setUint16(4, 0xffff, true); // sig_ix_index = self
      dataView.setUint16(6, 80, true); // pubkey_offset
      dataView.setUint16(8, 0xffff, true); // pubkey_ix_index = self
      dataView.setUint16(10, 112, true); // msg_offset
      dataView.setUint16(12, msgSize, true); // msg_size
      dataView.setUint16(14, 0xffff, true); // msg_ix_index = self
      ed25519Data.set(bindingSig, 16);
      ed25519Data.set(pubkeyBytes, 80);
      ed25519Data.set(bindingMessage, 112);

      const ED25519_PROGRAM_ID = 'Ed25519SigVerify111111111111111111111111111';
      const ed25519Ix = {
        programAddress: ED25519_PROGRAM_ID as never,
        accounts: [] as const,
        data: ed25519Data,
      };

      // Sign-only flow — wallet signs the v0 tx envelope containing
      // [Ed25519SigVerify, attest_win].
      const { rpc } = await import('@/lib/solana/client');
      const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
      const message = kit.pipe(
        kit.createTransactionMessage({ version: 0 }),
        (m) => kit.setTransactionMessageFeePayer(account.address as never, m),
        (m) => kit.setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
        (m) => kit.appendTransactionMessageInstruction(ed25519Ix as never, m),
        (m) => kit.appendTransactionMessageInstruction(attestIx, m),
      );
      const compiled = kit.compileTransaction(message);
      const txBytes = new Uint8Array(kit.getTransactionEncoder().encode(compiled));
      const [signed] = await signTransactions({ transaction: txBytes });
      if (!signed) throw new Error('signTransactions returned no outputs');

      const b64 = kit.getBase64Decoder().decode(signed.signedTransaction);
      const sig = await rpc
        // biome-ignore lint/suspicious/noExplicitAny: kit base64 branding
        .sendTransaction(b64 as any, { encoding: 'base64', skipPreflight: true })
        .send();

      // Wait for chain confirmation BEFORE toasting success. With
      // skipPreflight=true the simulator is bypassed, so a tx can be
      // accepted by the RPC, land on chain, and STILL fail in execution
      // (most commonly: NotAttestable when the on-chain gates reject).
      // Without this confirm step we'd toast "Reputation claimed" on
      // every submission even when the tx errors — confusing the user
      // into thinking their rep updated when it didn't. confirmTransaction
      // throws with the on-chain err JSON when execution failed.
      const { confirmTransaction } = await import('@/lib/solana/confirm');
      await confirmTransaction({ rpc, signature: sig as string });

      toast.success('Reputation claimed', {
        description: <TxToastDescription hash={sig as string} prefix="claim tx" />,
        duration: 8000,
      });
      setDone(true);
      onAttested?.();
      // Refresh MyActivity so the bid's `winner_attested` flips and the
      // claim CTA disappears from the dashboard card.
      triggerActivityRefresh();
    } catch (e) {
      toast.error('Claim failed', {
        description: (e as Error).message,
        duration: 12000,
      });
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-0.5 text-[11px] text-emerald-500">
        <CheckIcon className="size-3" />
        claimed
      </span>
    );
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void handleAttest();
      }}
      disabled={busy}
      className="h-7 gap-1.5 rounded-full border-fuchsia-500/30 bg-fuchsia-500/5 px-3 text-[11px] text-fuchsia-700 hover:bg-fuchsia-500/10 dark:text-fuchsia-300"
      title="Merges this win's reputation counters into your public provider profile. The win itself stays off your public profile's awarded list and remains anonymous on chain — but the on-chain bind is permanent and discoverable via the attest transaction."
    >
      {busy ? (
        <LoaderCircleIcon className="size-3 animate-spin" />
      ) : (
        <ShieldCheckIcon className="size-3" />
      )}
      {busy ? 'Claiming…' : 'Claim reputation'}
    </Button>
  );
}
