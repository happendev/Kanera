import assert from "node:assert/strict";
import { test } from "node:test";
import { between, firstPosition, positionAtIndex } from "./position.js";

void test("between assigns the first position when no neighbours exist", () => {
  assert.deepEqual(between(null, null), { position: "1000.0000000000", needsRebalance: false });
});

void test("between appends and prepends using the standard spacing", () => {
  assert.deepEqual(between("1000.0000000000", null), {
    position: "2000.0000000000",
    needsRebalance: false,
  });
  assert.deepEqual(between(null, "1000.0000000000"), {
    position: "0.0000000000",
    needsRebalance: false,
  });
});

void test("between places items halfway between neighbours", () => {
  assert.deepEqual(between("1000.0000000000", "2000.0000000000"), {
    position: "1500.0000000000",
    needsRebalance: false,
  });
});

void test("between signals rebalance when neighbours are too close", () => {
  assert.deepEqual(between("1.0000000000", "1.0000000005"), {
    position: "1.0000000003",
    needsRebalance: true,
  });
});

void test("position helpers use stable numeric(20,10) formatting", () => {
  assert.equal(firstPosition(), "1000.0000000000");
  assert.equal(positionAtIndex(0), "1000.0000000000");
  assert.equal(positionAtIndex(2), "3000.0000000000");
});
