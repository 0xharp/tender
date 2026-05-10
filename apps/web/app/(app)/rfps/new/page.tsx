import { SectionHeader } from '@/components/primitives/section-header';
import { RfpCreateForm } from '@/components/rfp/rfp-create-form';
import { SignInGate } from '@/components/wallet/sign-in-gate';
import { getCurrentWallet } from '@/lib/auth/session';

// Per-page gate. The route group's (app)/layout.tsx no longer enforces a
// global SignInGate (so public reads — marketplace, RFP detail, profiles
// — are available without connecting), but creating an RFP requires a
// signed-in wallet to actually submit anything.
export default async function Page() {
  const wallet = await getCurrentWallet();
  if (!wallet) return <SignInGate />;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <SectionHeader
        eyebrow="Buyer · new RFP"
        title="Post a request for proposal"
        description="Sealed bids encrypt to your wallet's derived keypair. Title, budget, and windows go on-chain; scope detail stays off-chain."
        size="sm"
      />
      <RfpCreateForm />
    </main>
  );
}
