import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeCsvBuffer } from "./decode.js";

void test("decodeCsvBuffer detects BOMs, BOM-less UTF-16LE, and cp1252", () => {
  assert.deepEqual(decodeCsvBuffer(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), { text: "a", encoding: "utf-8" });
  assert.equal(decodeCsvBuffer(Buffer.from([0xff, 0xfe, 0x61, 0, 0x62, 0])).text, "ab");
  assert.equal(decodeCsvBuffer(Buffer.from([0x61, 0, 0x62, 0, 0x63, 0, 0x64, 0])).encoding, "utf-16le");
  assert.deepEqual(decodeCsvBuffer(Buffer.from([0x63, 0x61, 0x66, 0xe9])), { text: "café", encoding: "windows-1252" });
});
