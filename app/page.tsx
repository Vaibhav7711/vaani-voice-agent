"use client";

import { FormEvent, useState } from "react";
import type { AuditEvent } from "@/lib/domain";
import { useRealtimeAgent } from "@/hooks/use-realtime-agent";

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function formatDuration(milliseconds?: number) {
  if (milliseconds === undefined) return "—";
  return milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(1)}s`;
}

export default function Home() {
  const [input, setInput] = useState("");
  const {
    session, messages, connection, listening, thinking, partialTranscript,
    telemetry, provider, error, sendText, startListening, stopListening,
  } = useRealtimeAgent();

  function send(message: string) {
    if (sendText(message)) setInput("");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    send(input);
  }

  const events: AuditEvent[] = session?.events ?? [];
  const connected = connection === "connected";

  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">VOICE INTELLIGENCE · FICTIONAL DEMO</p>
          <h1>Vaani Loan Service</h1>
        </div>
        <div className={`system-status ${connected ? "online" : "offline"}`}>
          <span /> {connection === "reconnecting" ? "Reconnecting voice runtime" : `Runtime ${connection}`}
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">ENTITY-SAFE · STREAMING · AUDITABLE</p>
          <h2>Loan servicing that knows when it should not guess.</h2>
          <p>Live PCM audio transport, guarded servicing tools, controlled handoffs, and call-level observability over one real-time session.</p>
        </div>
        <div className="metrics">
          <div><strong>{formatDuration(telemetry?.lastTurnLatencyMs)}</strong><span>last agent turn</span></div>
          <div><strong>{telemetry ? `${(telemetry.audioDurationMs / 1000).toFixed(1)}s` : "0.0s"}</strong><span>audio streamed</span></div>
          <div><strong className="provider-name">{provider}</strong><span>inference provider</span></div>
        </div>
      </section>

      <section className="workspace">
        <article className="conversation card">
          <div className="card-heading">
            <div><p className="eyebrow">LIVE CONVERSATION</p><h3>Borrower session</h3></div>
            <span className={`badge ${session?.verified ? "verified" : "pending"}`}>{session?.verified ? "Verified" : "OTP required"}</span>
          </div>
          {error && <div className="runtime-error" role="alert">{error}</div>}
          <div className="messages" aria-live="polite">
            {messages.map((message, index) => (
              <div className={`message ${message.role}`} key={`${message.role}-${index}`}>
                <span>{message.role === "agent" ? "VAANI" : message.role === "caller" ? "CALLER" : "SYSTEM"}</span>
                <p>{message.text}</p>
              </div>
            ))}
            {partialTranscript && <div className="message caller partial"><span>CALLER · LIVE</span><p>{partialTranscript}</p></div>}
            {thinking && <div className="message agent"><span>VAANI</span><p className="typing">Checking permitted tools…</p></div>}
          </div>

          <div className="voice-strip">
            <span className={`audio-indicator ${listening ? "active" : ""}`} />
            <div><strong>{listening ? "Microphone streaming" : "Microphone idle"}</strong><small>16 kHz · PCM16 · mono · 20 ms frames</small></div>
            <span className="audio-bytes">{telemetry ? `${Math.round(telemetry.audioBytes / 1024)} KB` : "0 KB"}</span>
          </div>

          <div className="suggestions">
            <button onClick={() => send("482931")} disabled={!connected}>Demo OTP: 482931</button>
            <button onClick={() => send("Mera EMI amount aur due date kya hai?")} disabled={!connected}>Ask about EMI</button>
            <button onClick={() => send("Please send the payment link")} disabled={!connected}>Request payment link</button>
            <button onClick={() => send("I need a human agent")} disabled={!connected}>Escalate to human</button>
          </div>
          <form onSubmit={submit} className="composer">
            <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="Type or speak your request…" disabled={!connected || thinking} />
            <button type="button" onClick={() => void (listening ? stopListening() : startListening())} className={listening ? "recording" : ""} disabled={!connected}>{listening ? "Stop" : "Stream mic"}</button>
            <button type="submit" disabled={!connected || thinking || !input.trim()}>Send</button>
          </form>
        </article>

        <aside className="side-column">
          <article className="card customer-card">
            <p className="eyebrow">SECURE CONTEXT</p>
            <h3>{session?.verified && session.customerName ? session.customerName : "Identity not verified"}</h3>
            <dl className={!session?.verified ? "locked-data" : ""}>
              <div><dt>Loan account</dt><dd>{session?.verified && session.loan ? session.loan.accountNumberMasked : "Locked"}</dd></div>
              <div><dt>Product</dt><dd>{session?.verified && session.loan ? session.loan.product : "Locked"}</dd></div>
              <div><dt>Monthly EMI</dt><dd>{session?.verified && session.loan ? `₹${session.loan.monthlyEmi.toLocaleString("en-IN")}` : "Locked"}</dd></div>
              <div><dt>Due date</dt><dd>{session?.verified && session.loan ? session.loan.dueDate : "Locked"}</dd></div>
            </dl>
            <p className="data-note">Fictional demo data. Account details unlock only after server-side OTP verification.</p>
          </article>
          <article className="card timeline-card">
            <p className="eyebrow">AUDIT TIMELINE</p>
            <h3>Every sensitive action is visible.</h3>
            <ol className="timeline">
              {events.slice().reverse().map((item) => (
                <li className={item.level} key={item.id}><span className="dot" /><div><small>{formatTime(item.at)} · {item.label}</small><p>{item.detail}</p></div></li>
              ))}
            </ol>
          </article>
        </aside>
      </section>
    </main>
  );
}
