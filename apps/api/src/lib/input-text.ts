import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

// PostgreSQL text cannot store NUL; jsonb also rejects unpaired UTF-16 surrogates. Reject them
// before a write or its side effects, rather than silently changing user-authored text.
const unpairedSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function assertStorageSafeInput(value: unknown): void {
  // Replay fingerprinting and JSONB serialization recurse later. An otherwise valid 1 MB
  // request can contain thousands of nested arrays and overflow those call stacks.
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (pending.length) {
    const { value: current, depth } = pending.pop()!;
    if (depth > 128) throw new ZodError([{ code: "custom", path: [], message: "validation failed" }]);
    if (typeof current === "string") {
      if (current.includes("\0") || unpairedSurrogate.test(current)) throw new ZodError([{ code: "custom", path: [], message: "validation failed" }]);
    } else if (Array.isArray(current)) {
      for (const entry of current) pending.push({ value: entry, depth: depth + 1 });
    } else if (current && typeof current === "object" && !Buffer.isBuffer(current)) {
      for (const [key, entry] of Object.entries(current)) {
        if (key.includes("\0") || unpairedSurrogate.test(key)) throw new ZodError([{ code: "custom", path: [], message: "validation failed" }]);
        pending.push({ value: entry, depth: depth + 1 });
      }
    }
  }
}

export function registerInputTextValidation(app: FastifyInstance): void {
  app.addHook("preValidation", async (req) => {
    assertStorageSafeInput(req.params);
    assertStorageSafeInput(req.query);
    assertStorageSafeInput(req.body);
  });
}
