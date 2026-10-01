import assert from "node:assert/strict";
import test from "node:test";
import { createSession, handleTurn } from "../lib/agent";
import { toPublicSession } from "../lib/public-session";

test("loan data remains inaccessible before valid verification", async () => {
  const session = await createSession();
  const publicSession = toPublicSession(session);
  assert.equal(publicSession.customerName, null);
  assert.equal(publicSession.loan, null);
  const reply = await handleTurn(session.id, "Tell me the EMI amount and due date");
  assert.equal(reply.session.verified, false);
  assert.equal(reply.session.stage, "verification");
  assert.deepEqual(reply.toolCalls, ["verify_otp"]);
  assert.doesNotMatch(reply.reply, /15,000|October|4821/);
});

test("verification unlocks read-only loan servicing", async () => {
  const session = await createSession();
  const verified = await handleTurn(session.id, "482931");
  assert.equal(verified.session.verified, true);
  assert.equal(verified.session.stage, "servicing");
  assert.equal(toPublicSession(verified.session).loan?.monthlyEmi, 15000);

  const summary = await handleTurn(session.id, "Mera EMI amount aur due date kya hai?");
  assert.match(summary.reply, /₹15,000/);
  assert.deepEqual(summary.toolCalls, ["get_loan_summary"]);
  assert.equal(summary.requiresConfirmation, true);
});

test("three failed OTP attempts lock the session and create a handoff", async () => {
  const session = await createSession();
  await handleTurn(session.id, "111111");
  await handleTurn(session.id, "222222");
  const locked = await handleTurn(session.id, "333333");
  assert.equal(locked.session.verified, false);
  assert.equal(locked.session.stage, "handoff");
  assert.deepEqual(locked.toolCalls, ["create_handoff_ticket"]);
  assert.doesNotMatch(locked.reply, /15,000|October|4821/);
});

test("payment tools cannot be reached by embedding payment intent in an invalid OTP turn", async () => {
  const session = await createSession();
  const reply = await handleTurn(session.id, "Please pay 482930 and send a payment link");
  assert.equal(reply.session.verified, false);
  assert.deepEqual(reply.toolCalls, ["verify_otp"]);
});
