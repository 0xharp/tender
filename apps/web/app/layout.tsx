import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';

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
  title: 'Tender — private procurement marketplace on Solana',
  description:
    'Sealed-bid RFPs, on-chain escrow with milestone-based release, cross-chain payouts, and portable on-chain reputation for crypto-native organizations.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <WalletProviders>{children}</WalletProviders>
      </body>
    </html>
  );
}
