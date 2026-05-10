'use client';

/**
 * "Claim reputation" CTA — surfaces on completed private-buyer RFPs
 * inside the dashboard buying tab. Two-step flow (mirrors the provider
 * `attest_win` pattern):
 *
 *   1. signMessage — buyer's main wallet signs the canonical buyer-eph
 *      binding message naming `rfp.buyer` (the ephemeral). Live sign at
 *      click time; no cached signatures (cleaner than envelope-baked
 *      bindings, avoids stale-key replay across program upgrades).
 *   2. signTransactions — same main wallet signs the attest tx envelope
 *      containing [Ed25519SigVerify, attest_buyer_history]. The on-chain
 *      ix introspects the Ed25519 ix and rejects if it doesn't bind
 *      this main wallet to this RFP's eph.
 *
 * Without (1)+(2) the on-chain ix cannot prove ownership and would
 * accept any main wallet's claim — letting an observer race-claim a
 * stranger's private RFP rep. Symmetric with attest_win.
 *
 * Wallet portability: signs via the wallet-lib boundary, not any
 * Phantom-specific API. Works for any wallet implementing
 * `solana:signMessage` + `solana:signTransaction`.
 */
import { CheckIcon, LoaderCircleIcon, ShieldCheckIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { TxToastDescription } from '@/components/primitives/tx-toast';
import { Button } from '@/components/ui/button';
import { type TendrAccount, triggerActivityRefresh } from '@/lib/wallet';

interface AttestRfpButtonProps {
  rfpPda: string;
  /** Already-resolved wallet handle from `useTendrAccount`. Required. */
  account: TendrAccount;
  /** Wallet's signMessage hook from `useTendrSignMessage` — used to sign
   *  the canonical buyer-eph binding message live at claim time. */
  signMessage: (input: { message: Uint8Array }) => Promise<{ signature: Uint8Array }>;
  /** Wallet's signTransactions hook from `useTendrSignTransactions`. */
  // biome-ignore lint/suspicious/noExplicitAny: wallet-standard hook
  signTransactions: any;
  /** Optional callback after successful attestation (e.g. to refresh
   *  the parent list so the row re-renders with `attested` = true). */
  onAttested?: () => void;
}

export function AttestRfpButton({
  rfpPda,
  account,
  signMessage,
  signTransactions,
  onAttested,
}: AttestRfpButtonProps) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function handleAttest() {
    setBusy(true);
    try {
      // Lazy-load all heavy deps — keep the tender-client + kit chunks
      // off the discover-list cold path until the user actually clicks.
      const [{ instructions, pdas }, { fetchRfp }, { buildBuyerEphBindingMessage }, kit] =
        await Promise.all([
          import('@tender/tender-client'),
          import('@/lib/solana/chain-reads'),
          import('@/lib/crypto/derive-ephemeral-bid-wallet'),
          import('@solana/kit'),
        ]);

      // Resolve ephemeral pubkey live from the on-chain rfp.buyer field
      // (rather than re-deriving via keychain) — saves a master sign and
      // avoids depending on which device's localStorage has what cached.
      const chainRfp = await fetchRfp(rfpPda as never);
      if (!chainRfp) throw new Error('RFP not found on-chain');
      const buyerEphPubkey = String(chainRfp.buyer);

      // Step 1 — main wallet signs the canonical buyer-eph binding
      // message. Format must match
      // `attest_buyer_history::build_buyer_eph_binding_message` byte-
      // for-byte. Triggers wallet popup #1.
      const bindingMessage = buildBuyerEphBindingMessage(
        rfpPda,
        account.address as string,
        buyerEphPubkey,
      );
      const { signature: bindingSig } = await signMessage({ message: bindingMessage });
      if (bindingSig.byteLength !== 64) {
        throw new Error(`Expected 64-byte ed25519 signature, got ${bindingSig.byteLength}.`);
      }

      const [ephemeralRep] = await pdas.findBuyerReputationPda({ buyer: chainRfp.buyer });
      const [mainRep] = await pdas.findMainRepPda({ mainWallet: account.address as never });

      const mainWalletSigner = kit.createNoopSigner(account.address as never);
      const attestIx = await instructions.getAttestBuyerHistoryInstructionAsync({
        mainWallet: mainWalletSigner,
        rfp: rfpPda as never,
        ephemeralRep,
        mainRep,
      });

      // Step 2 — build the Ed25519SigVerify ix with the byte layout
      // the on-chain `verify_buyer_eph_binding_signature` expects.
      // Inlined here (not shared with award-fund-flow's helper) to keep
      // this component self-contained — duplicate is ~25 LoC.
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
      // [Ed25519SigVerify, attest_buyer_history]. Triggers wallet popup #2.
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

      // Wait for chain confirmation BEFORE toasting success — same
      // rationale as attest-win-button. With skipPreflight=true the
      // RPC accepts + propagates the tx envelope, but the tx can still
      // revert in execution (e.g. NotAttestable, AlreadyAttested).
      // confirmTransaction throws with the on-chain err JSON when
      // execution failed, which the catch below surfaces as a toast.
      const { confirmTransaction } = await import('@/lib/solana/confirm');
      await confirmTransaction({ rpc, signature: sig as string });

      toast.success('Reputation claimed', {
        description: <TxToastDescription hash={sig as string} prefix="claim tx" />,
        duration: 8000,
      });
      setDone(true);
      onAttested?.();
      // Refresh MyActivity so the buyer-attested flag flips to true
      // in the central feed (drives the "attested" pill on /me/projects
      // HD-private list + buyer profile).
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
        attested
      </span>
    );
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={(e) => {
        // Stop the parent <Link> from intercepting the click.
        e.preventDefault();
        e.stopPropagation();
        void handleAttest();
      }}
      disabled={busy}
      className="h-7 gap-1.5 rounded-full px-3 text-[11px]"
      title="Merges this RFP's reputation counters into your public buyer profile. The RFP itself stays off your public profile's RFP list and remains anonymous on chain — but the on-chain bind is permanent and discoverable via the attest transaction."
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
