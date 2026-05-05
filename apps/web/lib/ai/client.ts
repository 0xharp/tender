'use client';

/**
 * QVAC client — thin OpenAI SDK wrapper pointed at our local-first LLM
 * sidecar (apps/ai-sidecar/). Browser-side only; the request/response
 * payloads never touch Tendr's Next.js server.
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
 */
export function getQvacClient(): OpenAI | null {
  const baseURL = getQvacBaseUrl();
  if (!baseURL) return null;
  return new OpenAI({
    baseURL,
    // QVAC's serve doesn't require auth in the default config we ship.
    // The OpenAI SDK still wants a non-empty string here.
    apiKey: process.env.NEXT_PUBLIC_QVAC_API_KEY ?? 'qvac-no-auth',
    dangerouslyAllowBrowser: true,
  });
}

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
  // 7B Q4 at this ctx is fast enough to allow generous responses.
  // Bid comparison is the longest output and benefits from headroom.
  max_tokens: 2048,
} as const;
