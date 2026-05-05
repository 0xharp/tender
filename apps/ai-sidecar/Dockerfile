# Tendr AI sidecar — QVAC LLM serving via OpenAI-compatible HTTP API.
# Built for deployment on Nosana GPU nodes; also runs locally.
#
# What this container does:
#   1. Bare runtime (QVAC's required JS runtime)
#   2. @qvac/cli + @qvac/sdk + @qvac/llm-llamacpp
#   3. `qvac serve openai` exposes /v1/chat/completions on port 11434
#   4. Model (Qwen 2.5 7B Instruct Q4_K_M) preloaded at boot
#
# Browser → this container directly. Tendr's Next.js server is NOT in
# the path; the only thing on this Nosana node is the inference engine.

FROM node:22-bookworm-slim AS base

# ─── system deps ──────────────────────────────────────────────────────────────
# Bare native modules need build-essential + python at install time. curl for
# model download. tini gives us PID 1 + signal handling so qvac shuts down
# cleanly when Nosana stops the deployment.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      python3 \
      curl \
      ca-certificates \
      tini \
    && rm -rf /var/lib/apt/lists/*

# Bare runtime — QVAC requires Bare ≥ 1.24
RUN npm install -g bare@^1.24 @qvac/cli@latest

WORKDIR /app

# ─── deps install ─────────────────────────────────────────────────────────────
# Copy only package.json first so this layer caches when only the model
# config changes.
COPY package.json ./
RUN npm install --omit=dev

# ─── model + config ───────────────────────────────────────────────────────────
COPY qvac.config.json ./

# We DON'T bake the model into the image — QVAC's loader resolves the
# `QWEN3_4B_Q4_K_M` constant in qvac.config.json to its own registry
# download URL on first preload. Tradeoff: smaller image (~700 MB
# instead of ~3 GB), ~30s cold-start delay on the first container boot
# while the model downloads (subsequent restarts on the same Nosana
# host hit the local cache). Acceptable for the demo; revisit if cold
# starts become painful at scale.

# ─── runtime ──────────────────────────────────────────────────────────────────
EXPOSE 11434

# Health check: the OpenAI-compatible /v1/models endpoint should return 200
# once the model is loaded. Use a generous start_period so model preload has
# time to finish on cold boot.
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD curl -fsS http://localhost:11434/v1/models > /dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]

# --cors lets the buyer's browser hit this directly (no preflight rejection).
# --host 0.0.0.0 binds to all interfaces inside the container; Nosana exposes
# port 11434 to the public via its own ingress.
CMD ["qvac", "serve", "openai", \
     "--cors", \
     "--host", "0.0.0.0", \
     "--port", "11434", \
     "--config", "/app/qvac.config.json"]
