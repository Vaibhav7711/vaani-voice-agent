import { Pool } from "pg";
import { createClient } from "redis";
import { LocalSessionLock, RedisSessionLock, type SessionLock } from "./session-lock";
import { SessionCodec } from "./session-codec";
import { InMemorySessionStore, PostgresSessionStore, type SessionStore, type StoreHealth } from "./session-store";

let store: SessionStore = new InMemorySessionStore();
let lock: SessionLock = new LocalSessionLock();
let initialization: Promise<void> | null = null;

async function initialize() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    await store.initialize();
    return;
  }

  const encryptionKey = process.env.SESSION_ENCRYPTION_KEY;
  if (!encryptionKey) throw new Error("SESSION_ENCRYPTION_KEY is required when DATABASE_URL is configured");

  const pool = new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  });

  const redisUrl = process.env.REDIS_URL;
  if (process.env.NODE_ENV === "production" && !redisUrl) {
    throw new Error("REDIS_URL is required with DATABASE_URL in production");
  }
  const redis = redisUrl ? createClient({ url: redisUrl }) : null;
  if (redis) {
    redis.on("error", (error) => console.error("Redis connection error", error.message));
    await redis.connect();
  }

  store = new PostgresSessionStore(pool, redis, new SessionCodec(encryptionKey));
  lock = redis ? new RedisSessionLock(redis) : new LocalSessionLock();
  await store.initialize();
}

export async function ensureInfrastructure() {
  initialization ??= initialize();
  return initialization;
}

export async function getSessionStore() {
  await ensureInfrastructure();
  return store;
}

export async function withSessionLock<T>(sessionId: string, work: () => Promise<T>) {
  await ensureInfrastructure();
  return lock.runExclusive(sessionId, work);
}

export async function infrastructureHealth(): Promise<StoreHealth> {
  await ensureInfrastructure();
  return store.health();
}

export async function closeInfrastructure() {
  if (!initialization) return;
  await initialization;
  await store.close();
  initialization = null;
  store = new InMemorySessionStore();
  lock = new LocalSessionLock();
}
