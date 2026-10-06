"""Kaggle GPU speech provider for the Vaani realtime WebSocket contract.

Run this as a Kaggle GPU notebook/script with Internet enabled. It prints a
temporary wss:// URL that can be assigned to VOICE_INFERENCE_WS_URL locally.
"""

# Kaggle's base image changes over time, so pin the small serving surface while
# leaving its preinstalled CUDA-compatible torch build untouched.
import subprocess
import sys

subprocess.run(
    [
        sys.executable,
        "-m",
        "pip",
        "install",
        "-q",
        "faster-whisper==1.2.0",
        "fastapi==0.116.1",
        "uvicorn[standard]==0.35.0",
        "transformers==4.46.1",
        "accelerate==1.1.1",
        "soundfile==0.12.1",
        "git+https://github.com/huggingface/parler-tts.git@d108732cd57788ec86bc857d99a6cabd66663d68",
    ],
    check=True,
)

# protobuf, repaired afterwards rather than constrained during resolution.
#
# parler-tts depends on descript-audiotools, which pins protobuf>=3.9.2,<3.20.
# transformers 4.46.1's generated protobuf modules need
# google.protobuf.runtime_version, which arrived in 5.27, and the Kaggle image's
# own tensorflow, grpcio-tools and ydf require >=5.26. Those cannot both hold:
# asking the resolver for >=5.27 in the same call returns ResolutionImpossible,
# and letting it choose silently downgrades protobuf and breaks
# `from parler_tts import ...` with "cannot import name 'runtime_version'".
#
# --no-deps is the resolution rather than a workaround: audiotools reaches
# protobuf only through tensorboard logging, which inference never calls, so the
# pin guards a code path this workload does not execute. Done as a second call
# so the first resolution is unchanged and this override is explicit.
subprocess.run(
    [
        sys.executable, "-m", "pip", "install", "-q",
        "--no-deps", "--force-reinstall", "protobuf>=5.27.0,<6",
    ],
    check=True,
)


def _verify_environment() -> None:
    """Fail with versions in hand rather than a bare ImportError.

    The first deployment failed on a transitive downgrade whose cause was only
    visible by reading the pip log. Resolving the versions here, and importing
    the one chain that broke, turns a repeat into a one-line diagnosis.
    """
    import importlib.metadata as metadata

    wanted = ("torch", "transformers", "protobuf", "faster-whisper",
              "ctranslate2", "accelerate")
    resolved = {}
    for name in wanted:
        try:
            resolved[name] = metadata.version(name)
        except Exception:
            resolved[name] = "absent"
    print("resolved versions:", resolved, flush=True)

    protobuf = resolved.get("protobuf", "absent")
    try:
        major = int(protobuf.split(".")[0])
    except ValueError:
        major = 0
    if major and major < 5:
        raise RuntimeError(
            f"protobuf {protobuf} is installed; transformers 4.46.1 needs >= "
            f"5.27 for google.protobuf.runtime_version. A dependency in this "
            f"install downgraded it -- re-run, and if it recurs read the pip "
            f"resolver output above for which package forced it.")
    try:
        from transformers import PreTrainedModel  # noqa: F401
    except Exception as error:  # pragma: no cover - environment guard
        raise RuntimeError(
            f"transformers failed to import ({error}). Resolved versions: "
            f"{resolved}") from error


_verify_environment()

import asyncio
import base64
import contextlib
import hashlib
import json
import os
import re
import secrets
import threading
import time
import urllib.request
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import torch
import torchaudio
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from faster_whisper import WhisperModel
from parler_tts import ParlerTTSForConditionalGeneration, ParlerTTSStreamer
from transformers import AutoTokenizer

PORT = int(os.getenv("PORT", "8000"))

