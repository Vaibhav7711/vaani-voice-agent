import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { enforcePlannerDecision } from "../lib/planner";
import { OpenAiCompatiblePlanner } from "../lib/planner/llm";
import type { PlannerInput } from "../lib/planner/types";

const baseInput: PlannerInput = {
  message: "Please show my EMI due date",
  language: "en-IN",
  stage: "servicing",
  verified: true,
};

test("policy blocks a model-inferred payment action without explicit caller language", () => {
  const result = enforcePlannerDecision(baseInput, {
    intent: "payment_link",
    confidence: 0.98,
    reason: "Model guessed a payment action",
    source: "llm",
  });
  assert.equal(result.intent, "clarify");
  assert.equal(result.source, "policy_override");
});

test("policy forces sensitive requests to human handoff", () => {
  const result = enforcePlannerDecision({ ...baseInput, message: "I lost my job and cannot pay" }, {
    intent: "loan_summary",
    confidence: 0.99,
    reason: "Incorrect model result",
    source: "llm",
  });
  assert.equal(result.intent, "handoff");
  assert.equal(result.source, "policy_override");
});

test("LLM planner accepts only the strict decision schema", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/chat/completions") {
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        intent: "loan_summary",
        confidence: 0.91,
        reason: "Caller requested EMI details",
      }) } }] }));
      return;
    }
    response.end(JSON.stringify({ data: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const planner = new OpenAiCompatiblePlanner({ baseUrl: `http://127.0.0.1:${address.port}`, model: "test" });
    const decision = await planner.plan(baseInput);
    assert.equal(decision.intent, "loan_summary");
    assert.equal(decision.source, "llm");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
