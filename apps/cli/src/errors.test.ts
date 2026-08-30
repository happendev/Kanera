import assert from "node:assert/strict";
import test from "node:test";
import { EXIT, exitCodeForApiError } from "./errors.js";

void test("maps API problem codes onto distinct exit codes", () => {
  // A read-scoped credential must be distinguishable from a generic failure, so an agent can stop
  // trying to write instead of retrying.
  assert.equal(exitCodeForApiError(403, "FORBIDDEN"), EXIT.forbidden);
  assert.equal(exitCodeForApiError(401, "UNAUTHORIZED"), EXIT.unauthenticated);
  assert.equal(exitCodeForApiError(404, "NOT_FOUND"), EXIT.notFound);
  assert.equal(exitCodeForApiError(429, "RATE_LIMITED"), EXIT.rateLimited);
  assert.equal(exitCodeForApiError(500, "INTERNAL"), EXIT.failed);
});
