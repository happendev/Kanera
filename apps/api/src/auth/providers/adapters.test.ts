import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGoogleClaims, parseMicrosoftClaims, pickGitHubEmail } from "./adapters.js";

// Failure these catch: a provider email Kanera treats as verified when the provider never vouched
// for it. A verified email links to the existing Kanera account with that address, so a wrong
// `emailVerified` is an account takeover. The E2E flow uses a stub provider and cannot see this.

void test("Microsoft email counts as verified only with the xms_edov claim", () => {
  const base = { tid: "tenant", oid: "object", email: "ceo@acme.com", name: "Ceo" };
  assert.equal(parseMicrosoftClaims(base).emailVerified, false);
  assert.equal(parseMicrosoftClaims({ ...base, xms_edov: false }).emailVerified, false);
  assert.equal(parseMicrosoftClaims({ ...base, xms_edov: true }).emailVerified, true);
  assert.equal(parseMicrosoftClaims({ ...base, xms_edov: "1" }).emailVerified, true);
  // Keyed on tenant + object id, not the pairwise `sub`.
  assert.equal(parseMicrosoftClaims({ ...base, sub: "pairwise" }).subject, "tenant:object");
  assert.throws(() => parseMicrosoftClaims({ sub: "pairwise", email: "x@acme.com" }));
});

void test("Google email counts as verified only when email_verified is true", () => {
  const base = { sub: "123", email: "a@gmail.com" };
  assert.equal(parseGoogleClaims(base).emailVerified, false);
  assert.equal(parseGoogleClaims({ ...base, email_verified: "true" }).emailVerified, false);
  assert.equal(parseGoogleClaims({ ...base, email_verified: true }).emailVerified, true);
  assert.throws(() => parseGoogleClaims({ email: "a@gmail.com", email_verified: true }));
});

void test("GitHub uses only the primary email, verified only if GitHub verified it", () => {
  assert.equal(pickGitHubEmail([]), null);
  assert.equal(pickGitHubEmail([{ email: "other@x.com", primary: false, verified: true }]), null);
  assert.deepEqual(
    pickGitHubEmail([
      { email: "other@x.com", primary: false, verified: true },
      { email: "main@x.com", primary: true, verified: false },
    ]),
    { email: "main@x.com", verified: false },
  );
  assert.deepEqual(pickGitHubEmail([{ email: "main@x.com", primary: true, verified: true }]), { email: "main@x.com", verified: true });
});
