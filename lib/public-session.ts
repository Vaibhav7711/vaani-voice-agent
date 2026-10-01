import type { AgentSession, PublicAgentSession } from "./domain";

export function toPublicSession(session: AgentSession): PublicAgentSession {
  return {
    id: session.id,
    stage: session.stage,
    verified: session.verified,
    verificationAttempts: session.verificationAttempts,
    customerName: session.verified ? session.customerName : null,
    language: session.language,
    loan: session.verified ? session.loan : null,
    events: session.events,
  };
}
