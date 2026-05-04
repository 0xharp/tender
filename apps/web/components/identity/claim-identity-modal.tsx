'use client';

/**
 * Onboarding modal for claiming a `<handle>.tendr.sol` identity on devnet.
 *
 * Controlled component — caller owns `open` state. Renders the handle
 * picker with:
 *   - Live lexical validation (sync, no RPC)
 *   - Debounced availability check (~400ms after typing stops)
 *   - "Suggest" button that fills with a wordlist candidate
 *   - "Claim" submit button that POSTs `/api/identity/claim`
 *
 * On success, calls `onClaimed(fullName)` and refreshes the router so
 * the new name shows up in every wallet display surface immediately.
 *
 * No wallet popup is required at any point — Tender's parent-owner
 * keypair signs the mint server-side. The user just clicks Claim.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckIcon, LoaderIcon, SparklesIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { suggestHandle } from '@/lib/sns/devnet/handle-suggest';
import { validateHandle } from '@/lib/sns/devnet/handle-validation';
import { cn } from '@/lib/utils';

const DEBOUNCE_MS = 400;

type AvailabilityState =
  | { kind: 'idle' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'checking' }
  | { kind: 'available'; normalized: string }
  | { kind: 'taken' }
  | { kind: 'error'; reason: string };

export interface ClaimIdentityModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful mint with the fully-qualified name. */
  onClaimed?: (fullName: string) => void;
}

export function ClaimIdentityModal({
  open,
  onOpenChange,
  onClaimed,
}: ClaimIdentityModalProps) {
  const router = useRouter();
  const [handle, setHandle] = useState('');
  const [availability, setAvailability] = useState<AvailabilityState>({ kind: 'idle' });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Track the latest in-flight check so older responses can't overwrite
  // newer state if they land out-of-order.
  const checkSeqRef = useRef(0);

  // Reset state on close so a future re-open is fresh.
  useEffect(() => {
    if (!open) {
      setHandle('');
      setAvailability({ kind: 'idle' });
      setSubmitting(false);
      setSubmitError(null);
    }
  }, [open]);

  // Debounced availability check. Fires whenever `handle` changes; the
  // first thing it does is sync-validate, so we never burn an RPC call
  // on input that's lexically invalid.
  useEffect(() => {
    if (handle.trim().length === 0) {
      setAvailability({ kind: 'idle' });
      return;
    }
    const validated = validateHandle(handle);
    if (!validated.ok) {
      setAvailability({ kind: 'invalid', reason: validated.reason });
      return;
    }
    setAvailability({ kind: 'checking' });
    const seq = ++checkSeqRef.current;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/identity/check-handle?handle=${encodeURIComponent(validated.normalized)}`,
        );
        if (seq !== checkSeqRef.current) return; // stale, newer check ran
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { reason?: string };
          setAvailability({ kind: 'invalid', reason: body.reason ?? 'invalid handle' });
          return;
        }
        const body = (await res.json()) as { available: boolean; normalized: string };
        setAvailability(
          body.available
            ? { kind: 'available', normalized: body.normalized }
            : { kind: 'taken' },
        );
      } catch (e) {
        if (seq !== checkSeqRef.current) return;
        setAvailability({ kind: 'error', reason: (e as Error).message });
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [handle]);

  const canSubmit = useMemo(
    () => availability.kind === 'available' && !submitting,
    [availability, submitting],
  );

  async function handleSubmit() {
    if (availability.kind !== 'available') return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch('/api/identity/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: availability.normalized }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        fullName?: string;
        error?: string;
        existing?: string;
      };
      if (!res.ok || !body.ok) {
        // 409 with `existing` means the wallet already claimed - close
        // the modal and treat as "you already have one" rather than an
        // error; refresh so the existing name shows up.
        if (res.status === 409 && body.existing) {
          onOpenChange(false);
          router.refresh();
          return;
        }
        // 409 without `existing` means the requested handle was just
        // claimed by someone else between our check + the mint. Bump
        // availability so the user sees "taken" and picks again.
        if (res.status === 409) {
          setAvailability({ kind: 'taken' });
          return;
        }
        throw new Error(body.error ?? `claim failed (${res.status})`);
      }
      onClaimed?.(body.fullName!);
      onOpenChange(false);
      // Force a refresh so server components re-fetch with the new name.
      router.refresh();
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    // disablePointerDismissal: outside-click is too easy to fire accidentally
    // for a one-shot onboarding modal. Only the X button + "Maybe later"
    // close it. Escape key still works (good for keyboard accessibility).
    <Dialog open={open} onOpenChange={onOpenChange} disablePointerDismissal>
      <DialogContent className="max-w-md gap-5">
        <DialogHeader>
          <DialogTitle>Pick your tendr identity</DialogTitle>
          <DialogDescription>
            Your handle becomes a `.tendr.sol` SNS name owned by your
            wallet. It's your shareable buyer + provider identity on
            tendr.bid — reputation accrues to this name on chain and
            travels with you across every Solana app that resolves SNS.
            We cover the rent; you don't sign anything.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Input
                autoFocus
                value={handle}
                placeholder="yourhandle"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                onChange={(e) => setHandle(e.target.value.toLowerCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canSubmit) handleSubmit();
                }}
                aria-invalid={
                  availability.kind === 'invalid' || availability.kind === 'taken'
                    ? true
                    : undefined
                }
                className="pr-24"
              />
              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground tabular-nums">
                .tendr.sol
              </span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={submitting}
              onClick={() => setHandle(suggestHandle())}
              title="Suggest a random handle"
            >
              <SparklesIcon className="size-3.5" />
              Suggest
            </Button>
          </div>

          <AvailabilityLine state={availability} />
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            Maybe later
          </Button>
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {submitting && <LoaderIcon className="size-3.5 animate-spin" />}
            {submitting ? 'Claiming…' : 'Claim'}
          </Button>
        </div>

        {submitError && (
          <p className="text-xs text-destructive">{submitError}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AvailabilityLine({ state }: { state: AvailabilityState }) {
  if (state.kind === 'idle') {
    return (
      <p className="text-xs text-muted-foreground">
        3-20 characters · lowercase letters, numbers, hyphens · not starting or ending with a hyphen
      </p>
    );
  }
  const Icon =
    state.kind === 'checking'
      ? LoaderIcon
      : state.kind === 'available'
        ? CheckIcon
        : XIcon;
  const tone = state.kind === 'available'
    ? 'text-emerald-600 dark:text-emerald-400'
    : state.kind === 'checking'
      ? 'text-muted-foreground'
      : 'text-destructive';
  const text =
    state.kind === 'checking'
      ? 'Checking availability…'
      : state.kind === 'available'
        ? `${state.normalized}.tendr.sol is yours to claim`
        : state.kind === 'taken'
          ? 'Already taken — pick another'
          : state.kind === 'invalid'
            ? state.reason
            : `Couldn't check (${state.reason})`;
  return (
    <p className={cn('flex items-center gap-1.5 text-xs', tone)}>
      <Icon className={cn('size-3.5', state.kind === 'checking' && 'animate-spin')} />
      {text}
    </p>
  );
}
