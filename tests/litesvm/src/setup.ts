import { resolve } from 'node:path';
import {
  type Address,
  type Instruction,
  type Lamports,
  type TransactionSigner,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { TENDER_PROGRAM_ADDRESS, accounts } from '@tender/tender-client';
import { Clock, type FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from 'litesvm';

const TENDER_SO_PATH = resolve(import.meta.dirname, '../../../target/deploy/tender.so');
const ONE_SOL: Lamports = lamports(1_000_000_000n);

export function freshSvm(): LiteSVM {
  const svm = new LiteSVM();
  svm.addProgramFromFile(TENDER_PROGRAM_ADDRESS, TENDER_SO_PATH);
  return svm;
}

export async function fundedSigner(svm: LiteSVM, lamportAmount: Lamports = ONE_SOL) {
  const signer = await generateKeyPairSigner();
  const result = svm.airdrop(signer.address, lamportAmount);
  if (!result || isFailed(result)) {
    throw new Error(`airdrop failed for ${signer.address}`);
  }
  return signer;
}

export async function sendIxs(
  svm: LiteSVM,
  payer: TransactionSigner,
  ixs: Instruction[],
): Promise<TransactionMetadata | FailedTransactionMetadata> {
  const blockhash = svm.latestBlockhash();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: 0n }, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  return svm.sendTransaction(signed);
}

export function isFailed(
  result: TransactionMetadata | FailedTransactionMetadata,
): result is FailedTransactionMetadata {
  return (result as FailedTransactionMetadata).err !== undefined;
}

export function expectSuccess(
  result: TransactionMetadata | FailedTransactionMetadata,
): TransactionMetadata {
  if (isFailed(result)) {
    throw new Error(`expected success, got failure:\n${result.toString()}`);
  }
  return result;
}

export function expectFailureWithCode(
  result: TransactionMetadata | FailedTransactionMetadata,
  expectedCode: number,
): void {
  if (!isFailed(result)) {
    throw new Error('expected failure, got success');
  }
  const errStr = result.toString();
  const hexCode = expectedCode.toString(16);
  if (!errStr.toLowerCase().includes(`0x${hexCode}`)) {
    throw new Error(`expected error code 0x${hexCode}, got:\n${errStr}`);
  }
}

export function setUnixTimestamp(svm: LiteSVM, timestamp: bigint): void {
  const clock = svm.getClock();
  svm.setClock(
    new Clock(
      clock.slot,
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      timestamp,
    ),
  );
}

export function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

export function randomNonce(): Uint8Array {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return buf;
}

export function bytes32(seed: number): Uint8Array {
  const buf = new Uint8Array(32);
  buf[0] = seed & 0xff;
  return buf;
}

export function readRfp(svm: LiteSVM, addr: Address) {
  const account = svm.getAccount(addr);
  if (!account.exists) throw new Error(`Rfp account ${addr} not found`);
  return accounts.decodeRfp(account);
}

export function readBidCommit(svm: LiteSVM, addr: Address) {
  const account = svm.getAccount(addr);
  if (!account.exists) throw new Error(`BidCommit account ${addr} not found`);
  return accounts.decodeBidCommit(account);
}

export type { Address };