#: Which ASR to serve. Named rather than inferred, and never "use the adapted
#: one if a path happens to exist": a backend that changes underneath you makes
#: every recorded latency and WER incomparable to the last run.
#:
#:   turbo  stock Whisper large-v3-turbo. No Hindi adaptation.
#:   ct2    a CTranslate2 directory produced by indic-voice-pipeline's
#:          scripts/convert_ct2.py, which merges a LoRA adapter into its base
#:          model and converts the result. Requires ASR_CT2_PATH.
#:
#: faster-whisper cannot load a PEFT adapter directly -- CTranslate2 needs
#: merged weights in its own format -- which is why the adapted path is a
#: converted directory and not an adapter name.
ASR_BACKENDS = ("turbo", "ct2")
ASR_BACKEND = os.getenv("VAANI_ASR_BACKEND", "turbo").strip().lower()
ASR_CT2_PATH = os.getenv("ASR_CT2_PATH", "").strip()
ASR_COMPUTE_TYPE = os.getenv("ASR_COMPUTE_TYPE", "float16").strip()
ASR_MODEL = os.getenv("ASR_MODEL", "turbo")
TTS_MODEL = os.getenv("TTS_MODEL", "ai4bharat/indic-parler-tts")
MAX_UTTERANCE_SECONDS = 30
INPUT_SAMPLE_RATE = 16_000
OUTPUT_SAMPLE_RATE = 24_000
FRAME_BYTES = 640
TUNNEL_TIMEOUT_SECONDS = 90
# .txt, not .env: Kaggle's output browser filters .env files out of the file
# list, so the config was written correctly and could not be downloaded. A
# secret that cannot be retrieved is not safer, only useless.
CONFIG_PATH = os.getenv("VAANI_CONFIG_PATH", "/kaggle/working/vaani-provider.txt")
_ENV_TOKEN = os.getenv("VAANI_INFERENCE_TOKEN")
AUTH_TOKEN = _ENV_TOKEN or secrets.token_urlsafe(32)
AUTH_TOKEN_SOURCE = "environment" if _ENV_TOKEN else "generated"
HF_TOKEN = os.getenv("HF_TOKEN")


def resolve_asr_source() -> tuple[str, bool]:
    """The model faster-whisper should load, and whether it is Hindi-adapted.

    Returns `(source, adapted)`. Refuses an unknown backend and a `ct2`
    selection without a usable directory, rather than quietly serving stock
    Whisper under a name that claims otherwise -- a silent fallback here would
    attribute unadapted accuracy to an adapted model.
    """
    if ASR_BACKEND not in ASR_BACKENDS:
        raise RuntimeError(
            f"VAANI_ASR_BACKEND must be one of {ASR_BACKENDS}, got "
            f"{ASR_BACKEND!r}")

    if ASR_BACKEND == "turbo":
        return ASR_MODEL, False

    if not ASR_CT2_PATH:
        raise RuntimeError(
            "VAANI_ASR_BACKEND=ct2 needs ASR_CT2_PATH: a CTranslate2 directory "
            "from indic-voice-pipeline's scripts/convert_ct2.py, usually "
            "attached as a Kaggle Dataset under /kaggle/input/...")
    directory = Path(ASR_CT2_PATH)
    if not directory.is_dir():
        raise RuntimeError(f"ASR_CT2_PATH {directory} is not a directory")
    # CTranslate2 writes model.bin; a directory without it is a merged
    # HuggingFace checkpoint that was never converted, and faster-whisper
    # would fail later with a less obvious error.
    if not (directory / "model.bin").is_file():
        contents = sorted(p.name for p in directory.iterdir())[:8]
        raise RuntimeError(
            f"{directory} has no model.bin, so it is not a CTranslate2 model. "
            f"Found: {contents}. If this is the -hf-merged sibling, run "
            f"ct2-transformers-converter on it first.")
    return str(directory), True


def _kaggle_secret(name: str, *, required: bool = False) -> Optional[str]:
    """Read a Kaggle secret, reporting why when it is unavailable.

    The reason matters and used to be discarded. A secret that exists on the
    account but is not *attached* to this notebook raises here exactly as one
    that was never created does, so a silent None sent the operator to check
    the wrong thing -- and pushing a new kernel version via the API can detach
    add-ons, which is precisely the case that looks like "I already added it".

    Only the failure is logged, never the value.
    """
    try:
        from kaggle_secrets import UserSecretsClient
    except Exception as error:
        print(f"secret {name}: kaggle_secrets unavailable ({type(error).__name__}); "
              f"not running inside a Kaggle kernel?", flush=True)
        return None
    try:
        value = UserSecretsClient().get_secret(name)
    except Exception as error:
        detail = str(error)
        absent = "No user secrets exist" in detail
        if absent and not required:
            # Routine for an optional secret. Printing a BackendError and
            # attachment advice here reads as a failure and sends the operator
            # to fix something that is working as intended.
            print(f"secret {name}: not set (optional); using a generated value "
                  f"for this run", flush=True)
            return None
        print(f"secret {name}: NOT available -- {type(error).__name__}: "
              f"{detail[:200]}", flush=True)
        print(f"  Check the label spelling exactly, then that it is attached to "
              f"THIS notebook: editor > Add-ons > Secrets.", flush=True)
        return None
    if not value:
        print(f"secret {name}: attached but empty", flush=True)
        return None
    print(f"secret {name}: available ({len(value)} chars)", flush=True)
    return value


