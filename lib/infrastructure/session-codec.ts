import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import type { AgentSession } from "../domain";

const envelopeSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("aes-256-gcm"),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

export type EncryptedSession = z.infer<typeof envelopeSchema>;

export class SessionCodec {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.byteLength !== 32) {
      throw new Error("SESSION_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
    }
  }

  encrypt(session: AgentSession): EncryptedSession {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(session), "utf8"), cipher.final()]);
    return {
      version: 1,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  }

  decrypt(value: unknown): unknown {
    const envelope = envelopeSchema.parse(value);
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8"));
  }
}
