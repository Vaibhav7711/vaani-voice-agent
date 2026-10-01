export type SessionStage = "verification" | "servicing" | "handoff";
export type EventLevel = "info" | "success" | "warning" | "risk";

export type AuditEvent = {
  id: string;
  at: string;
  label: string;
  detail: string;
  level: EventLevel;
};

export type Loan = {
  accountNumberMasked: string;
  product: string;
  monthlyEmi: number;
  dueDate: string;
  outstandingBalance: number;
  status: "current" | "overdue";
};

export type AgentSession = {
  id: string;
  stage: SessionStage;
  verified: boolean;
  verificationAttempts: number;
  customerName: string;
  language: "en-IN" | "hi-IN";
  loan: Loan;
  events: AuditEvent[];
};

export type PublicAgentSession = Omit<AgentSession, "customerName" | "loan"> & {
  customerName: string | null;
  loan: Loan | null;
};

export type AgentReply = {
  session: AgentSession;
  reply: string;
  toolCalls: string[];
  requiresConfirmation?: boolean;
};