HF_TOKEN = HF_TOKEN or _kaggle_secret("HF_TOKEN", required=True)
_SECRET_TOKEN = _kaggle_secret("VAANI_INFERENCE_TOKEN")
if _SECRET_TOKEN:
    AUTH_TOKEN, AUTH_TOKEN_SOURCE = _SECRET_TOKEN, "kaggle_secret"


class Models:
    def __init__(self) -> None:
        if not torch.cuda.is_available():
            raise RuntimeError("A Kaggle GPU accelerator is required")

        self.device = torch.device("cuda:0")
        # Checked before anything is downloaded. Loading Whisper first spends
        # ~1.6 GB and several minutes before failing on a condition that was
        # knowable at startup.
        if not HF_TOKEN:
            raise RuntimeError(
                "HF_TOKEN is not set. Add it as a Kaggle secret (Add-ons > "
                "Secrets, name exactly HF_TOKEN) using a Hugging Face token "
                "whose account has accepted the access conditions at "
                "https://huggingface.co/ai4bharat/indic-parler-tts"
            )
        def vram() -> float:
            return torch.cuda.memory_allocated(self.device) / 1024**3

        print(f"gpu: {torch.cuda.get_device_name(0)}", flush=True)
        asr_started = time.time()
        self.asr_source, self.asr_adapted = resolve_asr_source()
        self.asr_compute_type = ASR_COMPUTE_TYPE
        self.asr = WhisperModel(
            self.asr_source, device="cuda", compute_type=ASR_COMPUTE_TYPE)
        self.asr_load_seconds = round(time.time() - asr_started, 1)
        # CTranslate2 allocates outside the torch allocator, so torch's figure
        # does not include Whisper. Reported separately rather than summed, to
        # avoid implying a total this cannot see.
        print(f"asr loaded in {self.asr_load_seconds}s "
              f"(ctranslate2, outside the torch allocator)", flush=True)
        tts_started = time.time()
        self.tts = ParlerTTSForConditionalGeneration.from_pretrained(
            TTS_MODEL,
            token=HF_TOKEN,
            torch_dtype=torch.float16,
        ).to(self.device)
        self.tts.eval()
        self.tts_load_seconds = round(time.time() - tts_started, 1)
        self.tts_vram_gib = round(vram(), 2)
        print(f"tts loaded in {self.tts_load_seconds}s, "
              f"{self.tts_vram_gib} GiB resident in torch", flush=True)
        self.prompt_tokenizer = AutoTokenizer.from_pretrained(TTS_MODEL, token=HF_TOKEN)
        self.description_tokenizer = AutoTokenizer.from_pretrained(
            self.tts.config.text_encoder._name_or_path,
            token=HF_TOKEN,
        )
        self.tts_sample_rate = int(self.tts.config.sampling_rate)

    #: Rolling per-call timings, surfaced on /health. A live endpoint that
    #: cannot say how long its own stages take is not measurable from outside.
    asr_ms: list[float] = []
    tts_ms: list[float] = []
    #: Time to the first sentence of a response, which is what a caller waits
    #: through. Tracked apart from total synthesis because the two diverged
    #: once responses were split into sentences.
    tts_first_ms: list[float] = []

    def transcribe(self, pcm: bytes, locale: str) -> str:
        started = time.time()
        waveform = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        language = "hi" if locale == "hi-IN" else "en"
        segments, _ = self.asr.transcribe(
            waveform,
            language=language,
            beam_size=5,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 350, "speech_pad_ms": 160},
            hotwords="EMI loan payment due date outstanding balance OTP किस्त लोन भुगतान बकाया",
            condition_on_previous_text=False,
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
        self.asr_ms.append(round((time.time() - started) * 1000, 1))
        del self.asr_ms[:-50]
        return text

    def _to_pcm16(self, waveform: "np.ndarray") -> bytes:
        """Float audio at the model's rate -> 24 kHz PCM16 bytes."""
        tensor = torch.from_numpy(np.asarray(waveform, dtype=np.float32)).reshape(1, -1)
        if self.tts_sample_rate != OUTPUT_SAMPLE_RATE:
            tensor = torchaudio.functional.resample(
                tensor, self.tts_sample_rate, OUTPUT_SAMPLE_RATE)
        return (tensor.squeeze().clamp(-1, 1).numpy() * 32767).astype("<i2").tobytes()

    def _generation_inputs(self, text: str, locale: str) -> dict:
        description = self._description(locale)
        description_inputs = self.description_tokenizer(
            description, return_tensors="pt").to(self.device)
        prompt_inputs = self.prompt_tokenizer(text, return_tensors="pt").to(self.device)
        return {
            "input_ids": description_inputs.input_ids,
            "attention_mask": description_inputs.attention_mask,
            "prompt_input_ids": prompt_inputs.input_ids,
            "prompt_attention_mask": prompt_inputs.attention_mask,
            "do_sample": True,
            "temperature": 0.8,
        }

    def synthesize_stream(self, text: str, locale: str):
        """Yield PCM16 as it is generated, rather than after all of it exists.

        Parler-TTS decodes audio tokens autoregressively at the codec's frame
        rate, so a five-second sentence is a few hundred sequential forward
        passes and `generate()` returns only at the end -- the measured 11 s
        median. `ParlerTTSStreamer` hands back audio every `play_steps`
        decoder steps, which turns time-to-first-audio from the length of the
        sentence into the length of one chunk.

        `generate()` is run on a thread because the streamer is a blocking
        iterator: the generation has to proceed while this consumes it.
        """
        streamer = ParlerTTSStreamer(self.tts, device=self.device, play_steps=50)
        kwargs = dict(self._generation_inputs(text, locale), streamer=streamer)

        error: list[BaseException] = []

        def generate() -> None:
            try:
                with torch.inference_mode():
                    self.tts.generate(**kwargs)
            except BaseException as failure:  # surfaced to the consumer below
                error.append(failure)

        worker = threading.Thread(target=generate, daemon=True)
        worker.start()
        for chunk in streamer:
            if chunk is None:
                continue
            audio = chunk if isinstance(chunk, np.ndarray) else chunk.float().cpu().numpy()
            if audio.size:
                yield self._to_pcm16(audio)
        worker.join(timeout=5)
        if error:
            raise error[0]

    def _description(self, locale: str) -> str:
        if locale == "hi-IN":
            return (
                "Divya speaks in clear, warm, professional Hindi at a moderate pace. "
                "The voice sounds close, calm, and helpful, with studio-quality audio and no background noise."
            )
        return (
            "Rohit speaks in clear Indian English with a warm professional tone and moderate pace. "
            "The voice sounds close, calm, and helpful, with studio-quality audio and no background noise."
        )

    @torch.inference_mode()
    def synthesize(self, text: str, locale: str) -> bytes:
        if locale == "hi-IN":
            description = (
                "Divya speaks in clear, warm, professional Hindi at a moderate pace. "
                "The voice sounds close, calm, and helpful, with studio-quality audio and no background noise."
            )
        else:
            description = (
                "Rohit speaks in clear Indian English with a warm professional tone and moderate pace. "
                "The voice sounds close, calm, and helpful, with studio-quality audio and no background noise."
            )
        started = time.time()
        description_inputs = self.description_tokenizer(description, return_tensors="pt").to(self.device)
        prompt_inputs = self.prompt_tokenizer(text, return_tensors="pt").to(self.device)
        generation = self.tts.generate(
            input_ids=description_inputs.input_ids,
            attention_mask=description_inputs.attention_mask,
            prompt_input_ids=prompt_inputs.input_ids,
            prompt_attention_mask=prompt_inputs.attention_mask,
            do_sample=True,
            temperature=0.8,
        )
        waveform = generation.float().cpu().reshape(1, -1)
        if self.tts_sample_rate != OUTPUT_SAMPLE_RATE:
            waveform = torchaudio.functional.resample(
                waveform,
                self.tts_sample_rate,
                OUTPUT_SAMPLE_RATE,
            )
        pcm = (waveform.squeeze().clamp(-1, 1).numpy() * 32767).astype("<i2")
        self.tts_ms.append(round((time.time() - started) * 1000, 1))
        del self.tts_ms[:-50]
        return pcm.tobytes()


