import type { IntentPlanner, PlannerDecision, PlannerInput } from "./types";

export const handoffPattern = /human|agent|representative|complaint|fraud|dispute|hardship|cannot pay|can't pay|job loss|pareshan|shikayat|insaan/i;
export const paymentPattern = /pay|payment|link|upi|bhugtan|bhej/i;
export const summaryPattern = /due|date|when|last date|kitna|amount|emi|balance|kitne/i;

export class DeterministicPlanner implements IntentPlanner {
  readonly name = "deterministic";

  async plan(input: PlannerInput): Promise<PlannerDecision> {
    if (handoffPattern.test(input.message)) return this.decision("handoff", 0.99, "Explicit escalation or sensitive-support phrase");
    if (paymentPattern.test(input.message)) return this.decision("payment_link", 0.96, "Explicit payment-link phrase");
    if (summaryPattern.test(input.message)) return this.decision("loan_summary", 0.94, "Explicit loan-summary phrase");
    return this.decision("clarify", 0.55, "No supported servicing intent matched");
  }

  async health() {
    return "ready" as const;
  }

  private decision(intent: PlannerDecision["intent"], confidence: number, reason: string): PlannerDecision {
    return { intent, confidence, reason, source: "deterministic" };
  }
}
