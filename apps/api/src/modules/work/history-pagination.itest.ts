import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { signupOwner } from "../../test/api-fixtures.js";
import { buildIntegrationServer } from "../../test/integration.js";

type Event = { id: string; type: string; at: string; card: { id: string }; listPath?: string[]; itemId?: string; text?: string };
type History = { events: Event[]; summary: Record<string, number>; nextCursor: string | null };

// Missing events, repeated cursors, truncated move paths and page-local summaries are API failures;
// no browser or cross-process delivery is involved in this contract.
void test("request-generated history preserves exact events and summaries across cursor pages", async () => {
  const app = await buildIntegrationServer();
  const owner = await signupOwner(app, { orgName: "History", email: "history@example.com", displayName: "Owner" });
  const api = {
    post: (url: string, options: { data: object }) => app.inject({ method: "POST", url, headers: owner.auth, payload: options.data }),
    patch: (url: string, options: { data: object }) => app.inject({ method: "PATCH", url, headers: owner.auth, payload: options.data }),
    get: (url: string) => app.inject({ method: "GET", url, headers: owner.auth }),
  };
  async function result<T>(response: Awaited<ReturnType<typeof api.get>>): Promise<T> {
    assert.ok(response.statusCode >= 200 && response.statusCode < 300, response.body);
    return response.json<T>();
  }
  const workspace = await result<{ id: string }>(await api.post("/workspaces", { data: { name: "History" } }));
  const board = { ...await result<{ id: string }>(await api.post(`/workspaces/${workspace.id}/boards`, { data: { name: "History" } })), workspaceId: workspace.id };
  const firstList = await result<{ id: string }>(await api.post(`/workspaces/${board.workspaceId}/lists`, { data: { name: "History start" } }));
  const secondList = await result<{ id: string }>(await api.post(`/workspaces/${board.workspaceId}/lists`, { data: { name: "History finish" } }));
  const thirdList = await result<{ id: string }>(await api.post(`/workspaces/${board.workspaceId}/lists`, { data: { name: "History final" } }));
  const from = new Date(Date.now() - 60_000).toISOString();
  const card = await result<{ id: string }>(await api.post(`/boards/${board.id}/lists/${firstList.id}/cards`, { data: { title: "History card" } }));
  // Use forward moves: an immediate return to the starting list intentionally cancels the move activity.
  await result(await api.post(`/cards/${card.id}/move`, { data: { listId: secondList.id, afterCardId: null } }));
  await result(await api.post(`/cards/${card.id}/move`, { data: { listId: thirdList.id, afterCardId: null } }));
  await result(await api.patch(`/cards/${card.id}/completion`, { data: { completed: true } }));
  await result(await api.post(`/cards/${card.id}/checklists`, { data: { title: "History checklist", items: [{ text: "Finish item" }] } }));
  const detail = await result<{ checklists: { items: { id: string }[] }[] }>(await api.get(`/cards/${card.id}/detail`));
  const checklistItemId = detail.checklists[0]!.items[0]!.id;
  await result(await api.patch(`/cards/${card.id}/checklist-items/${checklistItemId}`, { data: { completed: true } }));
  const to = new Date(Date.now() + 60_000).toISOString();
  const scope = { allAccessible: false, boardIds: [board.id] };
  // Keep this live-action fixture away from local midnight; deterministic integration fixtures
  // separately check day/DST boundaries. A clock rollover must not split this intended move run.
  const timeZone = [0, 23].includes(new Date(from).getUTCHours()) ? "Asia/Kolkata" : "UTC";
  const range = { from, to, timeZone, scope };
  // Derive expectations from the writes above so a missing checklist event or truncated move
  // path fails independently of the event selection and hydration implementation.
  const expectedTypes = ["checklistItemCompleted", "completed", "moved", "created"];
  const expectedSummary = { created: 1, moved: 1, completed: 1, checklistItemCompleted: 1, cardsTouched: 1, totalEvents: 4 };
  const pages: History[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < expectedTypes.length; index++) {
    const response = await result<History>(await api.post("/work/history/query", { data: { ...range, limit: 1, cursor } }));
    assert.deepEqual(response.summary, expectedSummary);
    assert.equal(response.events.length, 1);
    assert.equal(response.events[0]!.type, expectedTypes[index]);
    assert.equal(response.events[0]!.card.id, card.id);
    if (index < expectedTypes.length - 1) assert.notEqual(response.nextCursor, null);
    else assert.equal(response.nextCursor, null);
    pages.push(response);
    cursor = response.nextCursor ?? undefined;
  }
  const events = pages.flatMap((entry) => entry.events);
  assert.equal(new Set(events.map((event) => event.id)).size, 4);
  assert.equal(events[0]!.id, `checklistItem:${checklistItemId}`);
  assert.equal(events[0]!.itemId, checklistItemId);
  assert.equal(events[0]!.text, "Finish item");
  assert.deepEqual(events[2]!.listPath, [firstList.id, secondList.id, thirdList.id]);
});
