import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { newDb } from "pg-mem";
import type { AgentSession } from "../lib/domain";
import { LocalSessionLock } from "../lib/infrastructure/session-lock";
import { SessionCodec } from "../lib/infrastructure/session-codec";
import { InMemorySessionStore, PostgresSessionStore } from "../lib/infrastructure/session-store";

function session(): AgentSession {
  return {
    id: "f5cb72fc-4f0a-4ab7-953d-6c6f14b8e8e0",
    stage: "verification",
    verified: false,
    verificationAttempts: 0,
    customerName: "Test Borrower",
    language: "en-IN",
    loan: {
      accountNumberMasked: "•••• 0001",
      product: "Test Loan",
      monthlyEmi: 1000,
      dueDate: "2026-10-05",
      outstandingBalance: 10000,
      status: "current",
    },
    events: [],
  };
}

test("memory repository does not expose mutable stored references", async () => {
  const store = new InMemorySessionStore();
  await store.initialize();
  const original = session();
  await store.create(original);
  original.verified = true;
  const loaded = await store.get(original.id);
  assert.equal(loaded?.verified, false);
  if (loaded) loaded.customerName = "Mutated";
  assert.equal((await store.get(original.id))?.customerName, "Test Borrower");
});

test("local session lock serializes concurrent turns for the same session", async () => {
  const lock = new LocalSessionLock();
  const order: string[] = [];
  const first = lock.runExclusive("session", async () => {
    order.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("first:end");
  });
  const second = lock.runExclusive("session", async () => {
    order.push("second:start");
    order.push("second:end");
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
});

test("persistent session codec encrypts state and rejects the wrong key", () => {
  const firstKey = Buffer.alloc(32, 7).toString("base64");
  const secondKey = Buffer.alloc(32, 8).toString("base64");
  const codec = new SessionCodec(firstKey);
  const encrypted = codec.encrypt(session());
  assert.doesNotMatch(encrypted.ciphertext, /Test Borrower|Test Loan/);
  assert.deepEqual(codec.decrypt(encrypted), session());
  assert.throws(() => new SessionCodec(secondKey).decrypt(encrypted));
});

test("PostgreSQL repository persists encrypted sessions", async () => {
  const database = newDb();
  const adapter = database.adapters.createPg();
  const pool = new adapter.Pool() as unknown as Pool;
  const codec = new SessionCodec(Buffer.alloc(32, 9).toString("base64"));
  const store = new PostgresSessionStore(pool, null, codec);
  await store.initialize();
  const value = session();
  await store.create(value);
  const loaded = await store.get(value.id);
  assert.deepEqual(loaded, value);

  const raw = await pool.query<{ state: unknown }>("SELECT state FROM agent_sessions WHERE id = $1", [value.id]);
  const serialized = JSON.stringify(raw.rows[0].state);
  assert.doesNotMatch(serialized, /Test Borrower|Test Loan|10000/);

  if (loaded) {
    loaded.verified = true;
    await store.save(loaded);
  }
  assert.equal((await store.get(value.id))?.verified, true);
  await store.close();
});