models: Optional[Models] = None
started_at = time.time()


@asynccontextmanager
async def lifespan(_: FastAPI):
    global models
    models = await asyncio.to_thread(Models)
    yield
    models = None


app = FastAPI(title="Vaani Kaggle Speech Provider", lifespan=lifespan)


@app.get("/health")
async def health():
    return {
        "status": "ready" if models else "loading",
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        # The backend is reported, not assumed: a WER or latency figure from
        # this endpoint has to be attributable to the model that produced it.
        "asr": {
            "backend": ASR_BACKEND,
            "source": None if not models else models.asr_source,
            "computeType": ASR_COMPUTE_TYPE,
            "hindiAdapted": None if not models else models.asr_adapted,
        },
        "tts": TTS_MODEL,
        "uptimeSeconds": round(time.time() - started_at),
        # None, not 0, where nothing has been measured yet: a zero here would
        # be averaged into a latency table as though it were a measurement.
        "load": None if not models else {
            "asrSeconds": models.asr_load_seconds,
            "ttsSeconds": models.tts_load_seconds,
            "ttsVramGib": models.tts_vram_gib,
        },
        "latencyMs": None if not models else {
            "asrCalls": len(models.asr_ms),
            "asrMedian": _median(models.asr_ms),
            "ttsCalls": len(models.tts_ms),
            "ttsMedian": _median(models.tts_ms),
            "ttsFirstSentenceMedian": _median(models.tts_first_ms),
        },
    }


