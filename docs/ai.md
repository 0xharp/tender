# AI on tendr.bid (powered by QVAC)

Tendr ships three AI surfaces — RFP scope drafting, bid drafting, and post-decrypt bid comparison — using [Tether QVAC](https://qvac.tether.io/) as the inference engine. Same workflow shape as ChatGPT-style "draft this for me", but the bytes never leave for OpenAI / Anthropic / Google. They go from your browser straight to a QVAC sidecar we operate ourselves.

## Where the AI shows up

| Surface | Who uses it | What it does |
|---|---|---|
| RFP create → **Draft with AI** button next to *Scope summary* | Buyer | Type a paragraph describing what you need; QVAC returns a structured scope (objectives, deliverables, milestones, success criteria) you can edit before posting. |
| Bid composer → **Start drafting bid with AI** button next to *Scope* | Provider | Reads the RFP scope + your optional context (tech stack, target price, timeline). Returns a complete bid draft — price, timeline, scope markdown, and a populated milestones array with acceptance criteria. Every field of the bid form gets filled in on accept. |
| Award screen → **Compare bids with AI** button under the decrypted bid list | Buyer | After you've decrypted the sealed bids, QVAC generates a side-by-side comparison table + recommends a winner with reasoning. |

All three buttons hide themselves automatically when the QVAC sidecar URL isn't configured (`NEXT_PUBLIC_QVAC_BASE_URL`). The rest of the product works identically without AI — nothing in the bidding, awarding, escrow, milestone, or reputation flows depends on AI being present.

## How it works

1. **Your browser** calls the QVAC sidecar directly over HTTPS.
2. **The QVAC sidecar** is a small process running [QVAC](https://qvac.tether.io/) on the [Bare runtime](https://bare.pears.com/), exposing an OpenAI-compatible HTTP server (`POST /v1/chat/completions`). It loads the [Qwen3 4B Instruct (Q4_K_M quant)](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507-GGUF) model into a single dedicated GPU and runs inference there.
3. **The response** comes back to your browser. The sidecar holds no per-user state — request in, response out.

```
Your browser  ───────HTTPS──────▶  QVAC sidecar (Nosana GPU)
              ◀──────HTTPS──────
              (decrypted bids)        (Qwen3 4B Instruct Q4_K_M
              (RFP scope, etc.)        via QVAC's OpenAI-compatible server)
```

What's **not** in this path:
- Tendr's Next.js server (we never see the prompts or responses).
- Any closed AI provider (OpenAI, Anthropic, Google, etc.).
- Any multi-tenant inference API.

## Why "OpenAI-compatible" doesn't mean OpenAI

QVAC's serve mode speaks the same wire format as OpenAI's official API (`POST /v1/chat/completions` with the same JSON schema). That's so we can use the standard `openai` npm package on the client without writing custom QVAC code. **The bytes don't leave for openai.com.** The protocol shape is mimicked; the destination is our sidecar's URL.

Same idea as "S3-compatible storage" — the API is mimicked but the bytes go to whoever's storage is configured, not to AWS.

## The privacy story (what we actually deliver)

Here's the architecture, with no embellishment:

- **No closed AI providers in the pipeline.** The model is open-weight (Qwen3 4B Instruct, Q4_K_M) and the inference engine is QVAC. No OpenAI API key, no Anthropic API key, no third-party AI vendor's data-collection policy applies.
- **Tendr backend never sees AI data.** The browser hits the Nosana endpoint directly via the env var `NEXT_PUBLIC_QVAC_BASE_URL`. There is no Tendr API route that proxies the call. Our Vercel servers — where wallet sessions, RFP metadata, and bid index live — never see prompts, decrypted bid plaintexts, or the model's response. Verifiable by reading [`apps/web/lib/ai/client.ts`](https://github.com/0xharp/tender/blob/main/apps/web/lib/ai/client.ts) — the OpenAI client's `baseURL` points at the Nosana endpoint, not at any `/api/*` Tendr path.
- **Single-tenant inference.** The Nosana GPU is a dedicated container running our QVAC image. Not a multi-tenant inference API serving 50 other apps. No prompt-mixing.

What we are NOT claiming:

- ❌ NOT local-first inference for end users. The model runs on a Nosana GPU we operate, not on your laptop. Running a 4B-parameter model on a buyer's browser isn't realistic today.
- ❌ NOT zero trust. You're trusting our Nosana deployment instead of trusting OpenAI's data policies. Different threat model, real privacy improvement, not "no trust required".
- ❌ NOT an escape hatch for individual users to swap to their own local QVAC. Tendr is a hosted consumer app — env vars are baked into the Vercel build, end users can't reroute the AI calls without forking and self-deploying the entire app.

## Comparison vs. the alternatives

| Setup | Where bid plaintext lives | Privacy strength |
|---|---|---|
| Browser → OpenAI API | Buyer's machine + OpenAI's data centers + their training set if you don't opt out | Weakest |
| Browser → Tendr backend → some AI provider | Buyer's machine + Tendr's servers + the AI provider's servers | Worse than today's setup |
| **Browser → QVAC sidecar on Nosana (today's setup)** | Buyer's machine + our dedicated Nosana node | **Strong — open-weight model on infra we run; no closed AI provider; Tendr backend out of the loop** |

## What the AI is good at + not good at

**Good at:** structured tasks with clear inputs and a known output shape.
- Drafting RFP scopes from a few sentences of intent
- Drafting starting-point bids that respect the provider's stated context (tech stack, target price, timeline)
- Comparing decrypted bids on observable dimensions (price, timeline, scope coverage, milestone realism, risk flags)

**Not good at:**
- Replacing your judgment about counterparties — the recommended winner is a starting point, not a decision
- Niche technical evaluation outside the model's training data
- Pricing on rare specialties (the model's training data on, say, M&A advisory or quant trading audits is uneven)

The right mental model: a structured-output assistant. Treat its output as a draft you'll always edit.

## What we don't do

- **No AI signing.** The model never signs a transaction, never moves money, never touches the on-chain side. It only reads inputs and returns text.
- **No required AI for product behavior.** Every flow that has an AI button works identically without it — bidding, awarding, escrow, milestones, reputation are all independent.
- **No conversation history.** Each AI call is a one-shot completion. The sidecar holds no per-user state between requests.

## Reference

- [`apps/ai-sidecar/`](https://github.com/0xharp/tender/tree/main/apps/ai-sidecar) — QVAC sidecar source (Bare runtime + `qvac serve openai` + Qwen3 4B Q4_K_M via the model registry)
- [`apps/ai-sidecar/Dockerfile`](https://github.com/0xharp/tender/blob/main/apps/ai-sidecar/Dockerfile) — container build for Nosana GPU deploy (Vulkan + NVIDIA runtime)
- [`apps/ai-sidecar/qvac.config.json`](https://github.com/0xharp/tender/blob/main/apps/ai-sidecar/qvac.config.json) — model + serve config
- [`apps/web/lib/ai/client.ts`](https://github.com/0xharp/tender/blob/main/apps/web/lib/ai/client.ts) — browser-side OpenAI SDK wrapper pointed at the sidecar URL
- [`apps/web/lib/ai/prompts.ts`](https://github.com/0xharp/tender/blob/main/apps/web/lib/ai/prompts.ts) — system prompts for the three AI surfaces
- [`apps/web/lib/ai/types.ts`](https://github.com/0xharp/tender/blob/main/apps/web/lib/ai/types.ts) — Zod schemas + tolerant parsers for the structured bid-draft and bid-comparison responses
- [`apps/web/components/ai/ai-draft-modal.tsx`](https://github.com/0xharp/tender/blob/main/apps/web/components/ai/ai-draft-modal.tsx) — the "draft something with AI" modal (RFP scope + provider bid)
- [`apps/web/components/ai/ai-bid-comparison-panel.tsx`](https://github.com/0xharp/tender/blob/main/apps/web/components/ai/ai-bid-comparison-panel.tsx) — the comparison table that appears post-decrypt
- QVAC: <https://qvac.tether.io/>
- Nosana: <https://nosana.com/>
