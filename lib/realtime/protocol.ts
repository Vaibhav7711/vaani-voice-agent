import type { AgentSession, PublicAgentSession } from "../domain";

export type AudioFormat = "pcm16";

export type ClientEvent =
  | {
      type: "session.start";
      config: {
        language: AgentSession["language"];
        inputAudio: { format: AudioFormat; sampleRate: 16000; channels: 1 };
      };
    }
  | { type: "conversation.item.create"; text: string; source: "text" | "browser_asr" | "provider_asr" }
  | { type: "input.transcript.partial"; text: string }
  | { type: "input_audio.start" }
  | { type: "input_audio.stop" }
  | { type: "response.cancel" };

export type RuntimeTelemetry = {
  audioBytes: number;
  audioDurationMs: number;
  firstAudioAt?: string;
  lastAudioAt?: string;
  lastTurnLatencyMs?: number;
  provider: string;
  speechActive: boolean;
};

export type ServerEvent =
  | {
      type: "session.ready";
      session: PublicAgentSession;
      capabilities: { externalAsr: boolean; streamingOutputAudio: boolean; provider: string };
    }
  | { type: "session.updated"; session: PublicAgentSession }
  | { type: "input.transcript.partial"; text: string }
  | { type: "input.transcript.final"; text: string; source: "browser_asr" | "provider_asr" }
  | { type: "input_audio.speech_started" }
  | { type: "input_audio.speech_stopped" }
  | { type: "agent.thinking"; startedAt: string }
  | { type: "agent.response"; text: string; toolCalls: string[]; latencyMs: number }
  | { type: "output_audio.delta"; audio: string; sampleRate: number }
  | { type: "output_audio.done" }
  | { type: "telemetry.updated"; telemetry: RuntimeTelemetry }
  | { type: "error"; code: string; message: string; recoverable: boolean };

export function parseClientEvent(value: string): ClientEvent {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || !("type" in parsed) || typeof parsed.type !== "string") {
    throw new Error("Invalid realtime event envelope");
  }
  const candidate = parsed as Record<string, unknown>;
  switch (candidate.type) {
    case "session.start": {
      const config = candidate.config as Record<string, unknown> | undefined;
      const inputAudio = config?.inputAudio as Record<string, unknown> | undefined;
      if (
        !config || (config.language !== "en-IN" && config.language !== "hi-IN") ||
        !inputAudio || inputAudio.format !== "pcm16" || inputAudio.sampleRate !== 16000 || inputAudio.channels !== 1
      ) throw new Error("Invalid session.start configuration");
      return parsed as ClientEvent;
    }
    case "conversation.item.create":
      if (
        typeof candidate.text !== "string" || !candidate.text.trim() || candidate.text.length > 4000 ||
        !["text", "browser_asr", "provider_asr"].includes(String(candidate.source))
      ) throw new Error("Invalid conversation item");
      return parsed as ClientEvent;
    case "input.transcript.partial":
      if (typeof candidate.text !== "string" || candidate.text.length > 4000) throw new Error("Invalid partial transcript");
      return parsed as ClientEvent;
    case "input_audio.start":
    case "input_audio.stop":
    case "response.cancel":
      return parsed as ClientEvent;
    default:
      throw new Error("Unsupported realtime event type");
  }
}
