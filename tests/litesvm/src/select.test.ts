import { findRfpPda, instructions, pdas, types } from '@tender/tender-client';
import { describe, expect, it } from 'vitest';
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

async function setupRevealRfp() {
  const svm = freshSvm();
  const buyer = await fundedSigner(svm);
  setUnixTimestamp(svm, NOW);

  const args = defaultRfpArgs();
  const [rfpPda] = await findRfpPda({ buyer: buyer.address, rfpNonce: args.rfpNonce });
  expectSuccess(
    await sendIxs(svm, buyer, [
      instructions.getRfpCreateInstruction({ buyer, rfp: rfpPda, ...args }),
    ]),
  );

  const provider = await fundedSigner(svm);
  const commitIx = await instructions.getCommitBidInstructionAsync({
    provider,
    rfp: rfpPda,
    commitHash: bytes32(7),
    ciphertextStorageUri: 'ipfs://bid-1',
  });
  expectSuccess(await sendIxs(svm, provider, [commitIx]));

  setUnixTimestamp(svm, args.bidCloseAt + 1n);
  expectSuccess(
    await sendIxs(svm, buyer, [
      instructions.getRfpCloseBiddingInstruction({ anyone: buyer, rfp: rfpPda }),
    ]),
  );

  const [bidPda] = await pdas.findBidPda({ rfp: rfpPda, provider: provider.address });
  return { svm, buyer, args, rfpPda, provider, bidPda };
}

describe('select_bid', () => {
  it('happy path: rfp.status → Awarded, rfp.winner = provider, bid.status → Selected', async () => {
    const { svm, buyer, rfpPda, bidPda, provider } = await setupRevealRfp();

    const ix = instructions.getSelectBidInstruction({ buyer, rfp: rfpPda, bid: bidPda });
    expectSuccess(await sendIxs(svm, buyer, [ix]));

    const rfp = readRfp(svm, rfpPda);
    expect(rfp.data.status).toBe(types.RfpStatus.Awarded);
    expect(rfp.data.winner).toEqual({ __option: 'Some', value: provider.address });

    const bid = readBidCommit(svm, bidPda);
    expect(bid.data.status).toBe(types.BidStatus.Selected);
  });

  it('rejects non-buyer signer (NotBuyer, 6007)', async () => {
    const { svm, rfpPda, bidPda } = await setupRevealRfp();
    const intruder = await fundedSigner(svm);
    const ix = instructions.getSelectBidInstruction({ buyer: intruder, rfp: rfpPda, bid: bidPda });
    expectFailureWithCode(await sendIxs(svm, intruder, [ix]), 6007);
  });

  it('rejects select before reveal (status=Open, InvalidRfpStatus 6013)', async () => {
    const svm = freshSvm();
    const buyer = await fundedSigner(svm);
    setUnixTimestamp(svm, NOW);
    const args = defaultRfpArgs();
    const [rfpPda] = await findRfpPda({ buyer: buyer.address, rfpNonce: args.rfpNonce });
    expectSuccess(
      await sendIxs(svm, buyer, [
        instructions.getRfpCreateInstruction({ buyer, rfp: rfpPda, ...args }),
      ]),
    );

    const provider = await fundedSigner(svm);
    const commitIx = await instructions.getCommitBidInstructionAsync({
      provider,
      rfp: rfpPda,
      commitHash: bytes32(8),
      ciphertextStorageUri: 'ipfs://x',
    });
    expectSuccess(await sendIxs(svm, provider, [commitIx]));

    const [bidPda] = await pdas.findBidPda({ rfp: rfpPda, provider: provider.address });
    const ix = instructions.getSelectBidInstruction({ buyer, rfp: rfpPda, bid: bidPda });
    expectFailureWithCode(await sendIxs(svm, buyer, [ix]), 6013);
  });

  it('rejects select past reveal_close_at (RevealWindowExpired, 6003)', async () => {
    const { svm, buyer, args, rfpPda, bidPda } = await setupRevealRfp();
    setUnixTimestamp(svm, args.revealCloseAt + 1n);
    const ix = instructions.getSelectBidInstruction({ buyer, rfp: rfpPda, bid: bidPda });
    expectFailureWithCode(await sendIxs(svm, buyer, [ix]), 6003);
  });

  it('rejects double-select (status no longer Reveal)', async () => {
    const { svm, buyer, rfpPda, bidPda } = await setupRevealRfp();
    expectSuccess(
      await sendIxs(svm, buyer, [
        instructions.getSelectBidInstruction({ buyer, rfp: rfpPda, bid: bidPda }),
      ]),
    );
    const result = await sendIxs(svm, buyer, [
      instructions.getSelectBidInstruction({ buyer, rfp: rfpPda, bid: bidPda }),
    ]);
    expect(isFailed(result)).toBe(true);
  });
});