#: Sentence terminators, Devanagari danda included. ASCII "." is accepted only
#: before whitespace or end, so "4.5" and "Rs." do not split a number or an
#: abbreviation into its own utterance.
_SENTENCE_END = re.compile(r"(?<=[\u0964\u0965!?])\s+|(?<=\.)\s+")


def split_sentences(text: str, min_chars: int = 12) -> list[str]:
    """Split a reply into units worth synthesising separately.

    Parler-TTS generates a whole utterance before returning, so synthesising a
    three-sentence reply as one unit means no audio until all of it exists --
    a measured 11 s median. Splitting lets the first sentence stream while the
    rest generate, which is what the caller actually waits for.

    Fragments shorter than `min_chars` are merged forwards: a two-word unit
    costs nearly as much to generate as a full sentence and sounds clipped.
    """
    parts = [part.strip() for part in _SENTENCE_END.split(text.strip()) if part.strip()]
    if not parts:
        return []
    merged: list[str] = []
    for part in parts:
        if merged and len(merged[-1]) < min_chars:
            merged[-1] = f"{merged[-1]} {part}"
        else:
            merged.append(part)
    return merged


def _median(values: list[float]) -> Optional[float]:
    """`None` on an empty sample rather than 0.0."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


def rms(frame: bytes) -> float:
    if len(frame) < 2:
        return 0.0
    samples = np.frombuffer(frame, dtype="<i2").astype(np.float32) / 32768.0
    return float(np.sqrt(np.mean(np.square(samples))))


@dataclass
class Session:
    websocket: WebSocket
    language: str = "en-IN"
    input_active: bool = False
    speaking: bool = False
    speech_frames: int = 0
    silence_frames: int = 0
    pre_roll: list[bytes] = field(default_factory=list)
    utterance: list[bytes] = field(default_factory=list)
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    transcribe_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    #: Parler-TTS generation is the heaviest thing on the card. Two of them at
    #: once is how a 16 GB accelerator running ASR as well runs out of memory,
    #: and a barge-in creates exactly that overlap: the cancelled generation
    #: keeps computing in its thread while the replacement starts.
    synthesize_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    response_generation: int = 0
    #: Class-level on purpose: one streamer failure condemns the session rather
    #: than being retried on every sentence.
    streaming_tts_failed: bool = False
    tasks: set[asyncio.Task] = field(default_factory=set)

    async def send(self, event: dict) -> None:
        async with self.send_lock:
            await self.websocket.send_text(json.dumps(event, ensure_ascii=False))

    def schedule(self, coroutine) -> None:
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    def push_audio(self, frame: bytes) -> Optional[bytes]:
        if not self.input_active:
            return None
        frame_level = rms(frame)
        if not self.speaking:
            self.pre_roll.append(frame)
            self.pre_roll = self.pre_roll[-15:]
            if frame_level >= 0.018:
                self.speech_frames += 1
                if self.speech_frames >= 3:
                    self.speaking = True
                    self.utterance = list(self.pre_roll)
                    self.pre_roll.clear()
            else:
                self.speech_frames = 0
            return None

        self.utterance.append(frame)
        max_frames = MAX_UTTERANCE_SECONDS * INPUT_SAMPLE_RATE * 2 // FRAME_BYTES
        if frame_level >= 0.018:
            self.silence_frames = 0
        else:
            self.silence_frames += 1
        if self.silence_frames >= 22 or len(self.utterance) >= max_frames:
            return self.flush()
        return None

    def flush(self) -> Optional[bytes]:
        pcm = b"".join(self.utterance)
        self.speaking = False
        self.speech_frames = 0
        self.silence_frames = 0
        self.pre_roll.clear()
        self.utterance.clear()
        return pcm if len(pcm) >= INPUT_SAMPLE_RATE // 2 else None

    async def transcribe(self, pcm: bytes) -> None:
        async with self.transcribe_lock:
            if models is None:
                await self.send({
                    "type": "error",
                    "code": "not_ready",
                    "message": "models are still loading",
                    "recoverable": True,
                })
                return
            try:
                text = await asyncio.to_thread(models.transcribe, pcm, self.language)
                if text:
                    await self.send({
                        "type": "input.transcript.final",
                        "text": text,
                        "source": "provider_asr",
                    })
            except Exception as error:
                await self.send({
                    "type": "error",
                    "code": "asr_failed",
                    "message": str(error),
                    "recoverable": True,
                })

    async def synthesize(self, text: str, language: str) -> None:
        self.response_generation += 1
        generation = self.response_generation
        if models is None:
            await self.send({
                "type": "error",
                "code": "not_ready",
                "message": "models are still loading",
                "recoverable": True,
            })
            return
        try:
            sentences = split_sentences(text)
            chunk_bytes = OUTPUT_SAMPLE_RATE * 2 // 10          # 0.1 s of audio
            chunk_seconds = chunk_bytes / (OUTPUT_SAMPLE_RATE * 2)
            started = time.time()
            first_sent = False

            async with self.synthesize_lock:
                for sentence in sentences:
                    # Checked per sentence as well as per chunk: after a
                    # barge-in the remaining sentences are never generated, so
                    # cancelling frees the GPU instead of only muting output
                    # that was already computed.
                    if generation != self.response_generation:
                        return
                    async for pcm in self._sentence_audio(sentence, language):
                        if not first_sent:
                            models.tts_first_ms.append(
                                round((time.time() - started) * 1000, 1))
                            del models.tts_first_ms[:-50]
                            first_sent = True
                        for offset in range(0, len(pcm), chunk_bytes):
                            if generation != self.response_generation:
                                return
                            await self.send({
                                "type": "output_audio.delta",
                                "audio": base64.b64encode(
                                    pcm[offset:offset + chunk_bytes]).decode("ascii"),
                                "sampleRate": OUTPUT_SAMPLE_RATE,
                            })
                # Paced to the audio's own duration, not `sleep(0)`. Yielding
                # without delaying wrote every chunk to the socket in
                # milliseconds, which made two things untrue at once: the output
                # was dumped rather than streamed, so playback could not begin
                # until all of it had arrived; and barge-in could suppress
                # nothing, because by the time the first delta reached the
                # client the whole response was already sent. A measured run
                # saw 158 deltas arrive after a cancel.
                #
                # The 0.8 factor keeps the sender a little ahead of playback so
                # the client never starves, while leaving the stream
                # interruptible at every chunk boundary.
                await asyncio.sleep(chunk_seconds * 0.8)
            if generation == self.response_generation:
                await self.send({"type": "output_audio.done"})
        except Exception as error:
            await self.send({
                "type": "error",
                "code": "tts_failed",
                "message": str(error),
                "recoverable": True,
            })

    async def _sentence_audio(self, sentence: str, language: str):
        """PCM for one sentence: streamed when that works, whole when it does not.

        The streaming path is the one worth having -- it is the difference
        between waiting for a sentence and waiting for a chunk of one -- and it
        is also the newest code here. A provider that already transcribes and
        speaks should not stop doing either because an optimisation failed, so
        a failure falls back to the path measured working, once per session,
        with the reason logged.
        """
        if not Session.streaming_tts_failed:
            queue: asyncio.Queue = asyncio.Queue()
            loop = asyncio.get_running_loop()
            sentinel = object()

            def pump() -> None:
                try:
                    for pcm in models.synthesize_stream(sentence, language):
                        loop.call_soon_threadsafe(queue.put_nowait, pcm)
                except BaseException as failure:
                    loop.call_soon_threadsafe(queue.put_nowait, failure)
                else:
                    loop.call_soon_threadsafe(queue.put_nowait, sentinel)

            threading.Thread(target=pump, daemon=True).start()
            produced = False
            while True:
                item = await queue.get()
                if item is sentinel:
                    return
                if isinstance(item, BaseException):
                    if produced:
                        # Half the sentence has already gone out; replaying it
                        # from the fallback would speak the opening twice.
                        raise item
                    Session.streaming_tts_failed = True
                    print(f"streaming tts failed ({type(item).__name__}: "
                          f"{str(item)[:150]}); falling back to whole-sentence "
                          f"synthesis for the rest of this session", flush=True)
                    break
                produced = True
                yield item
            if produced:
                return

        yield await asyncio.to_thread(models.synthesize, sentence, language)

    def cancel_response(self) -> None:
        self.response_generation += 1

    def close(self) -> None:
        self.cancel_response()
        for task in self.tasks:
            task.cancel()


@app.websocket("/realtime")
async def realtime(websocket: WebSocket):
    expected = f"Bearer {AUTH_TOKEN}"
    presented = websocket.headers.get("authorization") or ""
    # compare_digest, not !=: a plain comparison returns as soon as two bytes
    # differ, which leaks the token prefix to anyone who can time the handshake.
    if not secrets.compare_digest(presented, expected):
        # Accept before closing. Closing an un-accepted WebSocket makes
        # Starlette reject the handshake with HTTP 403, and the client then
        # sees a transport error rather than close code 4401 -- so the bridge
        # cannot tell "wrong token" from "server unreachable".
        await websocket.accept()
        await websocket.close(code=4401, reason="Unauthorized")
        return
    await websocket.accept()
    session = Session(websocket)
    try:
        while True:
            message = await websocket.receive()
            if message.get("bytes") is not None:
                utterance = session.push_audio(message["bytes"])
                if utterance:
                    session.schedule(session.transcribe(utterance))
                continue
            raw = message.get("text")
            if raw is None:
                continue
            event = json.loads(raw)
            event_type = event.get("type")
            if event_type == "session.start":
                language = event.get("config", {}).get("language")
                if language not in {"en-IN", "hi-IN"}:
                    await session.send({
                        "type": "error",
                        "code": "invalid_language",
                        "message": "Only en-IN and hi-IN are enabled",
                        "recoverable": False,
                    })
                    continue
                session.language = language
            elif event_type == "input_audio.start":
                session.input_active = True
            elif event_type == "input_audio.stop":
                session.input_active = False
                utterance = session.flush()
                if utterance:
                    session.schedule(session.transcribe(utterance))
            elif event_type == "response.create":
                text = str(event.get("text", "")).strip()
                if text and len(text) <= 4000:
                    session.schedule(session.synthesize(text, event.get("language", session.language)))
            elif event_type == "response.cancel":
                session.cancel_response()
    except WebSocketDisconnect:
        pass
    finally:
        session.close()


def install_cloudflared() -> Path:
    target = Path("/kaggle/working/cloudflared")
    if target.exists():
        return target
    url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
    urllib.request.urlretrieve(url, target)
    target.chmod(0o755)
    return target


def _fingerprint(value: str) -> str:
    """Eight hex characters of a SHA-256, enough to confirm *which* secret is
    live without disclosing it."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:8]


