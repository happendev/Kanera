import { z } from "zod";

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  KANERA_PUBLIC_API_URL: z.preprocess(emptyToUndefined, z.url()).default("http://localhost:3001"),
  MCP_PORT: z.coerce.number().int().positive().default(3002),
  MCP_SERVER_PUBLIC_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  OAUTH_ISSUER_URL: z.url().default("http://localhost:3001"),
  REDIS_URL: z.url().default("redis://localhost:6379"),
  MCP_INTERNAL_SECRET: z.string().min(32).default("development-mcp-internal-secret-change-me"),
  MCP_BODY_MAX_BYTES: z.coerce.number().int().positive().default(1_048_576),
  MCP_TOOL_OUTPUT_MAX_BYTES: z.coerce.number().int().positive().default(1_048_576),
  MCP_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  PUBLIC_API_IP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  PUBLIC_API_KEY_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(400),
  PUBLIC_API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  MCP_TRUST_PROXY: z
    .union([z.string(), z.boolean()])
    .transform((value) => value === true || value === "true")
    .default(false),
  MCP_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  MCP_HEADERS_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  MCP_KEEP_ALIVE_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  METRICS_ENABLED: z.union([z.string(), z.boolean()]).transform((value) => value === true || value === "true").default(false),
  METRICS_TOKEN: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
}).superRefine((value, ctx) => {
  if (value.NODE_ENV === "production" && value.MCP_INTERNAL_SECRET === "development-mcp-internal-secret-change-me") {
    ctx.addIssue({ code: "custom", path: ["MCP_INTERNAL_SECRET"], message: "MCP_INTERNAL_SECRET must be set in production" });
  }
  if (value.NODE_ENV === "production" && !value.MCP_SERVER_PUBLIC_URL) {
    ctx.addIssue({ code: "custom", path: ["MCP_SERVER_PUBLIC_URL"], message: "MCP_SERVER_PUBLIC_URL must be set in production" });
  }
});

export const env = schema.parse(process.env);
