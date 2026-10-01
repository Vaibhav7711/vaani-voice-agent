# Realtime inference adapter contract

Vaani owns the financial workflow and tool policy. A connected speech provider owns streaming ASR and, optionally, streaming TTS. Configure it with `VOICE_INFERENCE_WS_URL`.

## Connection

The Vaani server opens one provider WebSocket for each caller session and forwards JSON control events plus binary audio frames.

- Binary client-to-provider messages are signed 16-bit little-endian PCM, mono, 16 kHz, normally 20 ms / 640 bytes per frame.
- JSON is UTF-8 text.
- `Authorization: Bearer <VOICE_INFERENCE_API_KEY>` is included when a key is configured.

## Events sent to the provider

```json
{"type":"session.start","config":{"language":"en-IN","inputAudio":{"format":"pcm16","sampleRate":16000,"channels":1}}}
{"type":"input_audio.start"}
{"type":"input_audio.stop"}
{"type":"response.cancel"}
{"type":"response.create","text":"Your EMI is ...","language":"en-IN"}
```

`response.create` is sent only when `VOICE_INFERENCE_OUTPUT_AUDIO=true`.

The included Kaggle provider implements this contract at `kaggle/vaani_kaggle.py`. It requires bearer authentication, performs its own utterance segmentation over the binary PCM stream, and exposes `/health` on the same temporary host.

## Events accepted from the provider

```json
{"type":"input.transcript.partial","text":"mera emi"}
{"type":"input.transcript.final","text":"Mera EMI amount kya hai?","source":"provider_asr"}
{"type":"output_audio.delta","audio":"<base64 PCM16>","sampleRate":24000}
{"type":"output_audio.done"}
```

Final transcripts enter the same guarded loan-agent state machine as typed input. The provider never receives lender credentials and cannot call financial tools directly.

Provider events are treated as untrusted input. Vaani bounds transcript and audio-delta sizes and validates audio sample rates before forwarding events to the browser.
