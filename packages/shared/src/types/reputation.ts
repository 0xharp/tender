import type { RfpCategory } from '../constants.js';

export interface ProviderReputation {
  providerWallet: string;
  completedEngagements: number;
  disputedEngagements: number;
  onTimeCount: number;
  lateCount: number;
  totalValueSettledUsdc: string;
  categories: RfpCategory[];
  lastEngagementAt?: string;
}

export interface BuyerAttestation {
  escrowPda: string;
  buyerWallet: string;
  providerWallet: string;
  completionStatus: 'incomplete' | 'ok' | 'excellent' | 'poor';
  onTime: boolean;
  noteHash?: string;
  createdAt: string;
}
