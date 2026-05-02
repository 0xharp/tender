'use client';

/**
 * Browser-only Buffer polyfill - fixes Cloak SDK's `Buffer.readBigInt64LE`
 * crash on the browser.
 *
 * Two layers because the global polyfill alone doesn't reach Cloak's chunk
 * (Turbopack inlines its own stub Buffer reference inside Cloak's bundled
 * code, so `globalThis.Buffer = full` is invisible to Cloak's call site):
 *
 *   1. `globalThis.Buffer` = full `buffer` npm package (covers any code that
 *      reads from globalThis at runtime - most libraries).
 *
 *   2. Patch `Uint8Array.prototype` with the BigInt-aware Buffer methods
 *      (`readBigInt64LE`, etc.) so even when Cloak's code calls
 *      `someUint8Array.readBigInt64LE(0)` via the broken stub-Buffer path,
 *      the method still exists. The npm `buffer` package's prototype methods
 *      operate via numeric `this[i]` indexing, which works equally well on
 *      Uint8Array. Hacky but pragmatic - it lets us ship privacy mode
 *      without forking Cloak's SDK or switching off Turbopack.
 *
 * Server-side: the `'use client'` directive + `typeof window` guard keep this
 * out of SSR, where overwriting Node's native Buffer breaks Next's response
 * pipe ("val must be string, number or Buffer").
 *
 * **Import source matters:** use `'buffer'` (npm), NOT `'node:buffer'`. Next /
 * Turbopack auto-shims `node:buffer` in browser builds to a stripped-down
 * Buffer without BigInt-aware methods (`readBigInt64LE`, etc). Importing from
 * there would assign the same broken Buffer back over itself and the
 * Uint8Array prototype patches would silently no-op (because the source
 * methods we'd try to copy are missing too). The npm `buffer@6.x` package
 * ships the full BigInt methods - that's what Cloak's relay path needs.
 */
import { Buffer as BufferPolyfill } from 'buffer';

if (typeof window !== 'undefined') {
  // biome-ignore lint/suspicious/noExplicitAny: cross-realm Buffer typing
  (globalThis as any).Buffer = BufferPolyfill;
  // biome-ignore lint/suspicious/noExplicitAny: cross-realm Buffer typing
  (window as any).Buffer = BufferPolyfill;

  // Patch Uint8Array.prototype with BigInt-aware Buffer methods. These
  // implementations come straight from the `buffer` npm package and only
  // depend on numeric indexing into `this` - which Uint8Array supports.
  const u8 = Uint8Array.prototype as unknown as Record<string, unknown>;
  const buf = BufferPolyfill.prototype as unknown as Record<string, unknown>;
  const methodsToBackport = [
    'readBigInt64LE',
    'readBigInt64BE',
    'readBigUInt64LE',
    'readBigUInt64BE',
    'writeBigInt64LE',
    'writeBigInt64BE',
    'writeBigUInt64LE',
    'writeBigUInt64BE',
    'readInt32LE',
    'readUInt32LE',
    'readInt16LE',
    'readUInt16LE',
    'readInt8',
    'readUInt8',
    'writeInt32LE',
    'writeUInt32LE',
    'writeInt16LE',
    'writeUInt16LE',
    'writeInt8',
    'writeUInt8',
  ] as const;
  for (const method of methodsToBackport) {
    if (typeof u8[method] !== 'function' && typeof buf[method] === 'function') {
      Object.defineProperty(Uint8Array.prototype, method, {
        value: buf[method],
        writable: true,
        configurable: true,
      });
    }
  }
}

/** Renders nothing - the polyfill is the side effect of importing this module. */
export function BufferPolyfillProvider() {
  return null;
}
