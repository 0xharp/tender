import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';

import { BufferPolyfillProvider } from '@/components/buffer-polyfill-provider';
import { DotMatrix } from '@/components/effects/dot-matrix';
import { IdentityModalProvider } from '@/components/identity/identity-modal-provider';
import { getCurrentWallet } from '@/lib/auth/session';
import { PageTransition } from '@/components/motion/page-transition';
import { SiteFooter } from '@/components/nav/site-footer';
import { TopNav } from '@/components/nav/top-nav';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WalletProviders } from '@/components/wallet/wallet-providers';

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
  title: 'tendr.bid - private procurement for crypto-native organizations',
  description:
    'Sealed-bid RFPs, on-chain escrow with milestone-based release, cross-chain payouts, and portable on-chain reputation. Built on Solana.',
  openGraph: {
    title: 'tendr.bid',
    description: 'Sealed-bid procurement on Solana - privacy, escrow, reputation.',
    type: 'website',
    siteName: 'tendr.bid',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'tendr.bid',
    description: 'Sealed-bid procurement on Solana - privacy, escrow, reputation.',
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
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          disableTransitionOnChange
        >
          <TooltipProvider>
            <WalletProviders>
              <IdentityModalProvider signedInWallet={signedInWallet}>
                <div className="flex min-h-screen flex-col">
                  <TopNav />
                  <PageTransition>{children}</PageTransition>
                  <SiteFooter />
                </div>
                <Toaster />
              </IdentityModalProvider>
            </WalletProviders>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
