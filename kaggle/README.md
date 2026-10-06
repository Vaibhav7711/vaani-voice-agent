# Kaggle GPU speech provider

Serves the authenticated `/realtime` WebSocket that Vaani's
`ExternalWebSocketBridge` consumes (`docs/realtime-protocol.md`), running
Whisper large-v3-turbo for ASR and AI4Bharat Indic Parler-TTS for Hindi and
Indian English on a Kaggle GPU, reached through a temporary Cloudflare tunnel.

Kaggle is the GPU R&D and live-demo environment, not a deployment: the URL dies
with the session, quota is weekly, and sessions idle out. The service itself is
deployment-neutral — see "Moving to persistent hosting".

## One-time account setup

Three browser actions. None of them put a secret on your machine.

1. **Accept the model conditions** at
   <https://huggingface.co/ai4bharat/indic-parler-tts> while signed in. A valid
   token is not sufficient: access is gated separately and the load fails
   401/403 without this.
2. **Create a Hugging Face token** (read scope) at
   <https://huggingface.co/settings/tokens>.
3. **Add it as a Kaggle Secret**: open the kernel in the editor →
   **Add-ons → Secrets** → label it exactly `HF_TOKEN`. Labels are
   case-sensitive, and a near miss such as `HF_TOKEB` reads as "no secret set".

Optionally add `VAANI_INFERENCE_TOKEN` in the same panel:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

Without it the provider generates a bearer token per run, so each restart
changes the URL **and** the token. With it, only the URL changes.

There is **no API for Kaggle Secrets** — the editor is the only place to set
them, which is why the kernel must exist before one can be attached.

Never paste either secret into a notebook cell.

## Deploying the kernel

```bash
pip install --user kaggle
export PATH="$HOME/Library/Python/3.12/bin:$PATH"
kaggle auth login            # browser flow; nothing to copy or store
```

Kaggle's 2.x client authenticates with a single API token, not the older
`kaggle.json` username/key pair. To use a token instead of OAuth, save it to
`~/.kaggle/access_token` at mode 600.

From the repository root:

```bash
python3 - <<'PY'
import json, pathlib
tpl = json.loads(pathlib.Path("kaggle/kernel-metadata.template.json").read_text())
tpl["id"] = tpl["id"].replace("YOUR_KAGGLE_USERNAME", "<your-username>")
pathlib.Path("kaggle/kernel-metadata.json").write_text(json.dumps(tpl, indent=2) + "\n")
PY

kaggle kernels push -p "$(pwd)/kaggle"
```

`kernel-metadata.json` contains no secret — only the kernel id, the GPU and
Internet flags, and `is_private: true`.

Note that this repository has a top-level `kaggle/` directory, which shadows the
installed `kaggle` package for anything run from the repository root. Push with
an absolute `-p` path from elsewhere if an import error appears.

## Running it

**Use the editor, not `Save & Run All`.** This script starts a server that never
exits, and Kaggle makes a kernel's output retrievable only once the run
finishes — so a committed run leaves the tunnel URL unreachable for exactly as
long as it is useful. A committed run was also observed failing with
`ConnectionError` reaching the secrets service. Interactive is the supported
path.

1. Open the kernel → **Edit**
2. **Settings → Accelerator** must be a GPU. The metadata's `enable_gpu` governs
   committed runs; a draft session has its own setting.
3. Run. Expect about **90 seconds** of model loading on a cold cache:

```
secret HF_TOKEN: available (N chars)
resolved versions: {... 'protobuf': '5.29.6' ...}
gpu: Tesla T4
asr loaded in 14.0s
tts loaded in 78.0s, 1.77 GiB resident in torch
VAANI KAGGLE PROVIDER READY
  provider config : /kaggle/working/vaani-provider.txt
```

4. **Refresh the Output pane** — the config is written last, so a stale listing
   will not show it. Download `vaani-provider.txt` and save it as `.env.local`
   in the repository root.

