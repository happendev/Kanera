import assert from "node:assert/strict";
import { test } from "node:test";
import { LOCALES } from "@kanera/shared/locales";
import { richHtml, strong } from "../email-templates/layout.js";
import { formatBytes, formatLocalDate } from "./format.js";
import { serverMessages } from "./messages/index.js";

// Mail and push have no browser to format dates, so the recipient's locale must reach Intl. If it
// were dropped anywhere, every reader would silently get one region's date order.
void test("calendar dates follow the recipient's locale", () => {
  const options = { month: "short", day: "numeric", year: "numeric" } as const;
  assert.equal(formatLocalDate("en-GB", "2026-05-24", options), "24 May 2026");
  assert.equal(formatLocalDate("en-US", "2026-05-24", options), "May 24, 2026");
  assert.match(formatLocalDate("de", "2026-05-24", options), /^24\. Mai 2026$/);
});

void test("storage sizes use the recipient's decimal separator", () => {
  assert.equal(formatBytes("en-GB", 218_521_190), "208.4 MB");
  assert.equal(formatBytes("de", 218_521_190), "208,4 MB");
});

void test("every supported locale has a complete catalog", () => {
  for (const locale of LOCALES) {
    const messages = serverMessages(locale);
    assert.equal(typeof messages.email.cardAssigned.subject, "string", locale);
    assert.equal(typeof messages.activity.list, "function", locale);
  }
});

// Catalog text is plain text but some sentences carry markup (a bold board name). The markup slot
// must stay intact while both the catalog text and user content around it are escaped.
void test("rich catalog sentences escape text and keep only the template's markup", () => {
  const html = richHtml(
    (s) => `${s.name} & <co> gave you ${s.board}`,
    { name: "<b>not bold</b>".replace(/</g, "&lt;").replace(/>/g, "&gt;"), board: strong("Q3 <Launch>") },
  );
  assert.equal(
    html,
    "&lt;b&gt;not bold&lt;/b&gt; &amp; &lt;co&gt; gave you <strong style=\"color:#0f172a;\">Q3 &lt;Launch&gt;</strong>",
  );
});

// E2E cannot see mail-only branches. Catch untranslated strings inside conditional interpolations
// and plural helpers, even when the enclosing sentence is translated and the catalog type-checks.
void test("Dutch and Bokmål email interpolation branches are translated", () => {
  for (const locale of ["nl", "nb"] as const) {
    const messages = serverMessages(locale);
    const license = locale === "nl" ? "licenties" : "lisenser";
    assert.match(messages.email.billing.seatPurchase.total({ count: 2 }), new RegExp(license));
    for (const end of [null, "24 May"] as const) {
      const intro = messages.email.billing.trialStarted.intro({ firstName: "Alex", org: "Example", end });
      assert.doesNotMatch(intro, /bis zum|während|deiner/);
    }
    assert.doesNotMatch(messages.email.billing.usage({ boards: 2, cards: 3, members: 2 }), /Boards|Karten/);
    assert.doesNotMatch(messages.email.importCompleted.attachmentsSkipped({ count: 2 }), /Anhänge|wurden/);
    assert.doesNotMatch(messages.email.importCompleted.warnings({ count: 2 }), /Warnungen/);
  }
});

// Emails are rendered outside the browser. Verify units and nested billing branches that the
// language-switching E2E flow cannot inspect, including the absence of an English plural suffix.
void test("Chinese email units and nested billing fragments follow the selected script", () => {
  for (const [locale, minute] of [["zh-CN", "分钟"], ["zh-TW", "分鐘"]] as const) {
    const messages = serverMessages(locale);
    assert.match(messages.common.minutes({ count: 2 }), new RegExp(minute));
    assert.match(messages.email.billing.seatPurchase.total({ count: 2 }), /席位/);
    for (const end of [null, "2026-05-24"] as const) {
      assert.doesNotMatch(messages.email.billing.trialStarted.intro({ firstName: "Alex", org: "Example", end }), /until|during your trial/);
    }
    assert.doesNotMatch(messages.email.dailyDigest.preheader({ count: 2 }), /items?|需要s/);
  }
});
