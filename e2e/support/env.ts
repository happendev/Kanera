import type { BrowserContextOptions } from "@playwright/test";
import ports from "../ports.json";

export const webOrigin = `http://localhost:${ports.web}`;

// Test-only identities are recreated for every test by the accounts fixture.
export const TEST_PASSWORD = "Abc12345";

export const users = {
  amelia: { email: "e2e-amelia@kanera.test", name: "Amelia Hart" },
  marcus: { email: "e2e-marcus@kanera.test", name: "Marcus Cole" },
  priya: { email: "e2e-priya@kanera.test", name: "Priya Nair" },
  maya: { email: "e2e-maya@external.test", name: "Maya Chen" },
} as const;
export type TestUser = keyof typeof users;

// Relative dates and "today"/overdue views depend on the browser zone.
// Pin both so a run in CI and on a laptop in another zone render the same data.
export const contextDefaults = {
  baseURL: webOrigin,
  viewport: { width: 1440, height: 900 },
  timezoneId: "UTC",
  // The source language, so selectors read the copy as written (UK English) with no translation in
  // between. The app picks its language from the browser for accounts that never chose one.
  locale: "en-GB",
} satisfies BrowserContextOptions;