def write_provider_config(public_url: str) -> Path:
    """Write the provider block to a file instead of printing it.

    Both the tunnel URL and the bearer token are temporary credentials, and
    Kaggle persists cell output with the notebook -- so printing them, as this
    did, puts them in the saved output of every run and in any shared copy.
    The file is written with owner-only permissions and must be downloaded from
    the notebook's output rather than read off the log.
    """
    destination = Path(CONFIG_PATH)
    destination.parent.mkdir(parents=True, exist_ok=True)
    body = (
        f"VOICE_INFERENCE_WS_URL={public_url.replace('https://', 'wss://')}/realtime\n"
        f"VOICE_INFERENCE_API_KEY={AUTH_TOKEN}\n"
        "VOICE_INFERENCE_OUTPUT_AUDIO=true\n"
        "VOICE_INFERENCE_PROVIDER_NAME=kaggle-gpu\n"
    )
    # Create with 0600 before writing, so the secret is never briefly readable.
    handle = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(handle, "w", encoding="utf-8") as stream:
        stream.write(body)

    print("\nVAANI KAGGLE PROVIDER READY", flush=True)
    print(f"  provider config : {destination}", flush=True)
    print("  Download it from the editor's Output pane (refresh the pane if it",
          flush=True)
    print("  is not listed yet; it is written last) and save it locally as",
          flush=True)
    print("  .env.local in the Vaani repository.", flush=True)
    print(f"  tunnel host     : ...{_fingerprint(public_url)} (fingerprint)", flush=True)
    print(f"  bearer token    : ...{_fingerprint(AUTH_TOKEN)} (fingerprint)", flush=True)
    print(f"  token source    : {AUTH_TOKEN_SOURCE}", flush=True)
    print("  Neither the URL nor the token is printed: Kaggle saves cell output",
          flush=True)
    print("  with the notebook. Copy the file above into your local .env.local.",
          flush=True)
    if AUTH_TOKEN_SOURCE == "generated":
        print("  This token was generated for this run only. Set a Kaggle secret",
              flush=True)
        print("  named VAANI_INFERENCE_TOKEN to keep one across restarts.",
              flush=True)
    return destination