Neither the tunnel URL nor the bearer token is printed. Kaggle saves cell output
with the notebook, so printing them would persist both into every saved and
shared copy; only 8-hex fingerprints and the token's source are logged. The file
is written at mode 0600, with a `.txt` extension because Kaggle's output browser
filters `.env` files out of the listing.

## Choosing the ASR backend

`VAANI_ASR_BACKEND` selects which recogniser runs. The choice is explicit and
never inferred from whether an adapter path happens to exist: a backend that
changes underneath you makes every recorded latency and WER incomparable to the
last run, and a silent fallback would attribute unadapted accuracy to an
adapted model.

| value | model | Hindi-adapted |
| --- | --- | --- |
| `turbo` (default) | stock Whisper large-v3-turbo | no |
| `ct2` | a CTranslate2 directory you supply via `ASR_CT2_PATH` | yes |

`ASR_COMPUTE_TYPE` defaults to `float16`; `int8_float16` is the T4 sweet spot
(int8 weights, fp16 compute) and was measured at 1.31x throughput in
indic-voice-pipeline, within a 1.6% WER tolerance.

`/health` reports the live backend, its source, compute type and whether it is
adapted, so any figure taken from this endpoint is attributable to the model
that produced it.

Misconfiguration is refused at startup rather than served: an unknown backend
name, `ct2` without a path, a path that is not a directory, and a directory
without `model.bin` all fail with the reason. That last case is the common
one — it means the merged HuggingFace checkpoint was never converted.

### Using a fine-tuned adapter from indic-voice-pipeline

