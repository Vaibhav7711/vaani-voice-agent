import { randomUUID } from "node:crypto";
import type { createClient } from "redis";

type RedisClient = ReturnType<typeof createClient>;

export interface SessionLock {
  runExclusive<T>(sessionId: string, work: () => Promise<T>): Promise<T>;
}

export class LocalSessionLock implements SessionLock {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(sessionId, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    }
  }
}

export class RedisSessionLock implements SessionLock {
  constructor(
    private readonly redis: RedisClient,
    private readonly ttlMs = 10000,
    private readonly waitMs = 2500,
  ) {}

  async runExclusive<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const key = `vaani:lock:${sessionId}`;
    const token = randomUUID();
    const deadline = Date.now() + this.waitMs;
    let acquired = false;
    while (!acquired && Date.now() < deadline) {
      acquired = (await this.redis.set(key, token, { NX: true, PX: this.ttlMs })) === "OK";
      if (!acquired) await new Promise((resolve) => setTimeout(resolve, 35));
    }
    if (!acquired) throw new Error("Session is busy; retry the turn");

    try {
      return await work();
    } finally {
      try {
        await this.redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          { keys: [key], arguments: [token] },
        );
      } catch (error) {
        console.error("Failed to release Redis session lock", error instanceof Error ? error.message : error);
      }
    }
  }
}
