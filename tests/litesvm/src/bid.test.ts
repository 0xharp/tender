import { describe, expect, it } from 'vitest';
import { findRfpPda, instructions, pdas, types } from '@tender/tender-client';
import {
  bytes32,
  expectFailureWithCode,
  expectSuccess,
  freshSvm,
  fundedSigner,
  isFailed,
  nowSeconds,
  randomNonce,
  readBidCommit,
  readRfp,
  sendIxs,
  setUnixTimestamp,
} from './setup';

const NOW = nowSeconds();

function defaultRfpArgs() {
  return {
    rfpNonce: randomNonce(),
    buyerEncryptionPubkey: bytes32(1),
    titleHash: bytes32(2),
    category: 0,
    budgetMax: 50_000_000_000n,
    bidOpenAt: NOW,
    bidCloseAt: NOW + 86_400n,
    revealCloseAt: NOW + 86_400n * 3n,
    milestoneCount: 3,
  };
}

async function setupOpenRfp() {
  const svm = freshSvm();
  const buyer = await fundedSigner(svm);
  setUnixTimestamp(svm, NOW);

  const args = defaultRfpArgs();
  const [rfpPda] = await findRfpPda({ buyer: buyer.address, rfpNonce: args.rfpNonce });
  const createIx = instructions.getRfpCreateInstruction({ buyer, rfp: rfpPda, ...args });
  expectSuccess(await sendIxs(svm, buyer, [createIx]));

  return { svm, buyer, args, rfpPda };
}

describe('bid_commit', () => {
  it('happy path: stores bid + increments rfp.bid_count', async () => {
    const { svm, rfpPda } = await setupOpenRfp();
    const provider = await fundedSigner(svm);

    const bidIx = await instructions.getBidCommitInstructionAsync({
      provider,
      rfp: rfpPda,
      commitHash: bytes32(7),
      ciphertextStorageUri: 'ipfs://bafy-fixture-1',
    });
    expectSuccess(await sendIxs(svm, provider, [bidIx]));

    const [bidPda] = await pdas.findBidPda({ rfp: rfpPda, provider: provider.address });
    const bid = readBidCommit(svm, bidPda);
    expect(bid.data.provider).toBe(provider.address);
    expect(bid.data.rfp).toBe(rfpPda);
    expect(bid.data.status).toBe(types.BidStatus.Committed);
    expect(bid.data.ciphertextStorageUri).toBe('ipfs://bafy-fixture-1');

    const rfp = readRfp(svm, rfpPda);
    expect(rfp.data.bidCount).toBe(1);
  });

  it('rejects bid before bid_open_at (BidWindowNotOpen, 6000)', async () => {
    const { svm, rfpPda, args } = await setupOpenRfp();
    setUnixTimestamp(svm, args.bidOpenAt - 100n);

    const provider = await fundedSigner(svm);
    const bidIx = await instructions.getBidCommitInstructionAsync({
      provider,
      rfp: rfpPda,
      commitHash: bytes32(8),
      ciphertextStorageUri: 'ipfs://x',
    });
    expectFailureWithCode(await sendIxs(svm, provider, [bidIx]), 6000);
  });

  it('rejects bid after bid_close_at (BidWindowClosed, 6001)', async () => {
    const { svm, rfpPda, args } = await setupOpenRfp();
    setUnixTimestamp(svm, args.bidCloseAt + 1n);

    const provider = await fundedSigner(svm);
    const bidIx = await instructions.getBidCommitInstructionAsync({
      provider,
      rfp: rfpPda,
      commitHash: bytes32(9),
      ciphertextStorageUri: 'ipfs://y',
    });
    expectFailureWithCode(await sendIxs(svm, provider, [bidIx]), 6001);
  });

  it('rejects duplicate bid from same provider (anchor init constraint)', async () => {
    const { svm, rfpPda } = await setupOpenRfp();
    const provider = await fundedSigner(svm);

    const bidIx1 = await instructions.getBidCommitInstructionAsync({
      provider,
      rfp: rfpPda,
      commitHash: bytes32(10),
      ciphertextStorageUri: 'ipfs://first',
    });
    expectSuccess(await sendIxs(svm, provider, [bidIx1]));

    const bidIx2 = await instructions.getBidCommitInstructionAsync({
      provider,
      rfp: rfpPda,
      commitHash: bytes32(11),
      ciphertextStorageUri: 'ipfs://second',
    });
    const result = await sendIxs(svm, provider, [bidIx2]);
    expect(isFailed(result)).toBe(true);
  });

  it('three providers commit independently — bid_count = 3', async () => {
    const { svm, rfpPda } = await setupOpenRfp();

    for (let i = 0; i < 3; i++) {
      const provider = await fundedSigner(svm);
      const bidIx = await instructions.getBidCommitInstructionAsync({
        provider,
        rfp: rfpPda,
        commitHash: bytes32(20 + i),
        ciphertextStorageUri: `ipfs://bid-${i}`,
      });
      expectSuccess(await sendIxs(svm, provider, [bidIx]));
    }

    const rfp = readRfp(svm, rfpPda);
    expect(rfp.data.bidCount).toBe(3);
  });
});