faster-whisper cannot load a PEFT adapter: CTranslate2 needs merged weights in
its own format. [indic-voice-pipeline](https://github.com/Vaibhav7711/indic-voice-pipeline)
produces exactly that artifact, so the handoff is a directory rather than an
adapter name.

```bash
# in the indic-voice-pipeline checkout
python scripts/convert_ct2.py \
    --model openai/whisper-large-v3-turbo \
    --adapter <your-turbo-lora> \
    --out models/ct2/turbo-hindi \
    --quantization int8_float16
```

Attach `models/ct2/turbo-hindi` as a Kaggle Dataset, then set in the kernel:

```
VAANI_ASR_BACKEND=ct2
ASR_CT2_PATH=/kaggle/input/<dataset>/turbo-hindi
ASR_COMPUTE_TYPE=int8_float16
```

**Two blockers to know before planning on this.** The adapter published on the
Hub, `Hugme6969/whisper-medium-hindi-lora`, is trained on **whisper-medium**;
LoRA weights are shaped to their base model and cannot be moved to
large-v3-turbo. The turbo-based v2 adapter that measured 23.8% WER against
40.4% unadapted is **not obtainable** — it lives at a local path with a blank
model card, so that figure is not reproducible by anyone. Using the adapted
backend therefore means either recovering those weights or retraining on turbo.

Worth weighing against the effort: stock turbo measured 564-1048 ms here and
transcribed both test utterances correctly **including the OTP digits**, which
is the only part that gates the workflow. The adapter should improve WER on
harder Hindi; it is not what limits this deployment.

## Connecting the local app

`.env.local` is gitignored and contains exactly:

```dotenv
VOICE_INFERENCE_WS_URL=wss://<ephemeral-host>.trycloudflare.com/realtime
VOICE_INFERENCE_API_KEY=<ephemeral-token>
VOICE_INFERENCE_OUTPUT_AUDIO=true
VOICE_INFERENCE_PROVIDER_NAME=kaggle-gpu
```

Then start the app (Node 20+):

```bash
pnpm start
```

Verify without a microphone:

```bash
curl -s "$(grep VOICE_INFERENCE_WS_URL .env.local | cut -d= -f2- \
  | sed 's|wss://|https://|; s|/realtime|/health|')"

set -a; . ./.env.local; set +a
pnpm test
```

The remote tests in `tests/e2e-provider.test.ts` skip with a stated reason when
those variables are absent and run against the live provider when present. They
stream the committed English and Hindi fixtures as real 20 ms / 640-byte frames
and assert one final transcript, Devanagari in the Hindi result, non-empty
24 kHz output audio, a rejected wrong token, and barge-in suppression.

## Shutting down

Stop or interrupt the session. The `finally` block terminates cloudflared on
every exit path — an orphaned tunnel keeps a dead URL resolving, which reads as
the provider still being up. The URL and any generated token die with the
session.

## Rotating the inference token

With `VAANI_INFERENCE_TOKEN` set as a Secret: change its value in
**Add-ons → Secrets**, restart the session, and take the new
`VOICE_INFERENCE_API_KEY` from the fresh `vaani-provider.txt`.

Without it, every restart rotates the token automatically; copying the new
config file is all that is required.

## Reconnecting when the tunnel URL changes

Quick tunnels take a new hostname on every start. After any restart: download
the new `vaani-provider.txt`, save it over `.env.local`, and restart the local
app — the URL is read at startup. With a fixed token, editing the single
`VOICE_INFERENCE_WS_URL` line is enough.

## Kaggle session limits

- GPU quota is capped per week; sessions idle out after inactivity.
- A session ends on browser close, idle timeout, or maximum runtime.
- The Hugging Face cache does **not** persist between sessions, so every restart
  re-downloads both models. If restarts become frequent, attach the weights as a
  Kaggle Dataset so they are mounted rather than fetched.

## Measured performance (Tesla T4, fp16)

| stage | value |
| --- | ---: |
| Whisper load | 14.0–14.8 s |
| Indic Parler-TTS load | 70.8–78.0 s (1.77 GiB torch-resident) |
| ASR, ~5 s utterance | **942–1048 ms median** |
| **TTS, time to first audio** | **1169 ms median** |
| Agent decision | 3 ms |

Both models coexist on one 16 GB T4 with no memory pressure; neither sequential
loading nor offload was needed.

Time to first audio was **11,041 ms** before three changes, none of which touch
generation parameters, so audio quality is unchanged:

- **Paced output.** Chunks are emitted over their own 0.1 s duration rather than
  after `sleep(0)`, which wrote every chunk to the socket in milliseconds. That
  made the output a burst rather than a stream and made barge-in impossible — a
  measured run saw 158 deltas arrive *after* a cancel.
- **Sentence splitting.** Replies are synthesised a sentence at a time, so the
  caller waits for one sentence instead of the whole reply.
- **`ParlerTTSStreamer`.** Audio is emitted every ~50 decoder steps rather than
  after all of them.

The last matters most because Parler-TTS decodes audio tokens autoregressively
at the codec's frame rate — roughly **86 sequential forward passes per second of
speech**. Latency tracks how much audio is requested, not how hard the text is.

**Known instrumentation gap:** `/health`'s `ttsMedian` instruments only the
whole-sentence fallback path, so it reports `null` while streaming is working.
`ttsFirstSentenceMedian` is the live figure.

## Moving to persistent GPU hosting

The highest-value change is **a GPU at compute capability 8.0 or later** (A10G,
L4, A100 — AWS `g5`/`g6`, GCP `g2`). The T4 is sm_75, with neither
FlashAttention-2 nor bf16 tensor cores, and TTS decode is dominated by per-step
cost at roughly 25 ms against a ~4 ms memory-bandwidth floor. An sm_80+ card
should give 2–3× on that path alone.

In order:

1. Run this same FastAPI app on one `g5.xlarge`-class instance behind your own
   TLS endpoint, replacing the quick tunnel with real DNS and a certificate.
2. Bake the weights into the image or an attached volume, removing the
   90-second cold start.
3. Keep the `/health` contract — it already reports load times and per-call
   medians, which is what makes the endpoint measurable from outside.
4. Replace the single shared bearer token with per-client credentials and
   rotation. A static shared token is acceptable for a demo and not for
   production.

Nothing in the local app changes: it speaks the documented contract to
`VOICE_INFERENCE_WS_URL`, so moving hosts is a URL and a token.
