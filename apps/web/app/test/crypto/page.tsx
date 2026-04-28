'use client';

import { ClientOnly } from '@/components/client-only';
import { CryptoTestApp } from './CryptoTestApp';

export default function Page() {
  return (
    <ClientOnly
      fallback={
        <main className="mx-auto max-w-3xl px-6 py-12">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </main>
      }
    >
      <CryptoTestApp />
    </ClientOnly>
  );
}
