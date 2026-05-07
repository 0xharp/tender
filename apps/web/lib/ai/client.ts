'use client';

/**
 * QVAC client — thin OpenAI SDK wrapper pointed at our QVAC Private AI
 * sidecar (apps/ai-sidecar/). Browser-side only; the request/response
 * payloads never touch Tendr's Next.js server and no closed AI provider
 * (OpenAI, Anthropic, etc.) is in the pipeline.
 *
 * Why this lives in `'use client'`:
 *   The whole point of the architecture is that the buyer's decrypted
 *   bid plaintexts go directly from their browser to the QVAC sidecar
 *   on Nosana. If we routed through a Next.js API route, our backend
 *   would briefly hold the plaintext in memory — which would weaken
 *   the privacy story for no architectural benefit. So this is a
 *   client-only module.
 *
 * Why `dangerouslyAllowBrowser: true`:
 *   The `openai` package gates browser usage behind a flag because
 *   the typical OpenAI workflow exposes a real API key. We're not
 *   doing that. Our `baseURL` points at OUR sidecar, our `apiKey` is
 *   either empty or a non-secret demo key. The flag is required to
 *   suppress the runtime warning, not because we're being dangerous.
 *
 * Privacy model in one sentence: the only servers that see decrypted
 * bid contents are (a) the buyer's browser (where decryption happens)
 * and (b) the QVAC sidecar at NEXT_PUBLIC_QVAC_BASE_URL (which is
 * either localhost or our Nosana node — anything in between is
 * deliberately excluded).
 */

import OpenAI from 'openai';

/** Returns null if the AI sidecar isn't configured — UI surfaces should
 *  hide AI buttons in that case rather than showing a broken state. */
export function getQvacBaseUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_QVAC_BASE_URL;
  if (!url || url.trim() === '') return null;
  return url.replace(/\/+$/, '');
}

/** True if the AI sidecar URL is set in env. Cheap predicate for UI
 *  components that want to render an AI button conditionally. */
export function isAiAvailable(): boolean {
  return getQvacBaseUrl() !== null;
}

/**
 * Build an OpenAI SDK client pointed at the QVAC sidecar. Returns null
 * if the sidecar URL isn't configured (caller should treat AI as
 * unavailable). The model alias `tendr-llm` matches the `serve.models`
 * key in `apps/ai-sidecar/qvac.config.json`.
 *
 * The custom `fetch` wrapper turns every outgoing call into a CORS
 * "simple request" — see {@link makeRequestSimple} for the why. Without
 * this, mobile webviews (Phantom in-app browser observed) silently drop
 * cross-origin POSTs to the Nosana endpoint at preflight time.
 */
export function getQvacClient(): OpenAI | null {
  const baseURL = getQvacBaseUrl();
  if (!baseURL) return null;
  return new OpenAI({
    baseURL,
    // QVAC's serve doesn't require auth in the default config we ship.
    // The OpenAI SDK still wants a non-empty string here, but we strip
    // the resulting Authorization header in the fetch wrapper below
    // (Authorization triggers a CORS preflight; we want simple requests).
    apiKey: process.env.NEXT_PUBLIC_QVAC_API_KEY ?? 'qvac-no-auth',
    dangerouslyAllowBrowser: true,
    fetch: makeRequestSimple,
  });
}

/**
 * Wrapped global fetch that turns the OpenAI SDK's POST into a CORS
 * "simple request" so it bypasses the preflight entirely.
 *
 * CORS spec: a request is "simple" (no preflight OPTIONS) if it has no
 * custom headers and a `Content-Type` of `application/x-www-form-urlencoded`,
 * `multipart/form-data`, or `text/plain`. Anything outside that list —
 * `application/json`, `Authorization: Bearer …`, `x-stainless-*` — forces
 * a preflight, which mobile webviews reject more aggressively than
 * desktop Chrome (Phantom in-app browser observed: preflight passes on
 * desktop Chrome but is silently dropped on mobile, even though QVAC's
 * server returns proper CORS headers).
 *
 * To make every request "simple":
 *
 *   1. Swap `Content-Type: application/json` → `text/plain;charset=UTF-8`.
 *      QVAC's OpenAI-compatible server parses the body as JSON regardless
 *      of Content-Type — it just tries `JSON.parse(body)`, which works
 *      because the SDK has already serialized the body to a JSON string.
 *
 *   2. Strip `Authorization`. QVAC's `serve openai --cors` config (see
 *      `apps/ai-sidecar/qvac.config.json`) has no auth requirement, so
 *      the `Bearer qvac-no-auth` value the SDK injects is decorative.
 *      Removing it eliminates the second preflight trigger.
 *
 *   3. Strip `x-stainless-*` (telemetry the SDK injects unconditionally).
 *
 * Net result: the browser ships the POST as-is, no OPTIONS roundtrip,
 * no allowlist check. Works identically on desktop Chrome and mobile
 * webview. Same end-to-end privacy story (browser → Nosana, no Tendr
 * server in the path).
 */
const makeRequestSimple: typeof fetch = (input, init) => {
  if (!init?.headers) return fetch(input as RequestInfo, init);
  const headers = new Headers(init.headers);
  // Strip everything that would trigger a preflight.
  for (const key of Array.from(headers.keys())) {
    if (key.toLowerCase().startsWith('x-stainless-')) headers.delete(key);
  }
  headers.delete('authorization');
  // Force Content-Type into the CORS-simple allowlist. Body is already
  // a JSON string from the SDK; QVAC parses it regardless of label.
  headers.set('Content-Type', 'text/plain;charset=UTF-8');
  return fetch(input as RequestInfo, { ...init, headers });
};

/** Model alias declared in qvac.config.json. Single source of truth so
 *  every AI surface uses the same model. */
export const TENDR_MODEL_ALIAS = 'tendr-llm';

/**
 * Standard temperature + max_tokens for tendr's AI surfaces. Low
 * temperature (deterministic, structured output) — these aren't
 * creative-writing tasks, they're "give me a structured RFP scope" /
 * "compare these bids" / "draft a starting bid." Low temp also reduces
 * the chance of the model going off-format and breaking the JSON
 * parser downstream.
 */
export const DEFAULT_GEN_PARAMS = {
  temperature: 0.2,
  // ~1100 tokens ≈ ~4400 chars in English (1 tok ≈ 4 chars). The two
  // markdown surfaces (scope drafting + bid drafting) feed into form
  // fields capped at 4000 chars, and the prompts ask for 3500 chars
  // max — this token cap is a backstop so a chatty model can't blow
  // past the field limit. Bid comparison overrides this with a higher
  // cap because structured JSON for N bids legitimately runs longer.
  max_tokens: 1100,
} as const;
