import type { ReactNode } from 'react';

import { SignInGate } from '@/components/wallet/sign-in-gate';
import { getCurrentWallet } from '@/lib/auth/session';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const wallet = await getCurrentWallet();

  if (!wallet) {
    return <SignInGate />;
  }

  return <>{children}</>;
}
