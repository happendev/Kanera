import type { BrowserContextOptions } from "@playwright/test";
import ports from "../ports.json";

export const webOrigin = `http://localhost:${ports.web}`;

// Seeded accounts share one password (dev-db-seed-content/README.md).
export const SEED_PASSWORD = "Abc12345";

export const users = {
  amelia: { email: "amelia@kanera.test", name: "Amelia Hart" },
  marcus: { email: "marcus@kanera.test", name: "Marcus Cole" },
  priya: { email: "priya@kanera.test", name: "Priya Nair" },
  maya: { email: "maya@external.test", name: "Maya Chen" },
} as const;
export type SeedUser = keyof typeof users;

// Seeded dates are relative to seed time, and "today"/overdue views depend on the browser zone.
// Pin both so a run in CI and on a laptop in another zone render the same data.
export const contextDefaults = {
  baseURL: webOrigin,
  viewport: { width: 1440, height: 900 },
  timezoneId: "UTC",
  locale: "en-US",
} satisfies BrowserContextOptions;
