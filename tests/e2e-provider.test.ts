import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer, WebSocket } from "ws";
import { ExternalWebSocketBridge } from "../lib/realtime/inference-bridge";
import type { ServerEvent } from "../lib/realtime/protocol";

/**
 * End-to-end protocol tests that stream real audio, no microphone involved.
 *
 * Physical microphone automation is not available, and a mocked provider only
 * proves the mock agrees with itself. These stream the committed WAV fixtures
 * through the real bridge, so the parts that actually break in integration are
 * exercised: PCM framing and byte order, the 20 ms frame size the contract
 * specifies, the bearer header surviving the hop, transcripts arriving exactly
 * once, and output audio coming back as decodable 24 kHz PCM16.
 *
 * Two modes, and the difference matters when reading a pass:
 *
 *   - Default: a loopback provider stands in. This verifies the local half of
 *     the contract and runs anywhere, including CI with no GPU.
 *   - With VOICE_INFERENCE_WS_URL and VOICE_INFERENCE_API_KEY set, it talks to
 *     the real remote provider and asserts real transcription and synthesis.
 *     Only this mode proves the deployment works.
 *
 * The remote mode is skipped rather than failed when the variables are absent,
 * and says so, because a silent skip reads as a pass.
 */

// Resolved from the working directory, not import.meta: the test runner is
// `tsx --test` from the repo root and tsx transpiles to CJS, where
// import.meta.dirname is undefined.
const FIXTURES = join(process.cwd(), "tests", "fixtures");
const FRAME_BYTES = 640; // 20 ms of 16 kHz mono PCM16, per docs/realtime-protocol.md

