import assert from "node:assert/strict";
import test from "node:test";
import { parseClientEvent } from "../lib/realtime/protocol";

test("accepts the fixed PCM16 session contract", () => {
  const event = parseClientEvent(JSON.stringify({
    type: "session.start",
    config: { language: "hi-IN", inputAudio: { format: "pcm16", sampleRate: 16000, channels: 1 } },
  }));
  assert.equal(event.type, "session.start");
});

test("rejects unknown and oversized realtime events", () => {
  assert.throws(() => parseClientEvent('{"type":"admin.override"}'), /Unsupported/);
  assert.throws(() => parseClientEvent(JSON.stringify({
    type: "conversation.item.create",
    text: "x".repeat(4001),
    source: "text",
  })), /Invalid conversation/);
});
