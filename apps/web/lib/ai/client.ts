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
 * Custom `fetch` wrapper: the OpenAI SDK auto-injects telemetry headers
 * (x-stainless-os, x-stainless-arch, x-stainless-package-version, …)
 * on every request. QVAC's `serve --cors` enables CORS but its
 * Access-Control-Allow-Headers allowlist doesn't include the stainless
 * prefix — the browser preflight rejects the request before it even
 * leaves. We strip every `x-stainless-*` header in a wrapped fetch so
 * the preflight only sees Content-Type + Authorization, which QVAC
 * does allow. Same outcome as if the SDK never injected them in the
 * first place; the stripped headers were observability metadata that
 * QVAC doesn't read anyway.
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
    fetch: stripStainlessHeadersFetch,
  });
}

/**
 * Wrapped global fetch: deletes any `x-stainless-*` request header
 * before sending. Required so the browser's CORS preflight stays
 * within QVAC's Access-Control-Allow-Headers allowlist (which only
 * permits Content-Type + Authorization).
 */
const stripStainlessHeadersFetch: typeof fetch = (input, init) => {
  if (init?.headers) {
    const cleaned = new Headers(init.headers);
    for (const key of Array.from(cleaned.keys())) {
      if (key.toLowerCase().startsWith('x-stainless-')) cleaned.delete(key);
    }
    init = { ...init, headers: cleaned };
  }
  return fetch(input as RequestInfo, init);
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
