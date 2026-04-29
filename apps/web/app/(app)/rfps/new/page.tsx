import { SectionHeader } from '@/components/primitives/section-header';
import { RfpCreateForm } from '@/components/rfp/rfp-create-form';

export default function Page() {
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
