import type { RfpCategory } from '../constants.js';

export type RfpStatus =
  | 'draft'
  | 'open'
  | 'reveal'
  | 'awarded'
  | 'in_progress'
  | 'completed'
  | 'disputed'
  | 'cancelled';

export interface MilestoneTemplate {
  name: string;
  description: string;
  percentage: number;
}

export interface RfpPublicMetadata {
  onChainPda: string;
  buyerWallet: string;
  title: string;
  category: RfpCategory;
  scopeSummary: string;
  budgetMaxUsdc: string;
  bidOpenAt: string;
  bidCloseAt: string;
  revealCloseAt: string;
  milestoneTemplate: MilestoneTemplate[];
  status: RfpStatus;
  winnerWallet?: string;
  createdAt: string;
  updatedAt: string;
}
