import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { outboundHttpClient } from "../../lib/outbound-http.js";
import { downloadTrelloAttachment } from "./trello-attachment-download.js";

// A provider's signed redirect chain cannot be manufactured through the UI.
// Verify credential handling here; real DNS pinning/blocked targets/byte limits
// are exercised independently by outbound-http.test.ts with actual sockets.
test("Trello file redirects carry no OAuth credentials across or back from another origin", async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const send = mock.method(outboundHttpClient, "fetch", async (url: string | URL, init?: RequestInit, options?: Parameters<typeof outboundHttpClient.fetch>[2]) => {
    assert.equal(init?.redirect, "manual");
    assert.equal(options?.policy, "public");
    calls.push({ url: url.toString(), authorization: new Headers(init?.headers).get("authorization") });
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "https://trello-attachments.s3.amazonaws.com/file?signature=private" } });
    if (calls.length === 2) return new Response(null, { status: 302, headers: { location: "https://api.trello.com/file" } });
    return new Response("downloaded");
  });
  try {
    assert.equal(await (await downloadTrelloAttachment("https://api.trello.com/download", "OAuth test-only", 1024)).text(), "downloaded");
    assert.deepEqual(calls.map(call => call.authorization), ["OAuth test-only", null, null]);
  } finally { send.mock.restore(); }
});

test("Trello attachment redirect loops are bounded", async () => {
  const send = mock.method(outboundHttpClient, "fetch", async () => new Response(null, { status: 302, headers: { location: "/loop" } }));
  try {
    await assert.rejects(downloadTrelloAttachment("https://api.trello.com/download", "OAuth test-only", 1024), /invalid attachment redirect/);
    assert.equal(send.mock.callCount(), 4);
  } finally { send.mock.restore(); }
});
