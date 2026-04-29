import Link from 'next/link';

import { ProviderBidsPanel } from '@/components/rfp/provider-bids-panel';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Toaster } from '@/components/ui/sonner';
import { serverSupabase } from '@/lib/supabase/server';
import { TENDER_PROGRAM_ID } from '@tender/shared';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ wallet: string }>;
}

export default async function Page({ params }: PageProps) {
  const { wallet } = await params;
  const supabase = await serverSupabase();

  const [{ data: profile }, { count }] = await Promise.all([
    supabase.from('providers').select('*').eq('wallet', wallet).maybeSingle(),
    supabase
      .from('bid_ciphertexts')
      .select('id', { count: 'exact', head: true })
      .eq('provider_wallet', wallet),
  ]);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          provider
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          {profile?.display_name ?? 'Pseudonymous provider'}
        </h1>
        <p className="break-all font-mono text-xs text-muted-foreground">{wallet}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reputation</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            On-chain reputation registry ships next phase. Today this provider has{' '}
            <span className="font-medium text-foreground">{count ?? 0}</span>{' '}
            {count === 1 ? 'sealed bid' : 'sealed bids'} committed.
          </p>
        </CardContent>
      </Card>

      <ProviderBidsPanel profileWallet={wallet} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">On-chain</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <Link
            href={`https://solscan.io/account/${wallet}?cluster=devnet`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-xs underline"
          >
            wallet on Solscan ↗
          </Link>
          <Link
            href={`https://solscan.io/account/${TENDER_PROGRAM_ID}?cluster=devnet`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-xs underline"
          >
            tender program ↗
          </Link>
        </CardContent>
      </Card>

      <Toaster />
    </main>
  );
}
