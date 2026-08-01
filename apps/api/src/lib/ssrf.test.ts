import assert from "node:assert/strict";
import { test } from "node:test";
import { isAlwaysBlockedNotificationAddress, isBlockedAddress } from "./ssrf.js";

test("isBlockedAddress flags loopback, private, link-local and metadata ranges", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.5",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata endpoint
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "::1",
    "fc00::1", // IPv6 ULA
    "fe80::1", // IPv6 link-local
    "::ffff:127.0.0.1", // IPv4-mapped loopback must not bypass the IPv4 checks
    "::ffff:10.0.0.1",
  ]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);
  }
});

test("isBlockedAddress allows ordinary public addresses", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "203.0.114.1", "2606:4700:4700::1111"]) {
    assert.equal(isBlockedAddress(ip), false, `${ip} should be allowed`);
  }
});

test("isBlockedAddress fails closed on unparseable input", () => {
  assert.equal(isBlockedAddress("not-an-ip"), true);
  assert.equal(isBlockedAddress(""), true);
});

test("private notification opt-in still blocks metadata, link-local, multicast, and reserved ranges", () => {
  for (const ip of ["169.254.169.254", "::ffff:169.254.169.254", "0.0.0.0", "224.0.0.1", "192.0.2.1", "fe80::1", "ff02::1", "2001:db8::1"]) {
    assert.equal(isAlwaysBlockedNotificationAddress(ip), true, `${ip} should always be blocked`);
  }
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.1", "100.64.0.1", "::1", "fd00::1"]) {
    assert.equal(isAlwaysBlockedNotificationAddress(ip), false, `${ip} should be allowed by the private-network opt-in`);
  }
});
