'use client';

import { useSelectedWalletAccount, useSignMessage } from '@solana/react';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { WalletPicker } from '@/components/wallet/wallet-picker';
import { commitHashHex, hexToBytes } from '@/lib/crypto/commit';
import {
  RFP_NONCE_BYTES,
  deriveRfpKeypair,
  deriveSeedMessage,
} from '@/lib/crypto/derive-rfp-keypair';
import { decryptBid, encryptBid } from '@/lib/crypto/ecies';

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexLine(label: string, bytes: Uint8Array, max = 64) {
  const hex = bytesToHex(bytes);
  const display = hex.length > max ? `${hex.slice(0, max)}…` : hex;
  return (
    <div className="font-mono text-xs">
      <span className="text-muted-foreground">{label}:</span>{' '}
      <span className="break-all">{display}</span>{' '}
      <span className="text-muted-foreground">({bytes.byteLength}B)</span>
    </div>
  );
}

const SAMPLE_PLAINTEXT = JSON.stringify(
  {
    priceUsdc: '45000',
    scope: 'Smart contract audit, 6 weeks',
    timelineDays: 42,
    payoutPreference: { chain: 'solana', asset: 'USDC' },
  },
  null,
  2,
);

export function CryptoTestApp() {
  const [account] = useSelectedWalletAccount();
  // useSignMessage requires a real account; it's only called after the user clicks
  // "Sign + derive" which gates on `account` being set. The fake-account path is
  // never invoked at runtime.
  const signMessage = useSignMessage(account ?? ({} as never));

  const [nonceHex, setNonceHex] = useState('00112233aabbccdd');
  const [bidPlaintext, setBidPlaintext] = useState(SAMPLE_PLAINTEXT);

  const [signature, setSignature] = useState<Uint8Array | null>(null);
  const [keypair, setKeypair] = useState<{ priv: Uint8Array; pub: Uint8Array } | null>(null);
  const [sealed, setSealed] = useState<{
    blob: Uint8Array;
    commitHash: Uint8Array;
    ephemeralPub: Uint8Array;
  } | null>(null);
  const [decrypted, setDecrypted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nonceBytes = useMemo(() => {
    try {
      const b = hexToBytes(nonceHex);
      return b.byteLength === RFP_NONCE_BYTES ? b : null;
    } catch {
      return null;
    }
  }, [nonceHex]);

  async function runDerive() {
    if (!account || !nonceBytes) return;
    setBusy(true);
    setError(null);
    try {
      const message = deriveSeedMessage(nonceBytes);
      const { signature: sig } = await signMessage({ message });
      setSignature(sig);
      const kp = deriveRfpKeypair(sig);
      setKeypair({ priv: kp.x25519PrivateKey, pub: kp.x25519PublicKey });
      setSealed(null);
      setDecrypted(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function runEncrypt() {
    if (!keypair) return;
    setError(null);
    try {
      const result = encryptBid(enc.encode(bidPlaintext), keypair.pub);
      setSealed(result);
      setDecrypted(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function runDecrypt() {
    if (!keypair || !sealed) return;
    setError(null);
    try {
      const plain = decryptBid(sealed.blob, keypair.priv);
      setDecrypted(dec.decode(plain));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          dev / sealed-bid round-trip
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">/test/crypto</h1>
        <p className="text-sm text-muted-foreground">
          End-to-end demo of buyer keypair derivation + ECIES sealed-bid encrypt/decrypt. Real
          wallet signature, real cryptography — no mocks.
        </p>
      </header>

      <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">1. Connect wallet</h2>
        <WalletPicker />
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">2. Derive RFP keypair from wallet signature</h2>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">RFP nonce (8 bytes hex)</span>
          <input
            type="text"
            value={nonceHex}
            onChange={(e) => setNonceHex(e.target.value.trim())}
            className="rounded border border-border bg-background px-3 py-2 font-mono text-xs"
            placeholder="00112233aabbccdd"
          />
          {!nonceBytes && (
            <span className="text-xs text-destructive">Need exactly 16 hex chars (8 bytes).</span>
          )}
        </label>
        <Button
          onClick={runDerive}
          disabled={!account || !nonceBytes || busy}
          className="self-start"
        >
          {busy ? 'Signing…' : 'Sign + derive keypair'}
        </Button>
        {signature && hexLine('signature (ed25519)', signature)}
        {keypair && (
          <div className="flex flex-col gap-1 rounded border border-dashed border-border p-3">
            {hexLine('x25519 priv', keypair.priv)}
            {hexLine('x25519 pub', keypair.pub)}
            <p className="mt-1 text-xs text-muted-foreground">
              Determinism check: re-running this step with the same wallet + same nonce will produce
              byte-identical keys.
            </p>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">3. Encrypt a sample bid to the buyer pubkey</h2>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Bid plaintext (UTF-8)</span>
          <textarea
            value={bidPlaintext}
            onChange={(e) => setBidPlaintext(e.target.value)}
            rows={6}
            className="rounded border border-border bg-background px-3 py-2 font-mono text-xs"
          />
        </label>
        <Button onClick={runEncrypt} disabled={!keypair} className="self-start">
          Encrypt + commit
        </Button>
        {sealed && (
          <div className="flex flex-col gap-1 rounded border border-dashed border-border p-3">
            {hexLine('ephemeralPub', sealed.ephemeralPub)}
            {hexLine('blob', sealed.blob, 96)}
            <div className="font-mono text-xs">
              <span className="text-muted-foreground">commit_hash:</span>{' '}
              <span className="break-all">{commitHashHex(sealed.blob)}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              `commit_hash` is what gets posted on-chain in the `commit_bid` instruction.
            </p>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">4. Decrypt the sealed bid</h2>
        <Button onClick={runDecrypt} disabled={!sealed} className="self-start">
          Decrypt
        </Button>
        {decrypted !== null && (
          <pre className="overflow-auto rounded border border-dashed border-border bg-background p-3 font-mono text-xs">
            {decrypted}
          </pre>
        )}
        {decrypted !== null && decrypted === bidPlaintext && (
          <p className="text-xs font-medium text-green-600">
            ✓ Round-trip verified: decrypted plaintext matches original byte-for-byte.
          </p>
        )}
      </section>

      {error && (
        <div className="rounded border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <footer className="text-xs text-muted-foreground">
        Network panel proof: this page makes ZERO requests to any LLM, encryption service, or
        backend. All cryptography runs on this device. Wallet signing is the only external call, and
        it stays inside your wallet extension.
      </footer>
    </main>
  );
}
