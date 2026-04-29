import { RfpCreateForm } from '@/components/rfp/rfp-create-form';
import { Toaster } from '@/components/ui/sonner';

export default function Page() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8 flex flex-col gap-2">
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          buyer / new rfp
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Post a request for proposal</h1>
        <p className="text-sm text-muted-foreground">
          Sealed bids encrypt to your wallet&rsquo;s derived keypair. Title + budget + windows go
          on-chain; scope detail stays off-chain.
        </p>
      </header>
      <RfpCreateForm />
      <Toaster />
    </main>
  );
}
