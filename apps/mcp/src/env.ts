import { z } from "zod";

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

const schema = z.object({
  KANERA_PUBLIC_API_URL: z.preprocess(emptyToUndefined, z.url()).default("http://localhost:3001"),
  MCP_PORT: z.coerce.number().int().positive().default(3002),
  MCP_SERVER_PUBLIC_URL: z.preprocess(emptyToUndefined, z.url().optional()),
});

export const env = schema.parse(process.env);
