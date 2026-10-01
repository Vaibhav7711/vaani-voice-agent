import type { Pool } from "pg";
import type { createClient } from "redis";
import { z } from "zod";
import type { AgentSession } from "../domain";
import type { SessionCodec } from "./session-codec";

type RedisClient = ReturnType<typeof createClient>;

const eventSchema = z.object({
  id: z.string(),
  at: z.string(),
  label: z.string(),
  detail: z.string(),
  level: z.enum(["info", "success", "warning", "risk"]),
});

const sessionSchema = z.object({
  id: z.string(),
  stage: z.enum(["verification", "servicing", "handoff"]),
  verified: z.boolean(),
  verificationAttempts: z.number().int().nonnegative(),
  customerName: z.string(),
  language: z.enum(["en-IN", "hi-IN"]),
  loan: z.object({
    accountNumberMasked: z.string(),
    product: z.string(),
    monthlyEmi: z.number().nonnegative(),
    dueDate: z.string(),
    outstandingBalance: z.number().nonnegative(),
    status: z.enum(["current", "overdue"]),
  }),
  events: z.array(eventSchema),
});

export type StoreHealth = {
  store: "memory" | "postgres";
  database: "not_configured" | "ready" | "unavailable";
  cache: "not_configured" | "ready" | "unavailable";
};

export interface SessionStore {
  readonly kind: StoreHealth["store"];
  initialize(): Promise<void>;
  create(session: AgentSession): Promise<void>;
  get(id: string): Promise<AgentSession | null>;
  save(session: AgentSession): Promise<void>;
  health(): Promise<StoreHealth>;
  close(): Promise<void>;
}

function clone(session: AgentSession) {
  return structuredClone(session);
}

export class InMemorySessionStore implements SessionStore {
  readonly kind = "memory" as const;
  private readonly sessions = new Map<string, AgentSession>();

  async initialize() {}

  async create(session: AgentSession) {
    if (this.sessions.has(session.id)) throw new Error("Session already exists");
    this.sessions.set(session.id, clone(session));
  }

  async get(id: string) {
    const session = this.sessions.get(id);
    return session ? clone(session) : null;
  }

  async save(session: AgentSession) {
    if (!this.sessions.has(session.id)) throw new Error("Cannot save a missing session");
    this.sessions.set(session.id, clone(session));
  }

  async health(): Promise<StoreHealth> {
    return { store: "memory", database: "not_configured", cache: "not_configured" };
  }

  async close() {
    this.sessions.clear();
  }
}

export class PostgresSessionStore implements SessionStore {
  readonly kind = "postgres" as const;
  private readonly cacheTtlSeconds = 60 * 60;

  constructor(
    private readonly pool: Pool,
    private readonly redis: RedisClient | null,
    private readonly codec: SessionCodec,
  ) {}

  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id UUID PRIMARY KEY,
        state JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query("CREATE INDEX IF NOT EXISTS agent_sessions_updated_at_idx ON agent_sessions (updated_at DESC)");
  }

  private cacheKey(id: string) {
    return `vaani:session:${id}`;
  }

  private async cache(session: AgentSession) {
    if (!this.redis) return;
    await this.redis.set(this.cacheKey(session.id), JSON.stringify(this.codec.encrypt(session)), { EX: this.cacheTtlSeconds });
  }

  async create(session: AgentSession) {
    await this.pool.query(
      "INSERT INTO agent_sessions (id, state) VALUES ($1, $2::jsonb)",
      [session.id, JSON.stringify(this.codec.encrypt(session))],
    );
    await this.cache(session);
  }

  async get(id: string) {
    if (this.redis) {
      const cached = await this.redis.get(this.cacheKey(id));
      if (cached) return sessionSchema.parse(this.codec.decrypt(JSON.parse(cached))) as AgentSession;
    }
    const result = await this.pool.query<{ state: unknown }>("SELECT state FROM agent_sessions WHERE id = $1", [id]);
    if (result.rowCount === 0) return null;
    const session = sessionSchema.parse(this.codec.decrypt(result.rows[0].state)) as AgentSession;
    await this.cache(session);
    return session;
  }

  async save(session: AgentSession) {
    const result = await this.pool.query(
      "UPDATE agent_sessions SET state = $2::jsonb, updated_at = NOW() WHERE id = $1",
      [session.id, JSON.stringify(this.codec.encrypt(session))],
    );
    if (result.rowCount !== 1) throw new Error("Cannot save a missing session");
    await this.cache(session);
  }

  async health(): Promise<StoreHealth> {
    let database: StoreHealth["database"] = "unavailable";
    let cache: StoreHealth["cache"] = this.redis ? "unavailable" : "not_configured";
    try {
      await this.pool.query("SELECT 1");
      database = "ready";
    } catch {}
    if (this.redis) {
      try {
        cache = (await this.redis.ping()) === "PONG" ? "ready" : "unavailable";
      } catch {}
    }
    return { store: "postgres", database, cache };
  }

  async close() {
    if (this.redis?.isOpen) await this.redis.quit();
    await this.pool.end();
  }
}
