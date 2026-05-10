'use client';

/**
 * EphemeralManager — the user's HD-ephemeral control surface, lives at
 * /me/ephemerals. For each ephemeral discovered by MyActivityProvider:
 *  - shows SOL + USDC balances (no dust filter — even 0-balance rows
 *    surface so the user can confirm what's been used)
 *  - lets the user sweep SOL or USDC back to their main wallet via
 *    Cloak's shielded pool (cryptographic unlinkability preserved)
 *  - lets the user top-up SOL or USDC into the ephemeral, also via
 *    Cloak. Same private path the bid composer uses inline.
 *
 * Sweep low balances are NOT hidden — instead we surface a tooltip
 * explaining that the sweep tx fees may exceed the recoverable amount
 * for very small balances, and let the user proceed anyway if they
 * want to clean up.
 *
 * Privacy properties:
 *  - Sweep: ephemeral → Cloak shielded pool → main. The on-chain trail
 *    is broken; observers cannot link the ephemeral to the main wallet.
 *  - Top-up: same path in reverse; main → Cloak → ephemeral.
 */

import { LoaderCircleIcon, WalletIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { HashLink } from '@/components/primitives/hash-link';
import { TxToastDescription } from '@/components/primitives/tx-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { stripSolanaClientHeaderMiddleware } from '@/lib/solana/client';
import {
  type KeychainHandle,
  type MyEphemeral,
  buildCloakSignTransactionAdapter,
  useKeychainContext,
  useMyActivity,
  useTendrAccount,
  useTendrSignMessage,
  useTendrSignTransactions,
} from '@/lib/wallet';

/** Cloak devnet mock USDC mint. One-line swap to Circle mainnet
 *  (`EPjFWdd5...`) for production. */
const DEVNET_USDC_MINT = '61ro7AExqfk4dZYoCyRzTahahCC2TdUUZ4M5epMPunJf' as const;

/** Reserve floor: keep this much SOL on the ephemeral after a SOL
 *  sweep so the ephemeral can still pay tx fees for any pending
 *  sweep/withdraw flows. Same heuristic the legacy panel used. */
const SOL_SWEEP_RESERVE_LAMPORTS = 10_000_000n; // 0.01 SOL

/** Default top-up amounts. SOL covers Cloak fee + ALT setup + a
 *  follow-on bid/RFP submission with comfortable headroom. USDC
 *  default is small ($1) — user can rerun for larger amounts. */
const DEFAULT_TOPUP_LAMPORTS = 60_000_000n; // 0.06 SOL
const DEFAULT_TOPUP_MICRO_USDC = 1_000_000n; // $1

interface Row extends MyEphemeral {
  solLamports: bigint;
  usdcMicroUsdc: bigint;
  /** True while we're refetching this row's balances. */
  refreshing: boolean;
}

type ActionKey = `${string}:${'sweep_sol' | 'sweep_usdc' | 'topup_sol' | 'topup_usdc'}`;

export function EphemeralManager() {
  const account = useTendrAccount();
  const keychain = useKeychainContext();
  if (!account || !keychain) return null;
  return <Inner account={account} keychain={keychain} />;
}

function Inner({
  account,
  keychain,
}: {
  account: import('@/lib/wallet').TendrAccount;
  keychain: KeychainHandle;
}) {
  const activity = useMyActivity();
  const signTransactions = useTendrSignTransactions(account);
  const signMessageHook = useTendrSignMessage(account);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<ActionKey | null>(null);

  // Auto-load balances when MyActivity surfaces ephemerals. Re-fetch
  // when the ephemerals list itself changes (new RFP / new bid).
  //
  // Important: we only flip rows from null → [] (the "settled empty"
  // state) once the keychain is actually unlocked. If keychain is
  // still locked, ephemerals will be [] regardless (HD enumerate
  // skipped). Pretending that's "no ephemerals" would be wrong — the
  // user has them, we just haven't unlocked yet. Keep rows=null so
  // the skeleton stays up; once keychain unlocks, MyActivity re-runs,
  // ephemerals populates (or doesn't), and this effect re-fires.
  useEffect(() => {
    if (!activity.isReady) return;
    if (activity.ephemerals.length === 0) {
      if (keychain.isUnlocked) {
        // Keychain unlocked, enumerate completed, no HD ephemerals
        // exist — genuine empty.
        setRows([]);
      }
      // Keychain locked → stay null → skeleton.
      return;
    }
    void fetchAllBalances(activity.ephemerals);
  }, [activity.isReady, activity.ephemerals, keychain.isUnlocked]);

  async function fetchAllBalances(ephemerals: MyEphemeral[]) {
    setLoading(true);
    try {
      const { Connection, PublicKey } = await import('@solana/web3.js');
      const splToken = await import('@solana/spl-token');
      const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
      const connection = new Connection(rpcUrl, 'confirmed');
      const usdcMint = new PublicKey(DEVNET_USDC_MINT);

      // Dedupe by pubkey (defensive — HKDF outputs across roles
      // shouldn't collide, but a stray dupe shouldn't double-render).
      const uniq = Array.from(new Map(ephemerals.map((e) => [e.pubkey, e])).values());

      const enriched: Row[] = await Promise.all(
        uniq.map(async (c) => {
          const pk = new PublicKey(c.pubkey);
          const [solLamports, usdcMicroUsdc] = await Promise.all([
            connection.getBalance(pk).then((n) => BigInt(n)),
            (async () => {
              try {
                const ata = await splToken.getAssociatedTokenAddress(usdcMint, pk, false);
                const acct = await connection.getTokenAccountBalance(ata);
                return BigInt(acct.value.amount);
              } catch {
                return 0n;
              }
            })(),
          ]);
          return {
            ...c,
            solLamports,
            usdcMicroUsdc,
            refreshing: false,
          };
        }),
      );
      // Stable sort: by role then by index. Keeps the list visually
      // consistent across refreshes.
      enriched.sort((a, b) => {
        if (a.role !== b.role) return a.role < b.role ? -1 : 1;
        return a.index - b.index;
      });
      setRows(enriched);
    } catch (e) {
      toast.error('Could not load ephemeral balances', {
        description: (e as Error).message,
      });
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  async function refreshOne(pubkey: string) {
    setRows((current) => {
      if (!current) return current;
      return current.map((r) => (r.pubkey === pubkey ? { ...r, refreshing: true } : r));
    });
    try {
      const { Connection, PublicKey } = await import('@solana/web3.js');
      const splToken = await import('@solana/spl-token');
      const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
      const connection = new Connection(rpcUrl, 'confirmed');
      const usdcMint = new PublicKey(DEVNET_USDC_MINT);
      const pk = new PublicKey(pubkey);
      const [solLamports, usdcMicroUsdc] = await Promise.all([
        connection.getBalance(pk).then((n) => BigInt(n)),
        (async () => {
          try {
            const ata = await splToken.getAssociatedTokenAddress(usdcMint, pk, false);
            const acct = await connection.getTokenAccountBalance(ata);
            return BigInt(acct.value.amount);
          } catch {
            return 0n;
          }
        })(),
      ]);
      setRows((current) => {
        if (!current) return current;
        return current.map((r) =>
          r.pubkey === pubkey ? { ...r, solLamports, usdcMicroUsdc, refreshing: false } : r,
        );
      });
    } catch {
      setRows((current) => {
        if (!current) return current;
        return current.map((r) => (r.pubkey === pubkey ? { ...r, refreshing: false } : r));
      });
    }
  }

  async function deriveEphemeral(role: 'buyer' | 'bidder', index: number) {
    return role === 'buyer'
      ? await keychain.buyerEphemeral(index)
      : await keychain.bidderEphemeral(index);
  }

  // ---- Sweep SOL ---------------------------------------------------------
  async function handleSweepSol(row: Row) {
    const key: ActionKey = `${row.pubkey}:sweep_sol`;
    setBusy(key);
    try {
      const eph = await deriveEphemeral(row.role, row.index);
      if (eph.publicKey.toBase58() !== row.pubkey) {
        throw new Error('Derived ephemeral pubkey mismatch — keychain inconsistency');
      }
      const sweepLamports = row.solLamports - SOL_SWEEP_RESERVE_LAMPORTS;
      if (sweepLamports <= 0n) {
        toast.warning('Balance below fee floor', {
          description: 'Need ~0.01 SOL above the sweep amount to cover Cloak deposit + ALT fees.',
        });
        return;
      }
      const [{ Connection, PublicKey }, { sweepEphemeralToDestination }] = await Promise.all([
        import('@solana/web3.js'),
        import('@/lib/sdks/cloak'),
      ]);
      const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
      const connection = new Connection(rpcUrl, 'confirmed');
      const result = await sweepEphemeralToDestination({
        ephemeralKeypair: eph,
        destinationPubkey: new PublicKey(account.address),
        sweepLamports,
        connection,
      });
      toast.success(`Swept ${formatSol(sweepLamports)} SOL → main`, {
        description: <TxToastDescription hash={result.withdrawSig} prefix="Withdraw tx" />,
      });
      await refreshOne(row.pubkey);
    } catch (e) {
      toast.error('SOL sweep failed', { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  // ---- Sweep USDC --------------------------------------------------------
  async function handleSweepUsdc(row: Row) {
    const key: ActionKey = `${row.pubkey}:sweep_usdc`;
    setBusy(key);
    try {
      // Pre-flight: ephemeral needs SOL for ALT setup + deposit fees.
      if (row.solLamports < 5_000_000n) {
        toast.warning('Not enough SOL for the sweep tx fees', {
          description: 'Top up ~0.005 SOL to this ephemeral first, then retry the USDC sweep.',
        });
        return;
      }
      if (row.usdcMicroUsdc <= 0n) {
        toast.info('No USDC to sweep on this ephemeral.');
        return;
      }
      const eph = await deriveEphemeral(row.role, row.index);
      if (eph.publicKey.toBase58() !== row.pubkey) {
        throw new Error('Derived ephemeral pubkey mismatch — keychain inconsistency');
      }
      const [{ Connection, PublicKey }, { sweepEphemeralUsdcToDestination }] = await Promise.all([
        import('@solana/web3.js'),
        import('@/lib/sdks/cloak'),
      ]);
      const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
      const connection = new Connection(rpcUrl, 'confirmed');
      const result = await sweepEphemeralUsdcToDestination({
        ephemeralKeypair: eph,
        destinationPubkey: new PublicKey(account.address),
        sweepMicroUsdc: row.usdcMicroUsdc,
        mint: new PublicKey(DEVNET_USDC_MINT),
        connection,
      });
      toast.success(`Swept ${formatUsdc(row.usdcMicroUsdc)} USDC → main`, {
        description: <TxToastDescription hash={result.withdrawSig} prefix="Withdraw tx" />,
      });
      await refreshOne(row.pubkey);
    } catch (e) {
      toast.error('USDC sweep failed', { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  // ---- Top-up SOL --------------------------------------------------------
  async function handleTopUpSol(row: Row) {
    const key: ActionKey = `${row.pubkey}:topup_sol`;
    setBusy(key);
    try {
      const [{ fundEphemeralWallet }, { Connection, PublicKey }] = await Promise.all([
        import('@/lib/sdks/cloak'),
        import('@solana/web3.js'),
      ]);
      const signTxAdapter = await buildCloakSignTransactionAdapter(signTransactions);
      const signMessageProp = async (msg: Uint8Array): Promise<Uint8Array> => {
        const { signature } = await signMessageHook({ message: msg });
        return signature;
      };
      const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
      const result = await fundEphemeralWallet({
        walletPublicKey: new PublicKey(account.address),
        signTransaction: signTxAdapter,
        signMessage: signMessageProp,
        ephemeralPubkey: new PublicKey(row.pubkey),
        depositLamports: DEFAULT_TOPUP_LAMPORTS,
        connection: new Connection(rpcUrl, {
          commitment: 'confirmed',
          // biome-ignore lint/suspicious/noExplicitAny: web3.js FetchMiddleware type
          fetchMiddleware: stripSolanaClientHeaderMiddleware as any,
        }),
      });
      toast.success(`Topped up ${formatSol(DEFAULT_TOPUP_LAMPORTS)} SOL`, {
        description: <TxToastDescription hash={result.withdrawSig} prefix="Withdraw tx" />,
      });
      await refreshOne(row.pubkey);
    } catch (e) {
      toast.error('SOL top-up failed', { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  // ---- Top-up USDC -------------------------------------------------------
  async function handleTopUpUsdc(row: Row) {
    const key: ActionKey = `${row.pubkey}:topup_usdc`;
    setBusy(key);
    try {
      const [{ fundEphemeralUsdcAta }, { Connection, PublicKey }] = await Promise.all([
        import('@/lib/sdks/cloak'),
        import('@solana/web3.js'),
      ]);
      const signTxAdapter = await buildCloakSignTransactionAdapter(signTransactions);
      const signMessageProp = async (msg: Uint8Array): Promise<Uint8Array> => {
        const { signature } = await signMessageHook({ message: msg });
        return signature;
      };
      const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
      const result = await fundEphemeralUsdcAta({
        walletPublicKey: new PublicKey(account.address),
        signTransaction: signTxAdapter,
        signMessage: signMessageProp,
        ephemeralPubkey: new PublicKey(row.pubkey),
        depositMicroUsdc: DEFAULT_TOPUP_MICRO_USDC,
        mint: new PublicKey(DEVNET_USDC_MINT),
        connection: new Connection(rpcUrl, {
          commitment: 'confirmed',
          // biome-ignore lint/suspicious/noExplicitAny: web3.js FetchMiddleware type
          fetchMiddleware: stripSolanaClientHeaderMiddleware as any,
        }),
      });
      toast.success(`Topped up ${formatUsdc(DEFAULT_TOPUP_MICRO_USDC)} USDC`, {
        description: <TxToastDescription hash={result.withdrawSig} prefix="Withdraw tx" />,
      });
      await refreshOne(row.pubkey);
    } catch (e) {
      toast.error('USDC top-up failed', { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  // ---- Render ------------------------------------------------------------
  // Three settling phases the user can land on:
  //   1. activity not yet enumerated, or keychain not yet unlocked
  //      (auto-prewarm in flight) → render a skeleton so we don't
  //      flash "no ephemerals" before the data lands.
  //   2. activity enumerated but balance fetch in flight → row count
  //      is null briefly. Same skeleton.
  //   3. settled empty (keychain unlocked, enumerate done, zero
  //      ephemerals): render the empty card.
  // Empty state ONLY when truly settled — keychain unlocked, enumerate
  // ran, balance fetch is done, and we ended up with zero rows. Anything
  // else is "still settling" and gets a skeleton. This prevents the
  // brief "No ephemerals yet" flash before the data lands.
  //
  // `!activity.isLoading` is load-bearing here: when the keychain unlocks,
  // MyActivityProvider re-fires its enumerate (because the keychain
  // handle's identity changes). Without this gate, the brief window
  // between "keychain.isUnlocked flips true" and "MyActivity has actually
  // re-enumerated with HD merged in" satisfies the other conditions —
  // ephemerals is still the pre-unlock empty array, rows transitions to
  // [], and we'd flash "No ephemerals yet" for one frame even when the
  // user has live HD ephemerals on chain.
  const settledEmpty =
    activity.isReady &&
    !activity.isLoading &&
    keychain.isUnlocked &&
    !loading &&
    rows !== null &&
    rows.length === 0;
  const settledData = rows !== null && rows.length > 0;

  if (!settledEmpty && !settledData) {
    return (
      <Card className="border-border/60">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <WalletIcon className="size-4 text-muted-foreground" />
            My Ephemeral Wallets
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton />
        </CardContent>
      </Card>
    );
  }

  if (settledEmpty) {
    return (
      <Card className="border-border/60">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <WalletIcon className="size-4 text-muted-foreground" />
            My Ephemeral Wallets
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-xl border border-dashed border-border/60 bg-card/40 p-6 text-center">
            <p className="text-sm font-medium">No ephemerals yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Create a private RFP or place a private bid — every private flow uses a fresh HD
              ephemeral that surfaces here once active.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const totalSol = rows.reduce((acc, r) => acc + r.solLamports, 0n);
  const totalUsdc = rows.reduce((acc, r) => acc + r.usdcMicroUsdc, 0n);

  return (
    <Card className="border-primary/30 bg-primary/[0.02]">
      <CardHeader className="flex flex-row items-baseline justify-between gap-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <WalletIcon className="size-4 text-primary" />
          My Ephemeral Wallets
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            ({rows.length})
          </span>
          {loading && <LoaderCircleIcon className="size-3 animate-spin text-muted-foreground" />}
        </CardTitle>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          hd-keychain · cloak shielded
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 rounded-xl border border-border/60 bg-card/40 p-3">
          <Stat label="Total SOL" value={formatSol(totalSol)} hint="across all ephemerals" />
          <Stat label="Total USDC" value={formatUsdc(totalUsdc)} hint="across all ephemerals" />
        </div>

        {/* Latency note: Cloak's shielded UTXO pool is what makes sweeps +
            top-ups privacy-preserving (no on-chain link from this
            ephemeral back to the user's main wallet), but the deposit →
            shielded → withdraw round trip takes meaningfully longer than
            a direct transfer. Without this hint, users hit the action,
            see the toast clear, watch the balance not move for a while,
            and assume something failed. */}
        <p className="rounded-md border border-fuchsia-500/20 bg-fuchsia-500/[0.04] px-3 py-2 text-[11px] leading-relaxed text-foreground/80">
          <span className="font-medium text-fuchsia-700 dark:text-fuchsia-300">
            Sweeps and top-ups route through Cloak&rsquo;s shielded UTXO pool
          </span>{' '}
          to keep your main wallet unlinkable from these ephemerals on chain. Each operation can
          take up to 90 seconds to settle end-to-end &mdash; balances above will refresh once Cloak
          completes the shielded withdraw.
        </p>

        <ul className="flex flex-col divide-y divide-border/40 rounded-xl border border-border/60">
          {rows.map((r) => {
            const lowSol = r.solLamports < 5_000_000n;
            return (
              <li key={r.pubkey} className="flex flex-col gap-3 px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span className="font-mono uppercase tracking-wider text-primary">{r.role}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    slot #{r.index}
                  </span>
                  <span>·</span>
                  <HashLink hash={r.pubkey} kind="account" visibleChars={6} linkable />
                  <span>·</span>
                  <span className="text-muted-foreground">
                    rfp{' '}
                    <Link
                      href={`/rfps/${r.rfpPda}`}
                      className="font-mono text-foreground transition-colors hover:text-primary hover:underline"
                      title="Open this RFP"
                    >
                      {r.rfpPda.slice(0, 4)}…{r.rfpPda.slice(-4)}
                    </Link>
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <BalanceCell
                    label="SOL"
                    value={formatSol(r.solLamports)}
                    note={lowSol ? 'low balance — sweep fees may exceed amount' : undefined}
                    sweepLabel="Sweep SOL"
                    topUpLabel="Top up SOL"
                    busySweep={busy === `${r.pubkey}:sweep_sol`}
                    busyTopUp={busy === `${r.pubkey}:topup_sol`}
                    onSweep={() => handleSweepSol(r)}
                    onTopUp={() => handleTopUpSol(r)}
                    sweepDisabled={busy !== null}
                    topUpDisabled={busy !== null}
                  />
                  <BalanceCell
                    label="USDC"
                    value={formatUsdc(r.usdcMicroUsdc)}
                    note={
                      r.solLamports < 5_000_000n
                        ? 'needs ~0.005 SOL on this ephemeral for the sweep tx fees'
                        : undefined
                    }
                    sweepLabel="Sweep USDC"
                    topUpLabel="Top up USDC"
                    busySweep={busy === `${r.pubkey}:sweep_usdc`}
                    busyTopUp={busy === `${r.pubkey}:topup_usdc`}
                    onSweep={() => handleSweepUsdc(r)}
                    onTopUp={() => handleTopUpUsdc(r)}
                    sweepDisabled={busy !== null || r.usdcMicroUsdc <= 0n}
                    topUpDisabled={busy !== null}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="font-mono text-2xl font-semibold tabular-nums">{value}</span>
      {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

function BalanceCell({
  label,
  value,
  note,
  sweepLabel,
  topUpLabel,
  busySweep,
  busyTopUp,
  onSweep,
  onTopUp,
  sweepDisabled,
  topUpDisabled,
}: {
  label: string;
  value: string;
  note?: string;
  sweepLabel: string;
  topUpLabel: string;
  busySweep: boolean;
  busyTopUp: boolean;
  onSweep: () => void;
  onTopUp: () => void;
  sweepDisabled: boolean;
  topUpDisabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-card/30 p-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span className="font-mono text-base font-semibold tabular-nums">{value}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onSweep}
          disabled={sweepDisabled}
          className="h-7 gap-1.5 rounded-full px-3 text-[11px]"
          title={`Sweep ${label} back to your main wallet via Cloak's shielded pool.`}
        >
          {busySweep && <LoaderCircleIcon className="size-3 animate-spin" />}
          {busySweep ? 'Sweeping…' : sweepLabel}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onTopUp}
          disabled={topUpDisabled}
          className="h-7 gap-1.5 rounded-full px-3 text-[11px]"
          title={`Top up ${label} from your main wallet via Cloak's shielded pool.`}
        >
          {busyTopUp && <LoaderCircleIcon className="size-3 animate-spin" />}
          {busyTopUp ? 'Topping up…' : topUpLabel}
        </Button>
      </div>
      {note && <span className="text-[10px] text-amber-600 dark:text-amber-400">{note}</span>}
    </div>
  );
}

function Skeleton() {
  // Three shimmer rows roughly the height of a real row, so the page
  // height doesn't snap when real data lands. Pulse animation only —
  // no spinner, no copy, so it's clear this is a placeholder rather
  // than a "no data" empty state.
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="h-16 animate-pulse rounded-xl bg-muted/40" />
        <div className="h-16 animate-pulse rounded-xl bg-muted/40" />
      </div>
      <div className="flex flex-col divide-y divide-border/40 rounded-xl border border-border/60">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-2 px-4 py-3">
            <div className="h-3 w-1/3 animate-pulse rounded bg-muted/40" />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="h-12 animate-pulse rounded-lg bg-muted/30" />
              <div className="h-12 animate-pulse rounded-lg bg-muted/30" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatSol(lamports: bigint): string {
  if (lamports === 0n) return '0';
  const sol = Number(lamports) / 1_000_000_000;
  return sol < 0.001 ? sol.toFixed(6) : sol.toFixed(4);
}

function formatUsdc(micro: bigint): string {
  if (micro === 0n) return '0';
  const usdc = Number(micro) / 1_000_000;
  return usdc < 0.01 ? usdc.toFixed(6) : usdc.toFixed(2);
}
