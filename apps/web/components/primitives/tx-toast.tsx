/**
 * Inline JSX for sonner toast `description`s that need to render a clickable
 * Solscan link instead of a sliced base58 string. Keeps toast styling
 * consistent with the rest of the UI.
 */
import { HashLink } from '@/components/primitives/hash-link';

export interface TxToastDescriptionProps {
  /** Transaction signature OR account address. `kind` selects link target. */
  hash: string;
  kind?: 'tx' | 'account';
  /** Optional preface text (rendered before the link). */
  prefix?: string;
  /** Optional suffix text (rendered after the link). */
  suffix?: string;
  /** Number of leading/trailing chars shown - default 8/8. */
  visibleChars?: number;
}

/** A sonner-friendly toast description with a clickable HashLink.
 *  `leading-5` matches the HashLink copy button's `size-5` so prefix/suffix
 *  text and the icon row sit on the same vertical centerline. */
export function TxToastDescription({
  hash,
  kind = 'tx',
  prefix,
  suffix,
  visibleChars = 8,
}: TxToastDescriptionProps) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs leading-5">
      {prefix && (
        <span className="inline-flex items-center leading-5 text-muted-foreground">{prefix}</span>
      )}
      <HashLink hash={hash} kind={kind} visibleChars={visibleChars} />
      {suffix && (
        <span className="inline-flex items-center leading-5 text-muted-foreground">{suffix}</span>
      )}
    </span>
  );
}
