# tendr ai-sidecar — QVAC LLM serving

Private AI sidecar for tendr.bid, powered by [Tether QVAC](https://qvac.tether.io). Exposes an OpenAI-compatible HTTP API on port `11434`. The web app's browser code calls this endpoint directly — Tendr's Next.js server is intentionally NOT in the AI data path, and no closed AI provider (OpenAI, Anthropic, etc.) is in the pipeline.

## What's in here

| File | Purpose |
|---|---|
| `package.json` | Bare-runtime deps: `@qvac/sdk`, `@qvac/cli`, `@qvac/llm-llamacpp`, `@qvac/dl-filesystem` |
| `qvac.config.json` | One model alias (`tendr-llm`) → Qwen 3 4B Q4_K_M (largest Qwen3 in QVAC's registry). Preloaded at boot. |
| `Dockerfile` | Bare runtime + QVAC. Model downloaded on first boot via QVAC's registry (~30s cold start). Built for Nosana GPU deploy. |

## Run locally

Requires [Bare runtime](https://bare.pears.com) v1.24+ installed globally.

```bash
# from the monorepo root
cd apps/ai-sidecar
npm install
qvac serve openai --cors --host 0.0.0.0 --port 11434
```

First boot downloads ~2.5 GB of model weights (Qwen 3 4B Q4_K_M) to `~/.qvac/models/` (one-time). Subsequent boots are fast.

Smoke-test:
```bash
curl http://localhost:11434/v1/models
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "tendr-llm",
    "messages": [{"role":"user","content":"Hello"}]
  }'
```

In the Next.js app, set:
```
NEXT_PUBLIC_QVAC_BASE_URL=http://localhost:11434/v1
```

## Deploy to Nosana (GPU)

The repo deploys as a single container — no orchestration needed.

1. **Build the image** (locally or in CI):
   ```bash
   docker build -t tendr-ai-sidecar:latest apps/ai-sidecar
   ```
2. **Push to a registry** Nosana can pull from (Docker Hub, GHCR, etc.):
   ```bash
   docker tag tendr-ai-sidecar:latest <yourname>/tendr-ai-sidecar:latest
   docker push <yourname>/tendr-ai-sidecar:latest
   ```
3. **Create a Nosana deployment** at https://dashboard.nosana.com:
   - Template: **Custom Docker Image**
   - Image: `<yourname>/tendr-ai-sidecar:latest`
   - GPU: anything with ≥6 GB VRAM (Qwen 3 4B Q4_K_M fits in ~3-4 GB; T4 / L4 / 3060 12GB / 4080 / 4090 all work)
   - Exposed port: `11434`
   - Strategy: SIMPLE, 1 replica
4. **Copy the endpoint URL** Nosana gives you (`https://<id>.node.k8s.prd.nos.ci`)
5. **Set in `apps/web/.env.local`:**
   ```
   NEXT_PUBLIC_QVAC_BASE_URL=https://<your-id>.node.k8s.prd.nos.ci/v1
   ```

The deployment auto-starts. First request after start takes ~30-60s while QVAC downloads the model from its registry to the Nosana host's local cache; subsequent requests on that same deployment are fast (model stays in GPU memory).

## Why this architecture

- **Browser → sidecar direct.** Decrypted bid contents never touch Tendr's backend. Verified by reading the call sites in `apps/web/lib/ai/client.ts`: the OpenAI client `baseURL` points at this sidecar's URL, not at any Tendr API route.
- **OpenAI-compatible API shape.** Lets us use the standard `openai` npm package on the client side. The actual inference runs in QVAC's `qvac-fabric-llm.cpp` (their fork of llama.cpp) — no Tether server, no OpenAI server, no third-party AI provider involved at all.
- **Self-hostable.** A user who wants AI to stay strictly on their own machine sets `NEXT_PUBLIC_QVAC_BASE_URL=http://localhost:11434/v1` and runs the sidecar themselves. The same code path supports both modes.

See `docs/ai.md` (in the web app's docs registry, available at `/docs/ai`) for the user-facing privacy framing.

## Spend protection (deferred)

For the hackathon demo we deploy without API-key auth — the Nosana endpoint is public. With $20 of credit at stake the abuse risk is bounded; if needed, add `--api-key <key>` to the `qvac serve openai` command and embed a short-lived signed token issued by an `/api/ai/token` route in the web app.
