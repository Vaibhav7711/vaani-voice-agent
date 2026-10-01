# Vaani Loan Service

An end-to-end, entity-safe loan-servicing voice-agent prototype for Indian telephony workflows. It uses fictional customer data only.

## Current vertical slice

- Persistent WebSocket session for text, PCM audio, agent events, and telemetry
- 16 kHz mono PCM capture in 20 ms frames with server-side VAD
- Replaceable external streaming ASR/TTS bridge with browser ASR/TTS fallback
- Kaggle GPU speech workload using Whisper large-v3-turbo and AI4Bharat Indic Parler-TTS
- Constrained intent planner with deterministic fallback and policy overrides
- PostgreSQL session persistence with Redis cache and distributed per-session locks
- OTP-gated customer context (demo OTP: `482931`)
- Three-attempt OTP lockout and safe human handoff
- Guarded loan-summary and payment-link tool calls
- Hindi/Hinglish-aware response selection
- Deterministic safety policy and human escalation
- Per-session audit timeline designed for future observability ingestion

## Run locally

This repository needs Node.js 20 or newer.

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000`. The custom server is required because it hosts both Next.js and `/api/realtime` on the same port. Without an external inference provider, audio is still streamed and measured while browser speech recognition supplies transcripts.

Copy `.env.example` to `.env.local` only when connecting an inference service. See [the realtime provider contract](docs/realtime-protocol.md).

### Kaggle GPU speech inference

The complete Kaggle workload is in [`kaggle/vaani_kaggle.py`](kaggle/vaani_kaggle.py), with setup instructions in [`kaggle/README.md`](kaggle/README.md). It runs authenticated ASR and TTS behind the existing provider contract, so no borrower data or lender credentials are sent to the speech model. Kaggle is intentionally treated as an R&D/live-demo GPU environment rather than permanent hosting because notebook sessions are time-limited.

### Durable local infrastructure

When Docker is available:

```bash
docker compose up -d postgres redis
cp .env.example .env.local
# Set DATABASE_URL and REDIS_URL to the Compose URLs shown in .env.example.
# Generate SESSION_ENCRYPTION_KEY with: openssl rand -base64 32
pnpm dev
```

Without `DATABASE_URL`, the runtime deliberately uses an in-memory repository and local per-session lock. When PostgreSQL is enabled, `SESSION_ENCRYPTION_KEY` is mandatory and session payloads are encrypted with AES-256-GCM before being written to PostgreSQL or Redis. `/api/health` reports the active store, cache, and planner status.

### Constrained planner

Set `LLM_BASE_URL` and `LLM_MODEL` to an OpenAI-compatible local or hosted inference endpoint. The model can return only one of four validated intents: `loan_summary`, `payment_link`, `handoff`, or `clarify`. It never sees lender credentials, cannot provide tool arguments, and does not generate customer-facing financial responses. Payment-link actions still require explicit payment language in the caller's original utterance.

## Architecture direction

Financial tools and customer-facing responses remain deterministic. The model is isolated to constrained intent classification, and policy checks can downgrade its result before any tool executes. PostgreSQL/Redis adapters become active only when their URLs are configured.
