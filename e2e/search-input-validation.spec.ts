import { expect, test } from "./support/fixtures";

test("direct board, notification and work-history searches never cast oversized key-like text to int4", async ({ apiAs, testWorkspace }) => {
  const api = await apiAs("amelia");
  const q = `AB-${"9".repeat(150)}`;
  const from = new Date(Date.now() - 86_400_000).toISOString();
  const to = new Date(Date.now() + 86_400_000).toISOString();
  const responses = await Promise.all([
    api.get("/api/notifications", { params: { q } }),
    api.get(`/api/boards/${testWorkspace.boardId}/completed`, { params: { q } }),
    api.get(`/api/boards/${testWorkspace.boardId}/work-done`, { params: { q, from, to, timeZone: "UTC" } }),
    api.get(`/api/boards/${testWorkspace.boardId}/work-done/summary`, { params: { q, from, to, timeZone: "UTC" } }),
  ]);
  const statuses: number[] = [];
  for (const response of responses) {
    statuses.push(response.status());
    await response.body();
  }
  expect(statuses).toEqual([200, 200, 200, 200]);
});
