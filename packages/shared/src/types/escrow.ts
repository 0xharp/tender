export type MilestoneStatus = 'pending' | 'submitted' | 'approved' | 'released' | 'disputed';

export interface EscrowVaultRecord {
  rfpPda: string;
  buyerWallet: string;
  providerWallet: string;
  totalAmountUsdc: string;
  releasedAmountUsdc: string;
  milestoneCount: number;
  currentMilestone: number;
  fundedAt: string;
}

export interface MilestoneRecord {
  escrowPda: string;
  index: number;
  name: string;
  amountUsdc: string;
  deadline: string;
  status: MilestoneStatus;
  submittedProofUri?: string;
  submittedAt?: string;
  releasedAt?: string;
}
