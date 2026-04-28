export type BidStatus =
  | 'committed'
  | 'revealed'
  | 'selected'
  | 'rejected'
  | 'withdrawn'
  | 'expired';

export type BidStorageBackend = 'supabase' | 'ipfs' | 'arweave' | 'per';

export interface BidCommitRecord {
  onChainPda: string;
  rfpPda: string;
  providerWallet: string;
  commitHash: string;
  ephemeralPubkey: string;
  storageBackend: BidStorageBackend;
  storageUri: string;
  perSessionId?: string;
  submittedAt: string;
  status: BidStatus;
}

export interface SealedBidPlaintext {
  priceUsdc: string;
  scope: string;
  timelineDays: number;
  milestones: { name: string; description: string; amountUsdc: string; deadlineDays: number }[];
  payoutPreference: { chain: string; asset: string; address: string };
  notes?: string;
}
