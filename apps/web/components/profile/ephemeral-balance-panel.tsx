'use client';

/**
 * Ephemeral balance + sweep dashboard. Mounted on the user's own
 * profile page (buyer or provider).
 *
 * Surfaces every ephemeral wallet the HD keychain owns + their
 * on-chain SOL / USDC balances + a one-click sweep that routes
 * residual funds back to the main wallet via Cloak's shielded pool.
 *
 * Why this matters: every private RFP/bid creates an ephemeral that
 * gets funded with SOL (rent + tx fees) and sometimes USDC (escrow
 * funding, refunds). Most flows leave a few cents of SOL stranded on
 * the ephemeral after they complete. Without a sweep surface, those
 * trickles pile up across many private RFPs and the user has no easy
 * way to consolidate. This panel makes them visible + reclaimable.
 *
 * Privacy note: the sweep itself goes ephemeral → Cloak shielded pool
 * → main wallet, so the on-chain trail is broken. The ephemeral's
 * private key never leaves the keychain.
 *
 * Two-phase rendering: initial unlock prompt → after master sign,
 * enumerate + fetch balances in parallel → render rows. Total wall
 * time ~1-2s for normal users.
 */

import { LoaderCircleIcon, WalletIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { HashLink } from '@/components/primitives/hash-link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  type KeychainHandle,
  type MyEphemeral,
  useKeychainContext,
  useMyActivity,
  useTendrAccount,
} from '@/lib/wallet';

interface EphemeralRow {
  /** Unique key for React + sweep targeting. */
  pubkey: string;
  /** What kind of ephemeral this is — drives the label + sweep policy. */
  role: 'buyer' | 'bidder';
  /** HD slot index (lets the user re-derive deterministically later). */
  index: number;
  /** Lamports held on chain. */
  solLamports: bigint;
  /** USDC base-units (6 decimals) at the ephemeral's USDC ATA. 0 if no ATA. */
  usdcMicroUsdc: bigint;
  /** Optional context: the RFP this ephemeral is bound to (if applicable). */
  rfpPda?: string;
}

const SOL_DUST_THRESHOLD = 5_000n; // 0.000005 SOL — anything below isn't worth showing

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

export function EphemeralBalancePanel() {
  const account = useTendrAccount();
  const keychain = useKeychainContext();
  if (!account || !keychain) return null;
  return <Inner keychain={keychain} mainWallet={account.address} />;
}

