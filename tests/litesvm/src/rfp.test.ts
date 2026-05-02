// DISABLED — these tests pre-date Day 6 (budget/milestone schema simplification)
// and the post-Day-7 milestone-removal pass. Args reference removed fields
// (budgetMax, milestoneCount on rfp_create). Re-write is tracked under
// task #108 (program test cases for new ix).
//
// Casting through `unknown` so this file still type-checks while disabled.
// biome-ignore lint/suspicious/noExplicitAny: stale-test bypass
import { findRfpPda, instructions as instructionsRaw, types } from '@tender/tender-client';
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
  readRfp,
  sendIxs,
  setUnixTimestamp,
} from './setup';

// biome-ignore lint/suspicious/noExplicitAny: see header
const instructions = instructionsRaw as any;

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
    bidderVisibility: types.BidderVisibility.Public,
  };
}

describe.skip('rfp_create', () => {
  it('happy path: stores all fields, status=Open, bid_count=0', async () => {
    const svm = freshSvm();
    const buyer = await fundedSigner(svm);
    setUnixTimestamp(svm, NOW);

    const args = defaultRfpArgs();
    const [rfpPda] = await findRfpPda({ buyer: buyer.address, rfpNonce: args.rfpNonce });
    const ix = instructions.getRfpCreateInstruction({ buyer, rfp: rfpPda, ...args });
    expectSuccess(await sendIxs(svm, buyer, [ix]));

    const rfp = readRfp(svm, rfpPda);
    expect(rfp.data.buyer).toBe(buyer.address);
    expect(rfp.data.bidCount).toBe(0);
    // biome-ignore lint/suspicious/noExplicitAny: see file header
    expect((rfp.data as any).milestoneCount).toBe(3);
    // biome-ignore lint/suspicious/noExplicitAny: budgetMax dropped in Day 6
    expect((rfp.data as any).budgetMax).toBe(50_000_000_000n);
    expect(rfp.data.status).toBe(types.RfpStatus.Open);
  });

  it('rejects milestone_count = 0 (InvalidMilestoneCount, 6009)', async () => {
    const svm = freshSvm();
    const buyer = await fundedSigner(svm);
    setUnixTimestamp(svm, NOW);

    const args = { ...defaultRfpArgs(), milestoneCount: 0 };
    const [rfpPda] = await findRfpPda({ buyer: buyer.address, rfpNonce: args.rfpNonce });
    const ix = instructions.getRfpCreateInstruction({ buyer, rfp: rfpPda, ...args });
    expectFailureWithCode(await sendIxs(svm, buyer, [ix]), 6009);
  });

  it('rejects milestone_count = 9 (above MAX)', async () => {
    const svm = freshSvm();
    const buyer = await fundedSigner(svm);
    setUnixTimestamp(svm, NOW);

    const args = { ...defaultRfpArgs(), milestoneCount: 9 };
    const [rfpPda] = await findRfpPda({ buyer: buyer.address, rfpNonce: args.rfpNonce });
    const ix = instructions.getRfpCreateInstruction({ buyer, rfp: rfpPda, ...args });
    expectFailureWithCode(await sendIxs(svm, buyer, [ix]), 6009);
  });

  it('rejects budget_max = 0 (InvalidBudget, 6012)', async () => {
    const svm = freshSvm();
    const buyer = await fundedSigner(svm);
    setUnixTimestamp(svm, NOW);

    const args = { ...defaultRfpArgs(), budgetMax: 0n };
    const [rfpPda] = await findRfpPda({ buyer: buyer.address, rfpNonce: args.rfpNonce });
    const ix = instructions.getRfpCreateInstruction({ buyer, rfp: rfpPda, ...args });
    expectFailureWithCode(await sendIxs(svm, buyer, [ix]), 6012);
  });

  it('rejects bid_close_at <= bid_open_at (InvalidBidWindow, 6010)', async () => {
    const svm = freshSvm();
    const buyer = await fundedSigner(svm);
    setUnixTimestamp(svm, NOW);

    const args = { ...defaultRfpArgs(), bidCloseAt: NOW - 100n };
    const [rfpPda] = await findRfpPda({ buyer: buyer.address, rfpNonce: args.rfpNonce });
    const ix = instructions.getRfpCreateInstruction({ buyer, rfp: rfpPda, ...args });
    expectFailureWithCode(await sendIxs(svm, buyer, [ix]), 6010);
  });
});

describe.skip('rfp_close_bidding', () => {
  it('rejects close before bid_close_at (BidWindowStillOpen, 6002)', async () => {
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

    setUnixTimestamp(svm, NOW + 3600n);
    const closeIx = instructions.getRfpCloseBiddingInstruction({ anyone: buyer, rfp: rfpPda });
    expectFailureWithCode(await sendIxs(svm, buyer, [closeIx]), 6002);
  });

  it('happy path: transitions Open → Reveal after bid_close_at', async () => {
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

    setUnixTimestamp(svm, args.bidCloseAt + 1n);
    const closeIx = instructions.getRfpCloseBiddingInstruction({ anyone: buyer, rfp: rfpPda });
    expectSuccess(await sendIxs(svm, buyer, [closeIx]));

    const rfp = readRfp(svm, rfpPda);
    expect(rfp.data.status).toBe(types.RfpStatus.Reveal);
  });

  it('rejects double close (already in Reveal status)', async () => {
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

    setUnixTimestamp(svm, args.bidCloseAt + 1n);
    const closeIx = instructions.getRfpCloseBiddingInstruction({ anyone: buyer, rfp: rfpPda });
    expectSuccess(await sendIxs(svm, buyer, [closeIx]));

    const result2 = await sendIxs(svm, buyer, [closeIx]);
    expect(isFailed(result2)).toBe(true);
  });
});
