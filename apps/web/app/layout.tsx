import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';

import { BufferPolyfillProvider } from '@/components/buffer-polyfill-provider';
import { DotMatrix } from '@/components/effects/dot-matrix';
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
  },
  twitter: {
    card: 'summary_large_image',
    title: 'tendr.bid',
    description: 'Sealed-bid procurement on Solana - privacy, escrow, reputation.',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
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
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <TooltipProvider>
            <WalletProviders>
              <div className="flex min-h-screen flex-col">
                <TopNav />
                <PageTransition>{children}</PageTransition>
                <SiteFooter />
              </div>
              <Toaster />
            </WalletProviders>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
