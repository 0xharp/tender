# AI on tendr.bid (QVAC)

> Three buttons across the app — **Draft scope with AI** on the RFP create form, **Compare bids with AI** on the buyer's award screen, **Draft starting bid with AI** in the bid composer. All three run on a local-first LLM (Tether QVAC), called directly from your browser. No third-party AI provider sees your data.

## Where the AI shows up

| Surface | Who uses it | What it does |
|---|---|---|
| RFP create → "Draft with AI" button next to **Scope summary** | Buyer | Type a paragraph describing what you need; AI returns a structured scope (objectives, deliverables, milestones, success criteria) you can edit before posting. |
| Award screen → "Compare bids with AI" button under the decrypted bid list | Buyer | After you've decrypted the sealed bids, AI generates a side-by-side comparison table + recommends a winner with reasoning. |
| Bid composer → "Draft starting bid with AI" button next to **Scope** | Provider | AI reads the RFP scope and proposes a starting-point bid (price, timeline, milestones). Edit before submitting. |

All three buttons hide themselves automatically when the AI sidecar isn't configured — the rest of the product works identically without AI.

## How it works (the short version)

1. **Your browser** calls the QVAC sidecar directly over HTTPS.
2. **The QVAC sidecar** is a small process running [Tether QVAC](https://qvac.tether.io)'s OpenAI-compatible HTTP server. It loads a Qwen 2.5 7B Instruct (4-bit quantized) model from disk and runs inference on the GPU.
3. **The response** comes back to your browser. The buyer's bid plaintexts (or RFP scope, or whatever you sent) never persist anywhere — request in, response out.

```
Your browser  ───────HTTPS──────▶  QVAC sidecar (Nosana GPU)
              ◀──────HTTPS──────
              (decrypted bids)        (Qwen 2.5 7B,
              (RFP scope, etc.)        local llama.cpp inference)
```

What's **not** in this path: Tendr's Next.js server, OpenAI's API, Anthropic's API, any cloud AI provider, Tether's servers.

## Why "OpenAI-compatible" doesn't mean OpenAI

QVAC's HTTP server speaks the same API shape as OpenAI's official API (`POST /v1/chat/completions` with the same JSON schema). That's so we can use the standard `openai` npm package on the client side without writing custom QVAC client code. **The bytes never leave for openai.com.** The shape is mimicked; the destination is our infrastructure.

Same idea as "S3-compatible storage" — that's anyone's storage that mimics S3's API. The bytes don't go to AWS.

## The privacy story, honestly

Tendr's existing privacy stack (sealed bids, ephemeral wallets, etc.) is unchanged by AI. The thing the AI integration adds is one new question: **where do decrypted bid contents go when the buyer clicks "Compare with AI"?**

Answer: from the buyer's browser straight to **our** Tendr-operated QVAC sidecar (a Docker container we run on Nosana GPU). Specifically:

- ✅ Decrypted bids do **not** touch Tendr's Next.js backend. We don't have any API route that proxies AI calls — verified by reading `apps/web/lib/ai/client.ts`: the OpenAI client's `baseURL` points at the Nosana endpoint, not at any Tendr API path.
- ✅ Decrypted bids do **not** go to OpenAI, Anthropic, or any other third-party AI provider. The entire inference stack is open source: QVAC's [`qvac-fabric-llm.cpp`](https://github.com/tetherto/qvac-fabric-llm.cpp) (a fork of `llama.cpp`) + the Qwen 2.5 model weights. Our Dockerfile is in the repo at `apps/ai-sidecar/Dockerfile`.
- ✅ The sidecar doesn't log or persist the bid contents anywhere. Request → inference → response → done.
- ⚠️ Decrypted bids **do** leave the buyer's browser to reach the sidecar. This is a real change from "AI = nothing leaves my machine" — and we want to be honest about it. The compromise is that running a 7B-parameter LLM on a buyer's browser is not realistic today, so the sidecar runs on infra we control rather than infra a third party controls.

Net comparison vs. the alternatives:

| Setup | Where bid plaintext lives | Privacy strength |
|---|---|---|
| Local-only sidecar (advanced users self-host) | Buyer's machine only | Maximum |
| **Tendr-hosted Nosana sidecar (default)** | Buyer's machine + our Nosana node | **Strong — open-source code on infra we run; no SaaS AI provider involved** |
| Browser → OpenAI API | Buyer's machine + OpenAI's data centers | Weakest — your bids end up in someone else's logs / training data |

For users who want strict local-only operation, the same sidecar runs on a laptop with one command (`bare apps/ai-sidecar/index.js` — see `apps/ai-sidecar/README.md`). Set `NEXT_PUBLIC_QVAC_BASE_URL=http://localhost:11434/v1` in your env and AI calls stay on your machine.

## What the AI is good at + not good at

**Good at:** structured tasks with clear inputs and a known output shape.
- Drafting RFP scopes from short descriptions
- Comparing bids on observable dimensions (price, timeline, scope coverage, milestone realism)
- Drafting starting-point bids that match an RFP's scope

**Not good at:** anything requiring real-world judgment about counterparties, niche technical evaluation, or facts the model wasn't trained on.
- Don't trust the AI's "recommended winner" without reading the bids yourself — it's a starting point, not a decision
- Don't trust price recommendations on niche or new specialties — the model's training data is uneven
- Don't paste sensitive secondary info into the AI's input fields (PII, internal docs, etc.) — the privacy guarantees above cover bid contents going through our sidecar, not arbitrary text you decide to send

## What we don't do

- **No AI key in your wallet.** The AI doesn't sign anything, doesn't move money, doesn't touch the on-chain side at all. It only reads inputs you give it and returns text.
- **No required AI for product behavior.** Every flow that has an AI button works identically without clicking it. Bidding, awarding, escrow, milestones, reputation — all unchanged.
- **No conversation history.** Each AI call is a one-shot completion. The sidecar holds no per-user state.
- **No third-party AI provider.** Discussed above; named here so it's a one-line claim too.

## Reference

- `apps/ai-sidecar/` — the QVAC sidecar (Bare runtime + `qvac serve openai` + Qwen 2.5 7B Q4)
- `apps/ai-sidecar/Dockerfile` — full container build for Nosana GPU deploy
- `apps/web/lib/ai/client.ts` — browser-side OpenAI SDK pointed at the sidecar URL
- `apps/web/lib/ai/prompts.ts` — system prompts for the three AI surfaces
- `apps/web/lib/ai/types.ts` — JSON-schema parsing for the bid-comparison response
- `apps/web/components/ai/ai-draft-modal.tsx` — the "draft something" modal (RFP scope + provider bid)
- `apps/web/components/ai/ai-bid-comparison-panel.tsx` — the comparison table that appears after decrypt
- QVAC docs: <https://docs.qvac.tether.io>
- Nosana docs: <https://learn.nosana.com>
