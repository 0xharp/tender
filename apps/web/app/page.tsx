export default function Home() {
  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex flex-1 w-full max-w-3xl flex-col justify-center gap-8 py-32 px-8 sm:px-16">
        <p className="font-mono text-xs uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
          Solana Frontier hackathon · devnet
        </p>
        <h1 className="text-4xl font-semibold leading-tight tracking-tight text-black sm:text-5xl dark:text-zinc-50">
          Tender — private procurement for crypto-native organizations.
        </h1>
        <p className="max-w-xl text-lg leading-8 text-zinc-600 dark:text-zinc-400">
          Sealed-bid RFPs. On-chain escrow with milestone-based release. Cross-chain payouts.
          Portable on-chain reputation. Built on Solana.
        </p>
        <p className="max-w-xl text-sm leading-6 text-zinc-500 dark:text-zinc-500">
          Scaffolding in progress. Architecture, demo storyboard, and submission tracking will land
          here as the build progresses. Repo:{' '}
          <a
            href="https://github.com/0xharp/tender"
            className="font-medium text-zinc-900 underline underline-offset-4 dark:text-zinc-100"
          >
            github.com/0xharp/tender
          </a>
          .
        </p>
      </main>
    </div>
  );
}
