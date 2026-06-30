import assert from "node:assert/strict";
import { test } from "node:test";
import { isCloudflarePeer, resolveClientIp } from "./client-ip.js";

void test("resolveClientIp trusts CF-Connecting-IP from Cloudflare peers", () => {
  const ip = resolveClientIp({
    headers: { "cf-connecting-ip": "203.0.113.10" },
    remoteAddress: "173.245.48.5",
    fallbackIp: "173.245.48.5",
  });

  assert.equal(ip, "203.0.113.10");
});

void test("resolveClientIp ignores CF-Connecting-IP from non-Cloudflare peers", () => {
  const ip = resolveClientIp({
    headers: { "cf-connecting-ip": "203.0.113.10" },
    remoteAddress: "198.51.100.20",
    fallbackIp: "198.51.100.20",
  });

  assert.equal(ip, "198.51.100.20");
});

void test("resolveClientIp falls back when CF-Connecting-IP is malformed", () => {
  const ip = resolveClientIp({
    headers: { "cf-connecting-ip": "not an ip" },
    remoteAddress: "173.245.48.5",
    fallbackIp: "173.245.48.5",
  });

  assert.equal(ip, "173.245.48.5");
});

void test("isCloudflarePeer matches IPv4-mapped and IPv6 Cloudflare ranges", () => {
  assert.equal(isCloudflarePeer("::ffff:173.245.48.5"), true);
  assert.equal(isCloudflarePeer("2606:4700::1234"), true);
  assert.equal(isCloudflarePeer("2001:db8::1"), false);
});
