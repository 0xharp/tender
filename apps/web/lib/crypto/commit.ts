import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export const COMMIT_HASH_BYTES = 32;

/** sha256 of a ciphertext blob. Returns the 32-byte digest. */
export function commitHash(ciphertext: Uint8Array): Uint8Array {
  return sha256(ciphertext);
}

/** sha256 → 64-char lowercase hex string. */
export function commitHashHex(ciphertext: Uint8Array): string {
  return bytesToHex(commitHash(ciphertext));
}

export { bytesToHex, hexToBytes };

/** Throws if the hash of `blob` does not equal `expected` (32 bytes). */
export function assertCommitHashMatches(blob: Uint8Array, expected: Uint8Array): void {
  if (expected.byteLength !== COMMIT_HASH_BYTES) {
    throw new Error(`expected commit_hash to be ${COMMIT_HASH_BYTES} bytes`);
  }
  const actual = commitHash(blob);
  if (!constantTimeEqual(actual, expected)) {
    throw new Error('commit_hash mismatch');
  }
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    // biome-ignore lint/style/noNonNullAssertion: indices in range
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}