function Inner({ keychain, mainWallet }: { keychain: KeychainHandle; mainWallet: string }) {
  const activity = useMyActivity();
  const [rows, setRows] = useState<EphemeralRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [sweeping, setSweeping] = useState<string | null>(null);

  // Read the central HD-ephemeral list from MyActivityProvider — no
  // independent enumerate. When the activity provider's enumerate
  // completes, fetch SOL + USDC balances for each ephemeral.
  useEffect(() => {
    if (!activity.isReady) return;
    if (activity.ephemerals.length === 0) {
      setRows([]);
      return;
    }
    void fetchBalances(activity.ephemerals);
  }, [activity.isReady, activity.ephemerals]);

  async function fetchBalances(ephemerals: MyEphemeral[]) {
    setLoading(true);
    try {
      const [{ Connection, PublicKey }, splToken] = await Promise.all([
        import('@solana/web3.js'),
        import('@solana/spl-token'),
      ]);
      const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
      const connection = new Connection(rpcUrl, 'confirmed');
      const usdcMint = new PublicKey('61ro7AExqfk4dZYoCyRzTahahCC2TdUUZ4M5epMPunJf');

      // Dedupe by pubkey — defensive in case the same ephemeral
      // surfaces for both roles (shouldn't, but the cost is one extra
      // map entry vs. a confused UI).
      const uniq = Array.from(new Map(ephemerals.map((e) => [e.pubkey, e])).values());

      const enriched: EphemeralRow[] = await Promise.all(
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
                // ATA doesn't exist — no USDC ever landed here.
                return 0n;
              }
            })(),
          ]);
          return {
            pubkey: c.pubkey,
            role: c.role,
            index: c.index,
            rfpPda: c.rfpPda,
            solLamports,
            usdcMicroUsdc,
          };
        }),
      );

      // Hide dust-only rows (< 5000 lamports SOL + 0 USDC). They're
      // not worth showing; sweep wouldn't even cover the tx fee.
      const visible = enriched.filter(
        (r) => r.solLamports >= SOL_DUST_THRESHOLD || r.usdcMicroUsdc > 0n,
      );
      setRows(visible);
    } catch {
      // Silent — surfacing as "empty" is the right UX (vs. a toast
      // every page load on transient failure).
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleSweep(row: EphemeralRow) {
    setSweeping(row.pubkey);
    try {
      // Re-derive the ephemeral keypair from the keychain. Same input
      // (masterSeed, role, index) → same keypair, deterministically.
      const eph =
        row.role === 'buyer'
          ? await keychain.buyerEphemeral(row.index)
          : await keychain.bidderEphemeral(row.index);
      if (eph.publicKey.toBase58() !== row.pubkey) {
        throw new Error('Derived ephemeral pubkey mismatch — keychain inconsistency');
      }
      const [{ Connection, PublicKey }, { sweepEphemeralToDestination }] = await Promise.all([
        import('@solana/web3.js'),
        import('@/lib/sdks/cloak'),
      ]);
      const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
      const connection = new Connection(rpcUrl, 'confirmed');

      // Leave a small reserve so the sweep tx itself can pay fees.
      // ~0.01 SOL is the same heuristic the per-RFP sweep panel uses.
      const reserveLamports = 10_000_000n;
      const sweepLamports = row.solLamports - reserveLamports;
      if (sweepLamports <= 0n) {
        toast.info('Nothing to sweep — balance below the reserve floor');
        return;
      }
      await sweepEphemeralToDestination({
        ephemeralKeypair: eph,
        destinationPubkey: new PublicKey(mainWallet),
        sweepLamports,
        connection,
      });
      toast.success(`Swept ${formatSol(sweepLamports)} SOL back to main`, {
        description: `Cloak-shielded — no on-chain link from ephemeral ${row.pubkey.slice(0, 6)}…`,
      });
      // Optimistically zero out the row + remove from list.
      setRows((current) => (current ? current.filter((r) => r.pubkey !== row.pubkey) : current));
    } catch (e) {
      toast.error('Sweep failed', { description: (e as Error).message });
    } finally {
      setSweeping(null);
    }
  }

  // Avoid noise on the page when there's nothing to show. Three branches
  // collapse to "render nothing":
  //   - keychain locked → effect never runs, rows stays null
  //   - scan finished + no funded ephemerals → rows is []
  //   - scan finished + only dust filtered out → rows is []
  // The user sees this panel only when there's actually something to act on.
  if (!loading && (rows == null || rows.length === 0)) return null;

  const totalSol = (rows ?? []).reduce((acc, r) => acc + r.solLamports, 0n);
  const totalUsdc = (rows ?? []).reduce((acc, r) => acc + r.usdcMicroUsdc, 0n);

  return (
    <Card className="border-primary/30 bg-primary/[0.02]">
      <CardHeader className="flex flex-row items-baseline justify-between gap-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <WalletIcon className="size-4 text-primary" />
          Ephemeral balances
          {rows != null && (
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              ({rows.length})
            </span>
          )}
        </CardTitle>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          hd-keychain · sweep-back via cloak
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {loading && rows == null ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircleIcon className="size-3.5 animate-spin" />
            Scanning HD ephemerals for stranded funds…
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 rounded-xl border border-border/60 bg-card/40 p-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Total SOL
                </span>
                <span className="font-mono text-2xl font-semibold tabular-nums">
                  {formatSol(totalSol)}
                </span>
                <span className="text-[10px] text-muted-foreground">across all ephemerals</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Total USDC
                </span>
                <span className="font-mono text-2xl font-semibold tabular-nums">
                  {formatUsdc(totalUsdc)}
                </span>
                <span className="text-[10px] text-muted-foreground">across all ephemerals</span>
              </div>
            </div>
            <ul className="flex flex-col divide-y divide-border/40 rounded-xl border border-border/60">
              {(rows ?? []).map((r) => (
                <li
                  key={r.pubkey}
                  className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="font-mono text-xs uppercase tracking-wider text-primary">
                        {r.role}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        slot #{r.index}
                      </span>
                      <span>·</span>
                      <HashLink hash={r.pubkey} kind="account" visibleChars={5} linkable />
                    </div>
                    <div className="flex flex-wrap items-baseline gap-x-3 text-[11px] text-muted-foreground">
                      <span className="font-mono">
                        <span className="text-foreground">{formatSol(r.solLamports)}</span> SOL
                      </span>
                      <span className="font-mono">
                        <span className="text-foreground">{formatUsdc(r.usdcMicroUsdc)}</span> USDC
                      </span>
                      {r.rfpPda && (
                        <>
                          <span>·</span>
                          <span>
                            rfp{' '}
                            <HashLink
                              hash={r.rfpPda}
                              kind="account"
                              visibleChars={4}
                              linkable={false}
                            />
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => handleSweep(r)}
                    disabled={sweeping !== null}
                    className="rounded-full px-3 text-[11px]"
                    title="Sweep SOL back to your main wallet via Cloak's shielded pool"
                  >
                    {sweeping === r.pubkey ? (
                      <LoaderCircleIcon className="size-3 animate-spin" />
                    ) : null}
                    {sweeping === r.pubkey ? 'Sweeping…' : 'Sweep SOL'}
                  </Button>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-muted-foreground">
              USDC sweep is single-asset-per-tx — Cloak's shielded SPL withdraw needs an ALT setup,
              so we'll wire the USDC sweep variant in v2.1. For now, USDC funds show their balance
              but only SOL sweeps in one click.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
