import { cardBranchName, cardKeysInPullRequest } from "@kanera/shared/card-links";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifyGitHubSignature } from "./github-webhooks.js";

// Failure modes: a branch made by Copy branch name does not match back to its card; ordinary prose
// ("see-2", "UTF-8") or a longer number is read as a card key; a signature of the wrong length
// throws instead of failing.

void test("a branch from Copy branch name names its card again", () => {
  const branch = cardBranchName("KAN-123", "Fix the login redirect — très vite");
  assert.equal(branch, "kan-123-fix-the-login-redirect-tres-vite");
  assert.deepEqual(cardKeysInPullRequest({ headRef: branch, title: "", body: null }), ["KAN-123"]);
  assert.equal(cardBranchName("KAN-7", "ログイン修正"), "kan-7");
});

void test("only canonical upper-case keys match in a title or body", () => {
  const keys = cardKeysInPullRequest({
    headRef: "feature/dev-4",
    title: "Fix KAN-12, see-2 and kan-9",
    body: "Also closes OPS-301.\nNot ABC-1234567890 or UTF8-0 or XKAN-12x.",
  });
  assert.deepEqual(keys, ["DEV-4", "KAN-12", "OPS-301"]);
});

void test("signatures are compared without throwing on a malformed header", () => {
  const body = "{\"zen\":\"ok\"}";
  const valid = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
  assert.equal(verifyGitHubSignature("s3cret", body, valid), true);
  assert.equal(verifyGitHubSignature("other", body, valid), false);
  assert.equal(verifyGitHubSignature("s3cret", body, "sha256=abc"), false);
  assert.equal(verifyGitHubSignature("s3cret", body, undefined), false);
});
