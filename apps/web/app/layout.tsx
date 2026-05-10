import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';

import { BufferPolyfillProvider } from '@/components/buffer-polyfill-provider';
import { DotMatrix } from '@/components/effects/dot-matrix';
import { IdentityModalProvider } from '@/components/identity/identity-modal-provider';
import { PageTransition } from '@/components/motion/page-transition';
import { SiteFooter } from '@/components/nav/site-footer';
import { TopNav } from '@/components/nav/top-nav';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getCurrentWallet } from '@/lib/auth/session';
import { KeychainProvider, MyActivityProvider, TendrWalletProvider } from '@/lib/wallet';

import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'tendr.bid · End-to-end private RFP procurement on Solana',
  description:
    'Sealed bids on a TEE-backed rollup, milestone escrow funded through Cloak, anonymous buyer + bidder ephemerals, and on-chain reputation that merges into your main wallet on your terms.',
  openGraph: {
    title: 'tendr.bid',
    description:
      'End-to-end private RFP procurement on Solana — sealed bids, milestone escrow, anonymous wallets, on-chain reputation.',
    type: 'website',
    siteName: 'tendr.bid',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'tendr.bid',
    description:
      'End-to-end private RFP procurement on Solana — sealed bids, milestone escrow, anonymous wallets, on-chain reputation.',
    // `site` is the brand handle that gets attribution on every X link
    // card pointing at tendr.bid. `creator` is the founder's handle.
    site: '@tendrdotbid',
    creator: '@0xharp',
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Read the signed-in wallet server-side so IdentityModalProvider knows
  // when to auto-open the claim modal. We deliberately gate on "signed in"
  // (SIWS session cookie present + verified) rather than "wallet connected"
  // — otherwise the modal would pop while the SIWS dialog is still open,
  // stacking popups on top of each other.
  const signedInWallet = await getCurrentWallet();
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-background text-foreground">
        <BufferPolyfillProvider />
        <DotMatrix />
        <ThemeProvider attribute="class" defaultTheme="light" disableTransitionOnChange>
          <TooltipProvider>
            <TendrWalletProvider>
              {/* KeychainProvider — single source of HD-master-seed
                  derivation per session. Mounted INSIDE the wallet
                  provider so it can read the connected account, but
                  OUTSIDE the route children so the cached seed
                  survives navigation. */}
              <KeychainProvider signedInWallet={signedInWallet}>
                {/* MyActivityProvider — single source of truth for
                    "all my RFPs + bids + ephemerals" across both the
                    main wallet AND HD-derived ephemerals. Mounted
                    inside KeychainProvider so it can read the keychain
                    handle; outside the route children so its cache
                    survives navigation. */}
                <MyActivityProvider signedInWallet={signedInWallet}>
                  <IdentityModalProvider signedInWallet={signedInWallet}>
                    <div className="flex min-h-screen flex-col">
                      <TopNav />
                      <PageTransition>{children}</PageTransition>
                      <SiteFooter />
                    </div>
                    <Toaster />
                  </IdentityModalProvider>
                </MyActivityProvider>
              </KeychainProvider>
            </TendrWalletProvider>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