async def wait_until_serving(server: uvicorn.Server, server_task: asyncio.Task) -> None:
    """Block until uvicorn is accepting, or raise with the reason it is not.

    `while not server.started: await sleep()` spins forever when startup fails.
    uvicorn catches a lifespan exception, logs it and returns from `serve()`
    without ever setting `started` -- so the missing-HF_TOKEN RuntimeError, the
    most likely failure here, presented as a notebook that hung with no error.
    Watching the task as well as the flag is what turns that back into a
    message.
    """
    while not server.started:
        if server_task.done():
            # Re-raise the real cause if there was one; uvicorn swallows a
            # lifespan failure into a clean return after logging it.
            server_task.result()
            raise RuntimeError(
                "uvicorn stopped during startup without serving. The cause is "
                "logged above -- most often the Indic Parler-TTS load failing "
                "because HF_TOKEN is missing, or the Hugging Face access "
                "conditions for ai4bharat/indic-parler-tts have not been "
                "accepted on the account that owns the token.")
        await asyncio.sleep(0.2)


async def open_tunnel(cloudflared: Path) -> tuple[asyncio.subprocess.Process, str]:
    """Start cloudflared and return it with its public URL.

    The process is returned so the caller can terminate it: the original left
    it running on every path except the no-URL one, which orphans cloudflared
    inside the Kaggle session after the server stops.
    """
    tunnel = await asyncio.create_subprocess_exec(
        str(cloudflared),
        "tunnel",
        "--url",
        f"http://127.0.0.1:{PORT}",
        "--no-autoupdate",
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    assert tunnel.stderr is not None

    async def read_url() -> str:
        assert tunnel.stderr is not None
        while True:
            raw = await tunnel.stderr.readline()
            if not raw:
                raise RuntimeError(
                    "cloudflared exited before publishing a URL; check that "
                    "the kernel has Internet enabled")
            match = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com",
                              raw.decode("utf-8", errors="replace"))
            if match:
                return match.group(0)

    try:
        # Bounded with wait_for rather than asyncio.timeout, which needs 3.11:
        # the Kaggle image's Python version is not ours to assume. Without a
        # deadline a cloudflared that starts but never registers leaves this
        # reading a pipe forever.
        url = await asyncio.wait_for(read_url(), timeout=TUNNEL_TIMEOUT_SECONDS)
    except BaseException:
        # Includes CancelledError: an interrupted notebook must not leave
        # cloudflared running.
        tunnel.terminate()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(tunnel.wait(), timeout=10)
        raise
    return tunnel, url


