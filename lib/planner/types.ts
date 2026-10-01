import type { AgentSession } from "../domain";

export type ServicingIntent = "loan_summary" | "payment_link" | "handoff" | "clarify";

export type PlannerDecision = {
  intent: ServicingIntent;
  confidence: number;
  reason: string;
  source: "deterministic" | "llm" | "policy_override";
};

export type PlannerInput = {
  message: string;
  language: AgentSession["language"];
  stage: AgentSession["stage"];
  verified: boolean;
};

export interface IntentPlanner {
  readonly name: string;
  plan(input: PlannerInput): Promise<PlannerDecision>;
  health(): Promise<"not_configured" | "ready" | "unavailable">;
}