/** PCM16 payload of a canonical 16-bit mono WAV, without its header. */
function readWavPcm(name: string): Buffer {
  const path = join(FIXTURES, name);
  assert.ok(
    existsSync(path),
    `${path} is missing. Regenerate the fixtures with:\n`
      + `  say -v Rishi -o /tmp/en.aiff "..."  &&  say -v Lekha -o /tmp/hi.aiff "..."\n`
      + `  afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/en.aiff tests/fixtures/en-16k.wav`,
  );
  const file = readFileSync(path);
  assert.equal(file.toString("ascii", 0, 4), "RIFF", `${name} is not RIFF`);
  assert.equal(file.toString("ascii", 8, 12), "WAVE", `${name} is not WAVE`);

  // Walk the chunk list rather than assuming a 44-byte header: afconvert emits
  // a FLLR padding chunk before fmt, so a fixed offset would feed the decoder
  // header bytes as audio and transcribe silence.
  let offset = 12;
  let sampleRate: number | undefined;
  let channels: number | undefined;
  let bits: number | undefined;
  while (offset + 8 <= file.length) {
    const id = file.toString("ascii", offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      channels = file.readUInt16LE(body + 2);
      sampleRate = file.readUInt32LE(body + 4);
      bits = file.readUInt16LE(body + 14);
    } else if (id === "data") {
      assert.equal(sampleRate, 16_000, `${name} must be 16 kHz`);
      assert.equal(channels, 1, `${name} must be mono`);
      assert.equal(bits, 16, `${name} must be 16-bit`);
      return file.subarray(body, body + size);
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  throw new Error(`${name} has no data chunk`);
}

function frames(pcm: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let at = 0; at + FRAME_BYTES <= pcm.length; at += FRAME_BYTES) {
    out.push(pcm.subarray(at, at + FRAME_BYTES));
  }
  return out;
}

/** A provider that answers the contract without a model, for the local mode. */
async function loopbackProvider(transcript: string) {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  let framesSeen = 0;
  sockets.on("connection", (socket: WebSocket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        framesSeen += 1;
        return;
      }
      const event = JSON.parse(data.toString("utf8")) as { type: string; text?: string };
      if (event.type === "input_audio.stop") {
        socket.send(JSON.stringify({
          type: "input.transcript.final",
          text: transcript,
          source: "provider_asr",
        } satisfies ServerEvent));
      }
      if (event.type === "response.create") {
        // 0.1 s of 24 kHz PCM16, the shape the contract specifies.
        const audio = Buffer.alloc(2 * 2400).toString("base64");
        socket.send(JSON.stringify({ type: "output_audio.delta", audio, sampleRate: 24_000 }));
        socket.send(JSON.stringify({ type: "output_audio.done" }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    framesSeen: () => framesSeen,
    close: async () => {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) =>
        sockets.close(() => server.close(() => resolve())));
    },
  };
}

interface Streamed {
  transcripts: string[];
  audioBytes: number;
  deltas: number;
  errors: string[];
  elapsedMs: number;
}

/** Stream one fixture through a bridge and collect what came back. */
async function streamFixture(
  url: string,
  key: string | undefined,
  fixture: string,
  language: "en-IN" | "hi-IN",
  settleMs: number,
): Promise<Streamed> {
  const pcm = readWavPcm(fixture);
  const transcripts: string[] = [];
  const errors: string[] = [];
  let audioBytes = 0;
  let deltas = 0;

  const bridge = new ExternalWebSocketBridge(url, key, true, "kaggle-gpu");
  const started = Date.now();
  await bridge.connect({
    onEvent: (event: ServerEvent) => {
      if (event.type === "output_audio.delta") {
        deltas += 1;
        audioBytes += Buffer.from(event.audio, "base64").length;
      }
    },
    onFinalTranscript: (text: string) => transcripts.push(text),
    onError: (message: string) => errors.push(message),
  });

  bridge.sendControl({
    type: "session.start",
    config: {
      language,
      inputAudio: { format: "pcm16", sampleRate: 16_000, channels: 1 },
    },
  });
  bridge.sendControl({ type: "input_audio.start" });
  for (const frame of frames(pcm)) {
    bridge.sendAudio(frame);
    // Real-time pacing. The provider segments on silence, so delivering five
    // seconds instantly would arrive as one burst and its silence-triggered
    // flush would never see a gap.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  bridge.sendControl({ type: "input_audio.stop" });
  await new Promise((resolve) => setTimeout(resolve, settleMs));

  if (transcripts.length > 0) {
    bridge.sendControl({ type: "response.create", text: transcripts[0]!, language });
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }
  const elapsedMs = Date.now() - started;
  bridge.close();
  return { transcripts, audioBytes, deltas, errors, elapsedMs };
}

test("fixtures are 16 kHz mono PCM16 and frame evenly", () => {
  for (const name of ["en-16k.wav", "hi-16k.wav"]) {
    const pcm = readWavPcm(name);
    assert.ok(pcm.length > 16_000, `${name} is suspiciously short`);
    assert.equal(pcm.length % 2, 0, `${name} is not whole 16-bit samples`);
    assert.ok(frames(pcm).length > 10, `${name} yields too few 20 ms frames`);
  }
});

test("a full turn completes against a loopback provider", async () => {
  const remote = await loopbackProvider("What is my EMI?");
  try {
    const result = await streamFixture(remote.url, "secret", "en-16k.wav", "en-IN", 120);
    assert.deepEqual(result.errors, []);
    // Exactly once: the bridge previously emitted finals twice.
    assert.equal(result.transcripts.length, 1);
    assert.equal(result.transcripts[0], "What is my EMI?");
    assert.ok(result.deltas >= 1, "no output audio deltas");
    assert.equal(result.audioBytes, 4800);
    assert.ok(remote.framesSeen() > 10, "frames did not reach the provider");
  } finally {
    await remote.close();
  }
});

const remoteUrl = process.env.VOICE_INFERENCE_WS_URL;
const remoteKey = process.env.VOICE_INFERENCE_API_KEY;
const remoteReady = Boolean(remoteUrl && remoteKey);

test("remote provider transcribes English and returns audio", { skip: remoteReady ? false : "set VOICE_INFERENCE_WS_URL and VOICE_INFERENCE_API_KEY to run against the deployed provider" }, async () => {
  const result = await streamFixture(remoteUrl!, remoteKey, "en-16k.wav", "en-IN", 15_000);
  assert.deepEqual(result.errors, []);
  assert.equal(result.transcripts.length, 1, "expected exactly one final transcript");
  assert.ok(result.transcripts[0]!.length > 0, "final transcript was empty");
  assert.ok(result.deltas >= 1, "provider returned no output audio");
  assert.ok(result.audioBytes > 2_000, `only ${result.audioBytes} bytes of audio`);
  console.log(`  en: ${result.elapsedMs} ms, "${result.transcripts[0]}"`);
});

test("remote provider transcribes Hindi and returns audio", { skip: remoteReady ? false : "set VOICE_INFERENCE_WS_URL and VOICE_INFERENCE_API_KEY to run against the deployed provider" }, async () => {
  const result = await streamFixture(remoteUrl!, remoteKey, "hi-16k.wav", "hi-IN", 15_000);
  assert.deepEqual(result.errors, []);
  assert.equal(result.transcripts.length, 1, "expected exactly one final transcript");
  // Devanagari, not a romanised guess: the provider is told hi-IN.
  assert.match(result.transcripts[0]!, /[ऀ-ॿ]/, "Hindi transcript has no Devanagari");
  assert.ok(result.deltas >= 1, "provider returned no output audio");
  console.log(`  hi: ${result.elapsedMs} ms, "${result.transcripts[0]}"`);
});

test("remote provider rejects a wrong bearer token", { skip: remoteReady ? false : "set VOICE_INFERENCE_WS_URL and VOICE_INFERENCE_API_KEY to run against the deployed provider" }, async () => {
  const errors: string[] = [];
  const bridge = new ExternalWebSocketBridge(remoteUrl!, "definitely-not-the-token", true, "kaggle-gpu");
  await bridge.connect({
    onEvent: () => {},
    onFinalTranscript: () => {},
    onError: (message: string) => errors.push(message),
  }).catch((error: unknown) => errors.push(String(error)));
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  bridge.close();
  assert.ok(errors.length > 0, "an unauthenticated connection was accepted");
});

test("remote provider suppresses a cancelled response", { skip: remoteReady ? false : "set VOICE_INFERENCE_WS_URL and VOICE_INFERENCE_API_KEY to run against the deployed provider" }, async () => {
  const errors: string[] = [];
  let deltasBeforeCancel = 0;
  let deltasAfterCancel = 0;
  let cancelled = false;

  const bridge = new ExternalWebSocketBridge(remoteUrl!, remoteKey, true, "kaggle-gpu");
  await bridge.connect({
    onEvent: (event: ServerEvent) => {
      if (event.type !== "output_audio.delta") return;
      if (cancelled) deltasAfterCancel += 1;
      else deltasBeforeCancel += 1;
    },
    onFinalTranscript: () => {},
    onError: (message: string) => errors.push(message),
  });

  bridge.sendControl({
    type: "session.start",
    config: {
      language: "en-IN",
      inputAudio: { format: "pcm16", sampleRate: 16_000, channels: 1 },
    },
  });
  // Long enough that synthesis is still streaming when the cancel lands;
  // a short reply would finish first and prove nothing.
  bridge.sendControl({
    type: "response.create",
    language: "en-IN",
    text: "Your outstanding balance is forty two thousand rupees, and the next instalment "
      + "of four thousand two hundred rupees is due on the fifteenth of next month. "
      + "You can pay by card, net banking, or by visiting any branch during working hours.",
  });

  // Wait for audio to start, then interrupt mid-stream.
  const deadline = Date.now() + 30_000;
  while (deltasBeforeCancel === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(deltasBeforeCancel > 0, "synthesis never started, so nothing was interrupted");
  cancelled = true;
  bridge.cancelResponse();

  await new Promise((resolve) => setTimeout(resolve, 3_000));
  bridge.close();
  assert.deepEqual(errors, []);
  // A couple may already be in flight across the tunnel when the cancel is
  // sent; what must not happen is the stream continuing to completion.
  assert.ok(
    deltasAfterCancel <= 3,
    `cancel did not suppress output: ${deltasAfterCancel} deltas arrived after it`,
  );
  console.log(`  barge-in: ${deltasBeforeCancel} deltas before, ${deltasAfterCancel} after`);
});
