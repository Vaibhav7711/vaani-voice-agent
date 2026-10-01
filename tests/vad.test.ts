import assert from "node:assert/strict";
import test from "node:test";
import { PcmVoiceActivityDetector } from "../lib/realtime/vad";

function frame(amplitude: number) {
  const result = Buffer.alloc(640);
  for (let offset = 0; offset < result.length; offset += 2) result.writeInt16LE(amplitude, offset);
  return result;
}

test("VAD starts after sustained speech and stops after sustained silence", () => {
  const vad = new PcmVoiceActivityDetector(0.018, 3, 4);
  assert.equal(vad.push(frame(4000)), null);
  assert.equal(vad.push(frame(4000)), null);
  assert.equal(vad.push(frame(4000)), "speech_started");
  assert.equal(vad.isSpeaking, true);
  assert.equal(vad.push(frame(0)), null);
  assert.equal(vad.push(frame(0)), null);
  assert.equal(vad.push(frame(0)), null);
  assert.equal(vad.push(frame(0)), "speech_stopped");
  assert.equal(vad.isSpeaking, false);
});
