import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import { ExternalWebSocketBridge } from "../lib/realtime/inference-bridge";
import type { ServerEvent } from "../lib/realtime/protocol";

async function provider(
  onConnection: Parameters<WebSocketServer["on"]>[1],
) {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", onConnection);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => server.close(() => resolve())));
    },
  };
}

test("authenticates and forwards one validated final transcript", async () => {
  let authorization: string | undefined;
  const remote = await provider((socket, request) => {
    authorization = request.headers.authorization;
    socket.send(JSON.stringify({
      type: "input.transcript.final",
      text: "  What is my EMI?  ",
      source: "provider_asr",
    } satisfies ServerEvent));
  });
  const events: ServerEvent[] = [];
  const transcripts: string[] = [];
  const bridge = new ExternalWebSocketBridge(remote.url, "secret", true, "kaggle-gpu");
  await bridge.connect({
    onEvent: (event) => events.push(event),
    onFinalTranscript: (text) => transcripts.push(text),
    onError: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(bridge.name, "kaggle-gpu");
  assert.equal(authorization, "Bearer secret");
  assert.deepEqual(transcripts, ["What is my EMI?"]);
  assert.deepEqual(events, [], "runtime emits the final transcript after processing; bridge must not duplicate it");
  bridge.close();
  await remote.close();
});

test("rejects oversized provider audio events", async () => {
  const remote = await provider((socket) => {
    socket.send(JSON.stringify({
      type: "output_audio.delta",
      audio: "A".repeat(512_001),
      sampleRate: 24_000,
    }));
  });
  const errors: string[] = [];
  const bridge = new ExternalWebSocketBridge(remote.url, undefined, true);
  await bridge.connect({
    onEvent: () => {},
    onFinalTranscript: () => {},
    onError: (message) => errors.push(message),
  });
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(errors.length, 0, "unknown or over-limit provider messages are dropped");
  bridge.close();
  await remote.close();
});
