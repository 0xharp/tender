/**
 * Wait for an on-chain tx signature to confirm AND surface any execution
 * error. Use after `sendTransaction({ skipPreflight: true })` so a tx
 * that lands but reverts doesn't get reported as success.
 *
 * `sendTransaction` returns the signature as soon as the RPC accepts the
 * tx envelope — NOT after the tx executes. With `skipPreflight: true`
 * (which we use everywhere to bypass RPC simulator quirks), the tx can
 * land on chain and STILL fail in execution (most common: a custom
 * program error from a require! check). Callers that toast success
 * directly after the send call will lie to the user.
 *
 * This helper polls `getSignatureStatuses` until the slot reaches
 * `confirmed` (or `finalized`), then throws if `err` is non-null. The
 * thrown error includes the JSON-stringified `err` field, which gives
 * the user the actual program error code in the toast (e.g.
 * `{"InstructionError":[1,{"Custom":6005}]}` → callers can surface it).
 *
 * Defaults tuned for devnet: 1-second poll interval (matches Solana's
 * confirmed-block cadence), 60-second timeout (covers worst-case
 * leader transitions + RPC propagation lag).
 */
import type { Rpc, SolanaRpcApi } from '@solana/kit';

export async function confirmTransaction({
  rpc,
  signature,
  timeoutMs = 60_000,
  pollIntervalMs = 1_000,
}: {
  rpc: Rpc<SolanaRpcApi>;
  signature: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await rpc
      // biome-ignore lint/suspicious/noExplicitAny: kit's Signature is a branded string at runtime
      .getSignatureStatuses([signature as any])
      .send();
    const status = value[0];
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      if (status.err) {
        // BigInt-safe stringify — `status.err` from kit RPC responses
        // can contain bigints (e.g. CU counts, slot numbers nested in
        // InstructionError variants). Default JSON.stringify throws
        // "Do not know how to serialize a BigInt" on those, which then
        // becomes the user-facing toast instead of the actual program
        // error code. Replacer coerces every bigint to its decimal
        // string representation.
        throw new Error(
          `tx reverted on chain: ${JSON.stringify(status.err, (_k, v) =>
            typeof v === 'bigint' ? v.toString() : v,
          )}`,
        );
      }
      return;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`timed out waiting for ${signature} to confirm`);
}
