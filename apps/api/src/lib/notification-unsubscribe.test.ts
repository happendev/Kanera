import assert from "node:assert/strict";
import { test } from "node:test";
import { lifecycleUnsubscribeToken } from "./lifecycle-emails.js";
import { notificationUnsubscribeToken, verifyNotificationUnsubscribeToken } from "./notification-unsubscribe.js";

test("a notification unsubscribe token names only the address it was minted for", () => {
  const token = notificationUnsubscribeToken(" Ada@Example.com ");
  assert.equal(verifyNotificationUnsubscribeToken(token), "ada@example.com");

  // Swapping in another address keeps the shape but breaks the signature.
  const [prefix, , signature] = token.split(".");
  const forged = `${prefix}.${Buffer.from("eve@example.com").toString("base64url")}.${signature}`;
  assert.equal(verifyNotificationUnsubscribeToken(forged), null);
  assert.equal(verifyNotificationUnsubscribeToken(`${token}x`), null);
  assert.equal(verifyNotificationUnsubscribeToken(`${token}.extra`), null);

  // A lifecycle token (which only turns off tips) is never read as a notification token.
  assert.equal(verifyNotificationUnsubscribeToken(lifecycleUnsubscribeToken("01a1b079-3265-7666-b26b-6ceceb627bab")), null);
});