async def run() -> None:
    cloudflared = install_cloudflared()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="info"))
    server_task = asyncio.create_task(server.serve())
    tunnel: Optional[asyncio.subprocess.Process] = None
    try:
        print("loading models (several minutes on a cold cache)…", flush=True)
        await wait_until_serving(server, server_task)
        tunnel, public_url = await open_tunnel(cloudflared)
        write_provider_config(public_url)
        await server_task
    finally:
        # Every exit path, not just the happy one: an orphaned cloudflared keeps
        # a dead URL resolving, which reads as the provider being up.
        server.should_exit = True
        if tunnel is not None and tunnel.returncode is None:
            tunnel.terminate()
            with contextlib.suppress(asyncio.TimeoutError, ProcessLookupError):
                await asyncio.wait_for(tunnel.wait(), timeout=10)
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await asyncio.wait_for(server_task, timeout=15)
        print("provider stopped; the tunnel URL and token are now dead.", flush=True)


#: Holds the provider task in the interactive path. Without a reference the
#: loop may drop it mid-run, and a garbage-collected server looks like a crash.
_PROVIDER_TASK: Optional[asyncio.Task] = None


def main() -> None:
    """Start the provider under whichever event loop this kernel gives us.

    A Kaggle *script* kernel runs plain Python, so this owns the loop. The
    editor's interactive session runs the same file inside ipykernel, which
    already has a loop running -- and `asyncio.run()` refuses to nest, failing
    with "cannot be called from a running event loop". Since the interactive
    session is the only way to read a long-lived server's output (a batch run's
    output is retrievable only once it finishes, and this never does), both
    paths have to work.
    """
    global _PROVIDER_TASK
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None

    if running is None:
        try:
            asyncio.run(run())
        except KeyboardInterrupt:
            pass
        return

    _PROVIDER_TASK = running.create_task(run())
    print("provider starting on this session's event loop; keep the session "
          "open. Output continues below as the models load.", flush=True)


if __name__ == "__main__":
    main()
