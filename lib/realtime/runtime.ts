import type WebSocket from "ws";
import { createSession, handleTurn } from "../agent";
import type { AgentSession } from "../domain";
import { toPublicSession } from "../public-session";
import { createInferenceBridge, type InferenceBridge } from "./inference-bridge";
import { parseClientEvent, type ClientEvent, type RuntimeTelemetry, type ServerEvent } from "./protocol";
import { PcmVoiceActivityDetector } from "./vad";

export class RealtimeAgentRuntime {
  private session?: AgentSession;
  private readonly vad = new PcmVoiceActivityDetector();
  private readonly bridge: InferenceBridge;
  private turnInFlight = false;
  private closed = false;
  private telemetry: RuntimeTelemetry;

  constructor(private readonly socket: WebSocket, bridge = createInferenceBridge()) {
    this.bridge = bridge;
    this.telemetry = {
      audioBytes: 0,
      audioDurationMs: 0,
      provider: bridge.name,
      speechActive: false,
    };
  }

  async start() {
    await this.bridge.connect({
      onEvent: (event) => this.send(event),
      onFinalTranscript: (text) => void this.processTurn(text, "provider_asr"),
      onError: (message) => this.error("provider_error", message, true),
    });
  }

  async receiveText(raw: string) {
    let event: ClientEvent;
    try {
      event = parseClientEvent(raw);
    } catch (error) {
      this.error("invalid_event", error instanceof Error ? error.message : "Invalid realtime event", true);
      return;
    }

    switch (event.type) {
      case "session.start": {
        if (this.session) {
          this.error("session_exists", "This connection already has an active session", true);
          return;
        }
        this.session = await createSession();
        this.session.language = event.config.language;
        this.bridge.sendControl(event);
        this.send({
          type: "session.ready",
          session: toPublicSession(this.session),
          capabilities: {
            externalAsr: this.bridge.externalAsr,
            streamingOutputAudio: this.bridge.streamingOutputAudio,
            provider: this.bridge.name,
          },
        });
        this.sendTelemetry();
        return;
      }
      case "conversation.item.create":
        await this.processTurn(event.text, event.source);
        return;
      case "input.transcript.partial":
        this.send(event);
        return;
      case "input_audio.start":
      case "input_audio.stop":
        this.bridge.sendControl(event);
        return;
      case "response.cancel":
        this.bridge.cancelResponse();
        return;
    }
  }

  receiveAudio(frame: Buffer) {
    if (!this.session || this.closed) return;
    const now = new Date().toISOString();
    this.telemetry.audioBytes += frame.byteLength;
    this.telemetry.audioDurationMs = Math.round((this.telemetry.audioBytes / 2 / 16000) * 1000);
    this.telemetry.firstAudioAt ??= now;
    this.telemetry.lastAudioAt = now;
    this.bridge.sendAudio(frame);

    const transition = this.vad.push(frame);
    if (transition === "speech_started") {
      this.telemetry.speechActive = true;
      this.send({ type: "input_audio.speech_started" });
    } else if (transition === "speech_stopped") {
      this.telemetry.speechActive = false;
      this.send({ type: "input_audio.speech_stopped" });
    }
    if (transition || this.telemetry.audioBytes % 32000 < frame.byteLength) this.sendTelemetry();
  }

  private async processTurn(text: string, source: "text" | "browser_asr" | "provider_asr") {
    if (!this.session) {
      this.error("session_not_started", "Send session.start before creating conversation items", true);
      return;
    }
    const trimmed = text.trim();
    if (!trimmed || this.turnInFlight) {
      if (this.turnInFlight) this.error("turn_in_progress", "Wait for the active turn to finish", true);
      return;
    }

    this.turnInFlight = true;
    const started = performance.now();
    this.send({ type: "input.transcript.final", text: trimmed, source: source === "text" ? "browser_asr" : source });
    this.send({ type: "agent.thinking", startedAt: new Date().toISOString() });
    try {
      const reply = await handleTurn(this.session.id, trimmed);
      this.session = reply.session;
      const latencyMs = Math.max(1, Math.round(performance.now() - started));
      this.telemetry.lastTurnLatencyMs = latencyMs;
      this.send({ type: "session.updated", session: toPublicSession(reply.session) });
      this.send({ type: "agent.response", text: reply.reply, toolCalls: reply.toolCalls, latencyMs });
      if (this.bridge.streamingOutputAudio) {
        this.bridge.sendControl({ type: "response.create", text: reply.reply, language: reply.session.language });
      }
      this.sendTelemetry();
    } catch (error) {
      this.error("agent_error", error instanceof Error ? error.message : "Agent turn failed", true);
    } finally {
      this.turnInFlight = false;
    }
  }

  private send(event: ServerEvent) {
    if (!this.closed && this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(event));
  }

  private sendTelemetry() {
    this.send({ type: "telemetry.updated", telemetry: { ...this.telemetry } });
  }

  private error(code: string, message: string, recoverable: boolean) {
    this.send({ type: "error", code, message, recoverable });
  }

  close() {
    this.closed = true;
    this.bridge.close();
  }
}
