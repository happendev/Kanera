import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";

/**
 * One-click unsubscribe tokens for card notification emails (the List-Unsubscribe header). A token
 * signs the recipient's address, not their id, so the mailer can mint it from the queue row alone.
 * Email is globally unique; after an address change an old token simply finds no one.
 *
 * The token only authorises turning email notifications off for that address. The "n." prefix keeps
 * it apart from lifecycle tokens (`<userId>.<signature>`), and the purpose string keeps the signature
 * apart from every other value derived from JWT_SECRET. Like lifecycle tokens they never expire: an
 * old email's header must keep working.
 */
const PURPOSE = "kanera:notification-unsubscribe:v1:";
const PREFIX = "n";

function signature(email: string): string {
  return createHmac("sha256", env.JWT_SECRET).update(`${PURPOSE}${email}`).digest("base64url");
}

export function notificationUnsubscribeToken(email: string): string {
  const normalised = email.trim().toLowerCase();
  return `${PREFIX}.${Buffer.from(normalised).toString("base64url")}.${signature(normalised)}`;
}

/** The address a valid token names, or null. */
export function verifyNotificationUnsubscribeToken(token: string): string | null {
  const [prefix, encoded, sig, extra] = token.split(".");
  if (prefix !== PREFIX || !encoded || !sig || extra !== undefined) return null;
  const email = Buffer.from(encoded, "base64url").toString("utf8");
  if (!email.includes("@")) return null;
  const expected = Buffer.from(signature(email));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return email;
}
