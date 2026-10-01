"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSession, PublicAgentSession } from "@/lib/domain";
import type { ClientEvent, RuntimeTelemetry, ServerEvent } from "@/lib/realtime/protocol";

export type ConversationMessage = { role: "agent" | "caller" | "system"; text: string };
export type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

const greeting = "Welcome to Vaani Loan Service. This demo uses fictional borrower data. Please say the six-digit demo OTP to begin.";

function websocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/realtime`;
}

function decodePcm16(base64: string) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Int16Array(bytes.buffer);
}

export function useRealtimeAgent() {
  const [session, setSession] = useState<PublicAgentSession | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([{ role: "agent", text: greeting }]);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [listening, setListening] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [partialTranscript, setPartialTranscript] = useState("");
  const [telemetry, setTelemetry] = useState<RuntimeTelemetry | null>(null);
  const [provider, setProvider] = useState("initializing");
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manuallyClosedRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const mediaRef = useRef<{ stream: MediaStream; context: AudioContext; node: AudioWorkletNode } | null>(null);
  const outputContextRef = useRef<AudioContext | null>(null);
  const nextPlaybackAtRef = useRef(0);
  const capabilitiesRef = useRef({ externalAsr: false, streamingOutputAudio: false });
  const sessionRef = useRef<PublicAgentSession | null>(null);

  const sendEvent = useCallback((event: ClientEvent) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(event));
    return true;
  }, []);

  const playPcm = useCallback((audio: string, sampleRate: number) => {
    const context = outputContextRef.current ?? new AudioContext({ sampleRate });
    outputContextRef.current = context;
    const pcm = decodePcm16(audio);
    const buffer = context.createBuffer(1, pcm.length, sampleRate);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < pcm.length; index += 1) samples[index] = pcm[index] / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.02, nextPlaybackAtRef.current);
    source.start(startAt);
    nextPlaybackAtRef.current = startAt + buffer.duration;
  }, []);

  const speak = useCallback((text: string, language: AgentSession["language"]) => {
    if (capabilitiesRef.current.streamingOutputAudio || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = language;
    utterance.rate = 1.02;
    window.speechSynthesis.speak(utterance);
  }, []);

  const handleServerEvent = useCallback((event: ServerEvent) => {
    switch (event.type) {
      case "session.ready":
        sessionRef.current = event.session;
        setSession(event.session);
        capabilitiesRef.current = event.capabilities;
        setProvider(event.capabilities.provider);
        setConnection("connected");
        setError(null);
        return;
      case "session.updated":
        sessionRef.current = event.session;
        setSession(event.session);
        return;
      case "input.transcript.partial":
        setPartialTranscript(event.text);
        return;
      case "input.transcript.final":
        setPartialTranscript("");
        setMessages((current) => [...current, { role: "caller", text: event.text }]);
        return;
      case "input_audio.speech_started":
        window.speechSynthesis?.cancel();
        sendEvent({ type: "response.cancel" });
        return;
      case "agent.thinking":
        setThinking(true);
        return;
      case "agent.response": {
        setThinking(false);
        setMessages((current) => [...current, { role: "agent", text: event.text }]);
        speak(event.text, sessionRef.current?.language ?? "en-IN");
        return;
      }
      case "output_audio.delta":
        playPcm(event.audio, event.sampleRate);
        return;
      case "output_audio.done":
        return;
      case "telemetry.updated":
        setTelemetry(event.telemetry);
        return;
      case "error":
        setThinking(false);
        setError(event.message);
        if (!event.recoverable) setConnection("disconnected");
        return;
      case "input_audio.speech_stopped":
        return;
    }
  }, [playPcm, sendEvent, speak]);

  useEffect(() => {
    manuallyClosedRef.current = false;

    function connect() {
      setConnection((current) => current === "connected" ? "connected" : "connecting");
      const socket = new WebSocket(websocketUrl());
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      socket.onopen = () => {
        socket.send(JSON.stringify({
          type: "session.start",
          config: { language: "en-IN", inputAudio: { format: "pcm16", sampleRate: 16000, channels: 1 } },
        } satisfies ClientEvent));
      };
      socket.onmessage = (message) => {
        if (typeof message.data !== "string") return;
        try {
          handleServerEvent(JSON.parse(message.data) as ServerEvent);
        } catch {
          setError("The realtime server returned an invalid event.");
        }
      };
      socket.onerror = () => setError("Could not reach the realtime voice runtime.");
      socket.onclose = () => {
        socketRef.current = null;
        if (manuallyClosedRef.current) {
          setConnection("disconnected");
          return;
        }
        setConnection("reconnecting");
        reconnectRef.current = setTimeout(connect, 1500);
      };
    }

    connect();
    return () => {
      manuallyClosedRef.current = true;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      socketRef.current?.close();
    };
  }, [handleServerEvent]);

  const sendText = useCallback((text: string, source: "text" | "browser_asr" = "text") => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    window.speechSynthesis?.cancel();
    setError(null);
    return sendEvent({ type: "conversation.item.create", text: trimmed, source });
  }, [sendEvent]);

  const stopListening = useCallback(async () => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    const media = mediaRef.current;
    mediaRef.current = null;
    if (media) {
      media.node.disconnect();
      media.stream.getTracks().forEach((track) => track.stop());
      await media.context.close();
    }
    sendEvent({ type: "input_audio.stop" });
    setListening(false);
  }, [sendEvent]);

  const startListening = useCallback(async () => {
    if (listening || connection !== "connected") return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const context = new AudioContext({ sampleRate: 16000 });
      await context.audioWorklet.addModule("/pcm-capture-processor.js");
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, "pcm-capture-processor");
      node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) socket.send(event.data);
      };
      source.connect(node);
      mediaRef.current = { stream, context, node };
      sendEvent({ type: "input_audio.start" });
      setListening(true);

      if (!capabilitiesRef.current.externalAsr) {
        const Constructor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
        if (!Constructor) {
          setError("PCM streaming is active, but this browser has no fallback ASR. Configure VOICE_INFERENCE_WS_URL for server-side transcription.");
          return;
        }
        const recognition = new Constructor();
        recognition.lang = sessionRef.current?.language ?? "en-IN";
        recognition.interimResults = true;
        recognition.continuous = true;
        recognition.onresult = (event) => {
          let partial = "";
          for (let index = event.resultIndex; index < event.results.length; index += 1) {
            const result = event.results[index];
            const transcript = result?.[0]?.transcript?.trim();
            if (!transcript) continue;
            if (result.isFinal) sendText(transcript, "browser_asr");
            else partial += `${transcript} `;
          }
          const text = partial.trim();
          setPartialTranscript(text);
          if (text) sendEvent({ type: "input.transcript.partial", text });
        };
        recognition.onerror = () => setError("Browser ASR stopped unexpectedly; PCM streaming remains available.");
        recognition.onend = () => {
          if (mediaRef.current && recognitionRef.current === recognition) {
            try { recognition.start(); } catch { /* browser is already restarting */ }
          }
        };
        recognitionRef.current = recognition;
        recognition.start();
      }
    } catch (cause) {
      await stopListening();
      setError(cause instanceof Error ? cause.message : "Microphone access failed");
    }
  }, [connection, listening, sendEvent, sendText, stopListening]);

  useEffect(() => () => { void stopListening(); }, [stopListening]);

  return {
    session,
    messages,
    connection,
    listening,
    thinking,
    partialTranscript,
    telemetry,
    provider,
    error,
    sendText,
    startListening,
    stopListening,
  };
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognition;
    webkitSpeechRecognition?: new () => SpeechRecognition;
  }
  interface SpeechRecognition extends EventTarget {
    lang: string;
    interimResults: boolean;
    continuous: boolean;
    onresult: ((event: SpeechRecognitionEvent) => void) | null;
    onerror: (() => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
  }
  interface SpeechRecognitionEvent extends Event {
    resultIndex: number;
    results: SpeechRecognitionResultList;
  }
}
