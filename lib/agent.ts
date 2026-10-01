import { randomUUID } from "node:crypto";
import type { AgentReply, AgentSession, AuditEvent, EventLevel } from "./domain";
import { getSessionStore, withSessionLock } from "./infrastructure";
import { createPaymentLink, getLoanSummary, verifyOtp } from "./mock-lender";
import { planServicingIntent } from "./planner";

function event(label: string, detail: string, level: EventLevel = "info"): AuditEvent {
  return { id: randomUUID(), at: new Date().toISOString(), label, detail, level };
}

function addEvent(session: AgentSession, label: string, detail: string, level: EventLevel = "info") {
  session.events = [...session.events, event(label, detail, level)];
}

export async function createSession(): Promise<AgentSession> {
  const loan = await getLoanSummary();
  const session: AgentSession = {
    id: randomUUID(),
    stage: "verification",
    verified: false,
    verificationAttempts: 0,
    customerName: "Aarav Sharma",
    language: "en-IN",
    loan,
    events: [
      event("Session opened", "Demo borrower session created with fictional data."),
      event("Consent required", "Financial details remain blocked until OTP verification.", "warning"),
    ],
  };
  const store = await getSessionStore();
  await store.create(session);
  return session;
}

async function persistReply(
  session: AgentSession,
  reply: string,
  toolCalls: string[] = [],
  requiresConfirmation = false,
): Promise<AgentReply> {
  const store = await getSessionStore();
  await store.save(session);
  return { session, reply, toolCalls, requiresConfirmation };
}

function isHindi(text: string) {
  return /[\u0900-\u097F]/.test(text) || /\b(mera|meri|mujhe|kitna|kab|emi|bhugtan|madad)\b/i.test(text);
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(`${date}T00:00:00+05:30`));
}

export async function handleTurn(sessionId: string, message: string): Promise<AgentReply> {
  return withSessionLock(sessionId, async () => {
    const store = await getSessionStore();
    const session = await store.get(sessionId);
    if (!session) throw new Error("Session not found. Start a new session.");

    addEvent(session, "Caller utterance", message);
    session.language = isHindi(message) ? "hi-IN" : "en-IN";

    if (session.stage === "verification") return handleVerification(session, message);
    if (session.stage === "handoff") {
      return persistReply(session, "A support specialist has been requested. Please stay on the line.");
    }

    const decision = await planServicingIntent({
      message,
      language: session.language,
      stage: session.stage,
      verified: session.verified,
    });
    addEvent(
      session,
      "Intent planned",
      `${decision.intent} · ${decision.source} · confidence ${decision.confidence.toFixed(2)}`,
      decision.source === "policy_override" ? "warning" : "info",
    );

    switch (decision.intent) {
      case "handoff":
        return handleHandoff(session);
      case "payment_link":
        return handlePaymentLink(session);
      case "loan_summary":
        return handleLoanSummary(session);
      case "clarify":
        addEvent(session, "Safe clarification", "No financial action executed because intent was not confidently classified.", "warning");
        return persistReply(
          session,
          session.language === "hi-IN"
            ? "Main EMI amount, due date, payment link, repayment status, ya human support mein madad kar sakti hoon. Aap kya karna chahenge?"
            : "I can help with your EMI amount, due date, payment link, repayment status, or human support. What would you like to do?",
        );
    }
  });
}

async function handleVerification(session: AgentSession, message: string) {
  const valid = await verifyOtp(message);
  if (!valid) {
    session.verificationAttempts += 1;
    if (session.verificationAttempts >= 3) {
      session.stage = "handoff";
      addEvent(session, "Verification locked", "Three invalid OTP attempts triggered a safe human handoff.", "risk");
      return persistReply(
        session,
        "Verification has been locked after three unsuccessful attempts. I’m routing this session to a human support specialist without revealing account information.",
        ["create_handoff_ticket"],
      );
    }
    addEvent(session, "OTP rejected", "Verification failed; account data remains unavailable.", "risk");
    return persistReply(
      session,
      session.language === "hi-IN"
        ? "Main aapke account ki details tabhi share kar sakti hoon jab verification complete ho. Kripya 6 digit demo OTP boliye."
        : "I can share account details only after verification. Please say the six-digit demo OTP.",
      ["verify_otp"],
    );
  }

  session.verified = true;
  session.verificationAttempts = 0;
  session.stage = "servicing";
  addEvent(session, "OTP verified", "Borrower identity verified. Read-only loan tools unlocked.", "success");
  return persistReply(
    session,
    session.language === "hi-IN"
      ? `Verification complete ho gaya hai, ${session.customerName}. Aapki ${session.loan.product} EMI, due date, payment link, ya repayment status mein main madad kar sakti hoon.`
      : `Verification is complete, ${session.customerName}. I can help with your ${session.loan.product} EMI, due date, payment link, or repayment status.`,
    ["verify_otp"],
  );
}

async function handleHandoff(session: AgentSession) {
  session.stage = "handoff";
  addEvent(session, "Human handoff requested", "Sensitive or unsupported servicing request routed to an agent queue.", "risk");
  return persistReply(
    session,
    session.language === "hi-IN"
      ? "Main aapko human support specialist se connect kar rahi hoon. Aapki verified details aur call summary securely share ki jayegi."
      : "I’m connecting you to a human support specialist. Your verified context and call summary will be shared securely.",
    ["create_handoff_ticket"],
  );
}

async function handlePaymentLink(session: AgentSession) {
  const payment = await createPaymentLink(session.loan);
  addEvent(session, "Payment link created", `A payment link for ₹${payment.amount.toLocaleString("en-IN")} was issued; expires ${payment.expiresAt}.`, "success");
  return persistReply(
    session,
    session.language === "hi-IN"
      ? `Aapki ₹${payment.amount.toLocaleString("en-IN")} EMI ke liye secure payment link registered mobile number par bhej diya gaya hai. Link ${formatDate(session.loan.dueDate)} tak valid hai. Payment complete hone ke baad confirmation message aayega.`
      : `I have sent a secure payment link for your ₹${payment.amount.toLocaleString("en-IN")} EMI to your registered mobile number. It is valid until ${formatDate(session.loan.dueDate)}. You will receive confirmation after payment succeeds.`,
    ["create_payment_link", "send_payment_notification"],
  );
}

async function handleLoanSummary(session: AgentSession) {
  addEvent(session, "Loan summary read", "Read-only loan summary returned after verified tool call.", "success");
  return persistReply(
    session,
    session.language === "hi-IN"
      ? `Aapki ${session.loan.product} account ${session.loan.accountNumberMasked} ki EMI ₹${session.loan.monthlyEmi.toLocaleString("en-IN")} hai aur due date ${formatDate(session.loan.dueDate)} hai. Kya main secure payment link bheju?`
      : `For your ${session.loan.product} account ending ${session.loan.accountNumberMasked}, the EMI is ₹${session.loan.monthlyEmi.toLocaleString("en-IN")} and it is due on ${formatDate(session.loan.dueDate)}. Would you like me to send a secure payment link?`,
    ["get_loan_summary"],
    true,
  );
}
