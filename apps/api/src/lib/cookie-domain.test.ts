import assert from "node:assert/strict";
import { test } from "node:test";
import { cookieDomainAttribute } from "./cookie-domain.js";

void test("cookieDomainAttribute omits local-only domains", () => {
  assert.equal(cookieDomainAttribute("localhost"), undefined);
  assert.equal(cookieDomainAttribute("api.localhost"), undefined);
  assert.equal(cookieDomainAttribute("127.0.0.1"), undefined);
  assert.equal(cookieDomainAttribute("[::1]"), undefined);
});

void test("cookieDomainAttribute preserves deployable parent domains", () => {
  assert.equal(cookieDomainAttribute("kanera.happen.zone"), "kanera.happen.zone");
});
