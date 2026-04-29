import { TrendingUpIcon } from 'lucide-react';

import { DataField } from '@/components/primitives/data-field';
import { HashLink } from '@/components/primitives/hash-link';
import { SectionHeader } from '@/components/primitives/section-header';
import { ProviderBidsPanel } from '@/components/rfp/provider-bids-panel';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <SectionHeader
        eyebrow="Provider"
        title={profile?.display_name ?? 'Pseudonymous provider'}
        description={
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <HashLink hash={wallet} kind="account" visibleChars={22} />
          </span>
        }
        size="md"
      />

      <Card>
        <CardHeader className="flex flex-row items-baseline justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUpIcon className="size-4 text-muted-foreground" />
            Reputation
          </CardTitle>
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            on-chain registry · ships next phase
          </span>
        </CardHeader>
        <CardContent>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Today this provider has{' '}
            <span className="font-mono font-semibold tabular-nums text-foreground">
              {count ?? 0}
            </span>{' '}
            {count === 1 ? 'sealed bid' : 'sealed bids'} committed.
          </p>
        </CardContent>
      </Card>

      <ProviderBidsPanel profileWallet={wallet} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">On-chain</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2.5">
          <DataField label="wallet" value={<HashLink hash={wallet} kind="account" />} />
          <DataField label="program" value={<HashLink hash={TENDER_PROGRAM_ID} kind="account" />} />
        </CardContent>
      </Card>
    </main>
  );
}