describe('bid_withdraw', () => {
  it('happy path: closes bid + decrements rfp.bid_count', async () => {
    const { svm, rfpPda } = await setupOpenRfp();
    const provider = await fundedSigner(svm);

    const bidIx = await instructions.getBidCommitInstructionAsync({
      provider,
      rfp: rfpPda,
      commitHash: bytes32(30),
      ciphertextStorageUri: 'ipfs://withdrawable',
    });
    expectSuccess(await sendIxs(svm, provider, [bidIx]));

    const withdrawIx = await instructions.getBidWithdrawInstructionAsync({
      provider,
      rfp: rfpPda,
    });
    expectSuccess(await sendIxs(svm, provider, [withdrawIx]));

    const rfp = readRfp(svm, rfpPda);
    expect(rfp.data.bidCount).toBe(0);

    const [bidPda] = await pdas.findBidPda({ rfp: rfpPda, provider: provider.address });
    const closed = svm.getAccount(bidPda);
    expect(closed.exists).toBe(false);
  });

  it('rejects withdraw after bid_close_at (BidWindowClosed, 6001)', async () => {
    const { svm, rfpPda, args } = await setupOpenRfp();
    const provider = await fundedSigner(svm);

    const bidIx = await instructions.getBidCommitInstructionAsync({
      provider,
      rfp: rfpPda,
      commitHash: bytes32(31),
      ciphertextStorageUri: 'ipfs://late-withdraw',
    });
    expectSuccess(await sendIxs(svm, provider, [bidIx]));

    setUnixTimestamp(svm, args.bidCloseAt + 1n);

    const withdrawIx = await instructions.getBidWithdrawInstructionAsync({
      provider,
      rfp: rfpPda,
    });
    expectFailureWithCode(await sendIxs(svm, provider, [withdrawIx]), 6001);
  });

  it('rejects withdraw by non-owner (different provider has no bid PDA to close)', async () => {
    const { svm, rfpPda } = await setupOpenRfp();
    const owner = await fundedSigner(svm);
    const intruder = await fundedSigner(svm);

    const bidIx = await instructions.getBidCommitInstructionAsync({
      provider: owner,
      rfp: rfpPda,
      commitHash: bytes32(32),
      ciphertextStorageUri: 'ipfs://mine',
    });
    expectSuccess(await sendIxs(svm, owner, [bidIx]));

    const withdrawIx = await instructions.getBidWithdrawInstructionAsync({
      provider: intruder,
      rfp: rfpPda,
    });
    const result = await sendIxs(svm, intruder, [withdrawIx]);
    expect(isFailed(result)).toBe(true);
  });
});
