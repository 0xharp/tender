'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { performSignOut } from '@/lib/wallet';

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await performSignOut();
          router.refresh();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </Button>
  );
}
