import assert from "node:assert/strict";
import { test } from "node:test";
import { weeklyAdminRecapEmail } from "./email-templates/weekly-admin-recap.js";
import { mondayUtc } from "./weekly-admin-recap.js";

void test("mondayUtc returns the reporting week's Monday boundary", () => {
  assert.equal(mondayUtc(new Date("2026-05-25T06:59:00Z")).toISOString(), "2026-05-25T00:00:00.000Z");
  assert.equal(mondayUtc(new Date("2026-05-31T23:59:59Z")).toISOString(), "2026-05-25T00:00:00.000Z");
  assert.equal(mondayUtc(new Date("2026-06-01T00:00:00Z")).toISOString(), "2026-06-01T00:00:00.000Z");
});

void test("weekly recap renders last-week metrics and upcoming renewal groups", () => {
  const html = weeklyAdminRecapEmail({
    periodStart: "2026-05-25",
    lastWeekLabel: "18 May 2026–24 May 2026",
    thisWeekLabel: "25 May 2026–31 May 2026",
    lastWeek: { newAccounts: 8, newOrganisations: 4, invitesAccepted: 3, boardsCreated: 12, subscriptionsStarted: 2, seatsPurchased: 7 },
    snapshot: { activeAccounts: 80, activeOrganisations: 40, activeBoards: 120, paidOrganisations: 20, trialOrganisations: 5, purchasedSeats: 70 },
    upcoming: {
      renewals: [{ dateLabel: "27 May 2026", organisationCount: 2, seatCount: 9, organisations: ["Acme", "Northstar"] }],
      trialEnds: [],
      cancellations: [],
    },
    adminUrl: "https://admin.example.com",
  });

  assert.match(html, /Weekly system recap/);
  assert.match(html, />8<\/div>/);
  assert.match(html, /9 seats across 2 organisations/);
  assert.match(html, /https:\/\/admin\.example\.com/);
});
