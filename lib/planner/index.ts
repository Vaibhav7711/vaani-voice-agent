import { DeterministicPlanner, handoffPattern, paymentPattern } from "./deterministic";
import { OpenAiCompatiblePlanner } from "./llm";
import type { IntentPlanner, PlannerDecision, PlannerInput } from "./types";

const fallback = new DeterministicPlanner();
let planner: IntentPlanner | null = null;

function configuredPlanner(): IntentPlanner {
  if (planner) return planner;
  const baseUrl = process.env.LLM_BASE_URL;
  const model = process.env.LLM_MODEL;
  planner = baseUrl && model
    ? new OpenAiCompatiblePlanner({
        baseUrl,
        model,
        apiKey: process.env.LLM_API_KEY,
        timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 1800),
      })
    : fallback;
  return planner;
}

export async function planServicingIntent(input: PlannerInput): Promise<PlannerDecision> {
  let decision: PlannerDecision;
  try {
    decision = await configuredPlanner().plan(input);
  } catch {
    decision = await fallback.plan(input);
  }

  return enforcePlannerDecision(input, decision);
}

export function enforcePlannerDecision(input: PlannerInput, decision: PlannerDecision): PlannerDecision {
  // Safety-critical escalation is lexical and cannot be downgraded by a model.
  if (handoffPattern.test(input.message)) {
    return { intent: "handoff", confidence: 1, reason: "Policy-enforced escalation", source: "policy_override" };
  }

  if (decision.confidence < 0.72) {
    return { intent: "clarify", confidence: decision.confidence, reason: "Decision below execution threshold", source: "policy_override" };
  }

  // Sending a payment link is side-effecting. The caller must say a payment/link phrase explicitly.
  if (decision.intent === "payment_link" && !paymentPattern.test(input.message)) {
    return { intent: "clarify", confidence: decision.confidence, reason: "Payment intent lacked explicit caller authorization", source: "policy_override" };
  }
  return decision;
}

export function plannerName() {
  return configuredPlanner().name;
}

export async function plannerHealth() {
  if (!process.env.LLM_BASE_URL || !process.env.LLM_MODEL) return "not_configured" as const;
  return configuredPlanner().health();
}

export type { IntentPlanner, PlannerDecision, PlannerInput } from "./types";
