import { z } from "zod";

/** Explicit UUID-only path contracts; card keys, tokens and enums use their own schemas. */
export function uuidParams<K extends string>(...keys: K[]) {
  const shape = Object.fromEntries(keys.map((key) => [key, z.uuid()])) as Record<K, z.ZodUUID>;
  return z.object(shape);
}
