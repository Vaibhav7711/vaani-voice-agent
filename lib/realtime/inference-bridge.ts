import WebSocket from "ws";
import type { ClientEvent, ServerEvent } from "./protocol";

export type BridgeHandlers = {
  onEvent: (event: ServerEvent) => void;
  onFinalTranscript: (text: string) => void;
  onError: (message: string) => void;
};

export type InferenceControlEvent = ClientEvent | {
  type: "response.create";
  text: string;
  language: "en-IN" | "hi-IN";
};

export interface InferenceBridge {
  readonly name: string;
  readonly externalAsr: boolean;
  readonly streamingOutputAudio: boolean;
  connect(handlers: BridgeHandlers): Promise<void>;
  sendControl(event: InferenceControlEvent): void;
  sendAudio(frame: Buffer): void;
  cancelResponse(): void;
  close(): void;
}

export class BrowserFallbackBridge implements InferenceBridge {
  readonly name = "browser-fallback";
  readonly externalAsr = false;
  readonly streamingOutputAudio = false;
  async connect() {}
  sendControl() {}
  sendAudio() {}
  cancelResponse() {}
  close() {}
}

export class ExternalWebSocketBridge implements InferenceBridge {
  readonly name: string;
  readonly externalAsr = true;
  readonly streamingOutputAudio: boolean;
  private socket?: WebSocket;
  private handlers?: BridgeHandlers;
  private pending: Array<string | Buffer> = [];
  private intentionallyClosed = false;

  constructor(
    private readonly url: string,
    private readonly token?: string,
    outputAudio = false,
    providerName = "external-websocket",
  ) {
    this.streamingOutputAudio = outputAudio;
    this.name = providerName;
  }

  async connect(handlers: BridgeHandlers) {
    this.handlers = handlers;
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url, this.token ? { headers: { Authorization: `Bearer ${this.token}` } } : undefined);
      this.socket = socket;
      const timeout = setTimeout(() => {
        socket.terminate();
        reject(new Error("Inference provider connection timed out"));
      }, 10_000);
      socket.once("open", () => {
        clearTimeout(timeout);
        for (const value of this.pending) socket.send(value);
        this.pending = [];
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      socket.on("message", (data, binary) => {
        if (binary) return;
        this.receive(data.toString());
      });
      socket.on("error", (error) => handlers.onError(`Inference bridge error: ${error.message}`));
      socket.on("close", () => {
        clearTimeout(timeout);
        if (!this.intentionallyClosed) handlers.onError("Inference bridge disconnected");
      });
    });
  }

  private receive(raw: string) {
    if (!this.handlers) return;
    try {
      const event = JSON.parse(raw) as ServerEvent;
      if (event.type === "input.transcript.final") {
        if (typeof event.text !== "string" || !event.text.trim() || event.text.length > 4000) {
          throw new Error("Invalid final transcript");
        }
        this.handlers.onFinalTranscript(event.text.trim());
        return;
      }
      if (event.type === "input.transcript.partial" && typeof event.text === "string" && event.text.length <= 4000) {
        this.handlers.onEvent(event);
        return;
      }
      if (
        event.type === "output_audio.delta" &&
        typeof event.audio === "string" && event.audio.length <= 512_000 &&
        Number.isInteger(event.sampleRate) && event.sampleRate >= 8000 && event.sampleRate <= 48000
      ) {
        this.handlers.onEvent(event);
        return;
      }
      if (event.type === "output_audio.done" || event.type === "error") {
        this.handlers.onEvent(event);
        return;
      }
    } catch (error) {
      this.handlers.onError(error instanceof Error ? `Invalid inference event: ${error.message}` : "Inference bridge returned an invalid event");
    }
  }

  private send(value: string | Buffer) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(value);
    else this.pending.push(value);
  }

  sendControl(event: InferenceControlEvent) {
    this.send(JSON.stringify(event));
  }

  sendAudio(frame: Buffer) {
    this.send(frame);
  }

  cancelResponse() {
    this.send(JSON.stringify({ type: "response.cancel" }));
  }

  close() {
    this.intentionallyClosed = true;
    this.pending = [];
    this.socket?.close();
  }
}

export function createInferenceBridge(): InferenceBridge {
  const url = process.env.VOICE_INFERENCE_WS_URL;
  if (!url) return new BrowserFallbackBridge();
  return new ExternalWebSocketBridge(
    url,
    process.env.VOICE_INFERENCE_API_KEY,
    process.env.VOICE_INFERENCE_OUTPUT_AUDIO === "true",
    process.env.VOICE_INFERENCE_PROVIDER_NAME,
  );
}
