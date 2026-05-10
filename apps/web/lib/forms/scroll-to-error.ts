import type { FieldErrors, FieldValues } from 'react-hook-form';

/**
 * react-hook-form `handleSubmit` invalid-submit callback that scrolls
 * the first errored field into view + focuses it.
 *
 * Without this, hitting Submit when a required field is empty silently
 * marks the field red — but if it's offscreen (long form), the user
 * doesn't notice and assumes nothing happened. Scrolling brings the
 * blocker into view immediately.
 *
 * Strategy: walk the errors object in declaration order (which RHF
 * preserves), grab the FIRST key, then query the DOM for the matching
 * `name=` attribute. Falls back gracefully if the field name uses dots
 * (nested fields) by trying both the full path and the leaf segment.
 *
 * Usage: `form.handleSubmit(onSubmit, scrollToFirstError)`
 */
export function scrollToFirstError<T extends FieldValues>(errors: FieldErrors<T>): void {
  const keys = collectErrorKeys(errors);
  if (keys.length === 0) return;
  const firstKey = keys[0];
  if (!firstKey) return;

  // Try the full path first (e.g. `milestones.0.amountUsdc`), then the
  // last segment (e.g. `amountUsdc`) since some custom inputs strip the
  // path prefix when registering. For each candidate, try `[name=...]`
  // (real form inputs registered via RHF) AND `[id=...]` as a fallback —
  // controlled wrappers like `<Select>` only render an `id` on their
  // trigger because they aren't a real `<input>` underneath, and their
  // RHF integration goes through `setValue` not `register`. Without the
  // id fallback, scroll silently fails and the user thinks the submit
  // did nothing because the error message is offscreen.
  const candidates = [firstKey, firstKey.split('.').pop() ?? firstKey];
  for (const candidate of candidates) {
    const escaped = cssEscape(candidate);
    const el =
      document.querySelector<HTMLElement>(`[name="${escaped}"]`) ??
      document.querySelector<HTMLElement>(`[id="${escaped}"]`);
    if (!el) continue;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Focus after scroll so screen readers announce the error context.
    // setTimeout 0 lets the smooth-scroll start before focus steals the
    // viewport position. Try-catch because some custom inputs aren't
    // focusable directly.
    setTimeout(() => {
      try {
        el.focus({ preventScroll: true });
      } catch {
        /* non-focusable element — scroll alone is enough */
      }
    }, 0);
    return;
  }
}

function collectErrorKeys(errors: unknown, prefix = ''): string[] {
  if (errors == null || typeof errors !== 'object') return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(errors as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    // Leaf error — RHF tags errors with `{ message, type, ref? }`.
    if (
      value &&
      typeof value === 'object' &&
      'message' in (value as Record<string, unknown>) &&
      typeof (value as { message: unknown }).message === 'string'
    ) {
      out.push(path);
      continue;
    }
    // Nested errors (object or array of errors) — recurse.
    if (value && typeof value === 'object') {
      out.push(...collectErrorKeys(value, path));
    }
  }
  return out;
}

/** Minimal CSS attribute-value escape so `name`s containing brackets or
 *  dots don't break the selector. Sufficient for RHF field names. */
function cssEscape(value: string): string {
  return value.replace(/[\\"]/g, '\\$&');
}
