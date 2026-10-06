import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import ports from "./ports.json";
import { expect, test } from "./support/fixtures";
import { boardHref, openBoard, openCard, workspaceSettingsHref } from "./support/ui";

const mcpUrl = `http://localhost:${ports.mcp}/mcp`;
// The bundled executable npm ships (built by scripts/test-e2e.sh), not the TypeScript sources.
const cli = path.join(__dirname, "..", "apps", "cli", "dist", "kanera.mjs");

/** Runs `kanera` as a user's shell would: the JSON array is one argv entry, exactly as quoted. */
function runCli(apiKey: string, configHome: string, args: string[]): { ok: boolean; data: unknown } {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.KANERA_PROFILE;
  delete env.KANERA_MCP_URL;
  env.KANERA_API_KEY = apiKey;
  env.KANERA_PUBLIC_API_URL = `http://localhost:${ports.publicApi}`;
  env.XDG_CONFIG_HOME = configHome;
  return JSON.parse(execFileSync(process.execPath, [cli, ...args, "--json"], { env, encoding: "utf8" })) as { ok: boolean; data: unknown };
}

type Leaf = { id: string; text: string; completed: boolean };
type TreeItem = Leaf & {
  description: string | null;
  assigneeId: string | null;
  dueDateLocalDate: string | null;
  subChecklists: Array<{ id: string; title: string; items: Leaf[] }>;
};
type TreeChecklist = { id: string; title: string; parentItemId: string | null; items: TreeItem[] };
type ToolError = { error: { status: number; code: string; message: string; issues?: Array<{ path: string; message: string }>; candidates?: Array<{ itemId: string }> } };

/**
 * Drives the agent-facing checklist contract end to end: one MCP call builds a nested plan, the
 * open card detail shows it through realtime (no reload), retries with the same idempotency key do
 * not duplicate it, invalid batches name the exact field and write nothing, and selected-item
 * updates, ordering anchors, ambiguity rejection, and audit activity all hold across processes
 * (MCP -> public API -> outbox -> worker -> app Socket.IO -> browser).
 */
test("an agent builds and edits a nested checklist plan through MCP while the card is open", async ({ page, signIn, uniqueName }, testInfo) => {
  test.setTimeout(120_000);
  const evidence: Array<{ step: string; detail: unknown }> = [];
  const record = (step: string, detail: unknown) => evidence.push({ step, detail });

  await signIn(page, "amelia");
  const boardId = (await boardHref(page, "Platform Delivery")).split("/")[2]!;
  await page.goto(`${await workspaceSettingsHref(page, "Platform Delivery")}/api`);
  await page.locator('input[name="apiKeyName"]').fill(uniqueName("MCP checklist key"));
  await page.locator('select[name="apiKeyScope"]').selectOption("write");
  await page.getByRole("button", { name: "Create API key" }).click();
  const reveal = page.locator(".secret-reveal").filter({ has: page.getByRole("button", { name: "Copy API key" }) });
  await expect(reveal).toBeVisible();
  const apiKey = (await reveal.locator("code").innerText()).trim();

  const client = new Client({ name: "kanera-e2e-checklists", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${apiKey}`);
      return fetch(input, { ...init, headers });
    },
  }));
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).not.toBe(true);
    return result.structuredContent as T;
  };
  const callError = async (name: string, args: Record<string, unknown>): Promise<ToolError> => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, `${name} should fail`).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    try {
      return JSON.parse(text) as ToolError;
    } catch {
      // Schema rejections raised by the MCP SDK before the handler runs are plain text.
      return { error: { status: 400, code: "INVALID_PARAMS", message: text } };
    }
  };

  try {
    const board = await call<{ lists: Array<{ id: string }>; members?: Array<{ userId?: string; id?: string; role?: string }> }>("boards.get", { boardId });
    const session = await call<{ userId: string }>("session.get", {});
    const listId = board.lists[0]!.id;
    const assigneeId = session.userId;
    const title = uniqueName("Nested plan card");
    const card = await call<{ id: string }>("cards.create", { boardId, listId, title });

    await openBoard(page, "Platform Delivery");
    const detail = await openCard(page, title);

    // 1. One call creates the whole tree; ids for every level come back in the result.
    const idempotencyKey = randomUUID();
    const planArgs = {
      cardId: card.id,
      title: "Launch",
      idempotencyKey,
      items: [
        {
          text: "Prepare release",
          description: "Coordinate the release.",
          assigneeId,
          dueDateLocalDate: "2026-12-01",
          subChecklists: [{ title: "Verification", items: [{ text: "Run smoke tests" }, { text: "Confirm rollback procedure" }] }],
        },
        { text: "Announce launch" },
      ],
    };
    const plan = await call<TreeChecklist>("checklists.create", planArgs);
    expect(plan.items.map((item) => item.text)).toEqual(["Prepare release", "Announce launch"]);
    const prepare = plan.items[0]!;
    expect(prepare).toMatchObject({ description: "Coordinate the release.", assigneeId, dueDateLocalDate: "2026-12-01" });
    expect(prepare.subChecklists).toHaveLength(1);
    const verification = prepare.subChecklists[0]!;
    expect(verification.items.map((item) => item.text)).toEqual(["Run smoke tests", "Confirm rollback procedure"]);
    record("checklists.create", plan);

    // 2. A retry with the same key replays the same result instead of creating a second tree.
    const replay = await call<TreeChecklist>("checklists.create", planArgs);
    expect(replay.id).toBe(plan.id);
    expect(replay.items[0]!.subChecklists[0]!.id).toBe(verification.id);
    const afterReplay = await call<{ checklists: TreeChecklist[] }>("checklists.get", { cardId: card.id });
    expect(afterReplay.checklists.filter((checklist) => checklist.title === "Launch")).toHaveLength(1);
    record("retry with same idempotencyKey", { replayedId: replay.id, launchChecklists: afterReplay.checklists.length });

    // The open card detail receives the tree through realtime, in order, without a reload.
    const launch = detail.locator(`[data-checklist-id="${plan.id}"]`);
    await expect(launch.locator(".checklist-title")).toHaveText("Launch");
    await expect(launch.locator(".checklist-item .checklist-item-text")).toHaveText(["Prepare release", "Announce launch"]);
    await expect(detail.locator(".checklist-block")).toHaveCount(1);

    // 3. Invalid batches fail with the exact path and write nothing.
    const nested = await callError("checklists.add_items", {
      cardId: card.id,
      checklistId: plan.id,
      items: [{ text: "Fine" }, { text: "Bad", subChecklists: [{ title: "Leaf rules", items: [{ text: "Leaf", assigneeId }] }] }],
    });
    expect(nested.error.message).toMatch(/items/u);
    expect(nested.error.message).toMatch(/subChecklists/u);
    const notMember = await callError("checklists.add_items", {
      cardId: card.id,
      checklistId: plan.id,
      items: [{ text: "Fine" }, { text: "Owned by a stranger", assigneeId: randomUUID() }],
    });
    expect(notMember.error.issues?.map((issue) => issue.path)).toEqual(["items[1].assigneeId"]);
    const leafRule = await callError("checklists.add_items", { cardId: card.id, checklistId: verification.id, items: [{ text: "Leaf", description: "not allowed" }] });
    expect(leafRule.error.issues?.map((issue) => issue.path)).toEqual(["items[0].description"]);
    const unchanged = await call<{ checklists: TreeChecklist[] }>("checklists.get", { cardId: card.id, checklistId: plan.id });
    expect(unchanged.checklists[0]!.items).toHaveLength(2);
    record("rejected batches", { nested: nested.error, notMember: notMember.error, leafRule: leafRule.error });

    // 4. Batch add at an anchor keeps request order and lands at the top.
    const added = await call<{ items: TreeItem[] }>("checklists.add_items", {
      cardId: card.id,
      checklistTitle: "launch",
      items: [{ text: "Kickoff" }, { text: "Freeze scope", completed: true }],
      anchor: { side: "after", id: null },
      idempotencyKey: randomUUID(),
    });
    expect(added.items.map((item) => item.text)).toEqual(["Kickoff", "Freeze scope"]);
    await expect(launch.locator(".checklist-item .checklist-item-text")).toHaveText(["Kickoff", "Freeze scope", "Prepare release", "Announce launch"]);
    await expect(launch.locator(`[data-checklist-item-id="${added.items[1]!.id}"] .checklist-check`)).toHaveClass(/checked/u);
    record("checklists.add_items at top", added);

    // 5. Selected-item updates: different changes for chosen items, one call, applied atomically.
    const announce = plan.items[1]!;
    const updated = await call<{ items: TreeItem[] }>("checklists.update_items", {
      cardId: card.id,
      updates: [
        { itemId: verification.items[0]!.id, changes: { completed: true } },
        { itemText: "confirm rollback procedure", checklistId: verification.id, changes: { completed: true } },
        { itemId: announce.id, changes: { text: "Announce launch publicly" } },
      ],
    });
    expect(updated.items.map((item) => item.completed)).toEqual([true, true, false]);
    await expect(launch.locator(`[data-checklist-item-id="${announce.id}"] .checklist-item-text`)).toHaveText("Announce launch publicly");
    record("checklists.update_items", updated);

    // The sub-checklist shows both leaves completed in the item's detail drawer.
    await launch.locator(`[data-checklist-item-id="${prepare.id}"] .checklist-item-text`).click();
    const drawer = page.getByRole("dialog", { name: "Checklist item detail: Prepare release" });
    await expect(drawer).toBeVisible();
    const sub = drawer.locator(`[data-checklist-id="${verification.id}"]`);
    await expect(sub.locator(".checklist-title")).toHaveText("Verification");
    await expect(sub.locator(".checklist-item .checklist-item-text")).toHaveText(["Run smoke tests", "Confirm rollback procedure"]);
    await expect(sub.locator(".checklist-item .checklist-check.checked")).toHaveCount(2);
    await testInfo.attach("checklist-item-drawer.png", { body: await page.screenshot(), contentType: "image/png" });
    await drawer.getByRole("button", { name: "Close item detail" }).click();

    // 6. Text targeting never guesses: a duplicate is rejected with candidate ids and no write.
    await call("checklists.add_items", { cardId: card.id, checklistId: plan.id, items: [{ text: "Kickoff" }] });
    const ambiguous = await callError("checklists.update_items", { cardId: card.id, updates: [{ itemText: "kickoff", changes: { completed: true } }] });
    expect(ambiguous.error.code).toBe("AMBIGUOUS_TARGET");
    expect(ambiguous.error.candidates).toHaveLength(2);
    const afterAmbiguous = await call<{ checklists: TreeChecklist[] }>("checklists.get", { cardId: card.id, checklistId: plan.id });
    expect(afterAmbiguous.checklists[0]!.items.filter((item) => item.text === "Kickoff").every((item) => !item.completed)).toBe(true);
    record("ambiguous itemText", ambiguous.error);

    // 7. Audit: every write above left the activity a step-by-step build would.
    const activity = await call<{ items: Array<{ type?: string; data?: { entityId?: string; action?: string; payload?: Record<string, unknown> } }> }>(
      "activity.list",
      { boardId, limit: 100 },
    );
    const actions = activity.items
      .filter((entry) => entry.data?.entityId === card.id && entry.data.action)
      .map((entry) => ({ action: entry.data!.action!, title: entry.data!.payload?.title ?? entry.data!.payload?.text ?? entry.data!.payload?.itemText }));
    const actionNames = actions.map((entry) => entry.action);
    expect(actions.filter((entry) => entry.action === "checklist:created").map((entry) => entry.title).sort()).toEqual(["Launch", "Verification"]);
    expect(actionNames).toContain("checklistItem:assignee:set");
    expect(actionNames).toContain("checklistItem:dueDate:set");
    // add_items audits each added item: Kickoff and Freeze scope, then the duplicate Kickoff.
    expect(actionNames.filter((action) => action === "checklistItem:created")).toHaveLength(3);
    expect(actionNames).toContain("checklistItem:updated");
    expect(actionNames).toContain("checklist:completed");
    record("activity for card", actions);

    // 8. The CLI is a second transport onto the same tools: a nested plan passed as one JSON-array
    // flag must arrive intact (it used to be wrapped into a nested array and rejected).
    const configHome = mkdtempSync(path.join(tmpdir(), "kanera-cli-checklists-e2e-"));
    try {
      const cliPlan = runCli(apiKey, configHome, [
        "call", "checklists.create", "--cardId", card.id, "--title", "CLI plan",
        "--items", JSON.stringify([{ text: "Draft notes", subChecklists: [{ title: "Review", items: [{ text: "Proofread" }] }] }, { text: "Publish" }]),
      ]);
      expect(cliPlan.ok).toBe(true);
      const cliTree = cliPlan.data as TreeChecklist;
      expect(cliTree.items.map((item) => item.text)).toEqual(["Draft notes", "Publish"]);
      expect(cliTree.items[0]!.subChecklists[0]!.items.map((item) => item.text)).toEqual(["Proofread"]);
      const cliUpdate = runCli(apiKey, configHome, [
        "call", "checklists.update_items", "--cardId", card.id,
        "--updates", JSON.stringify([{ itemId: cliTree.items[1]!.id, changes: { completed: true } }]),
      ]);
      expect((cliUpdate.data as { items: TreeItem[] }).items[0]!.completed).toBe(true);
      const cliBlock = detail.locator(`[data-checklist-id="${cliTree.id}"]`);
      await expect(cliBlock.locator(".checklist-item .checklist-item-text")).toHaveText(["Draft notes", "Publish"]);
      await expect(cliBlock.locator(`[data-checklist-item-id="${cliTree.items[1]!.id}"] .checklist-check`)).toHaveClass(/checked/u);
      record("kanera CLI nested plan", { create: cliTree, update: cliUpdate.data });
    } finally {
      rmSync(configHome, { recursive: true, force: true });
    }
    await expect(detail.locator(".feed")).toContainText("added checklist Launch");
    await testInfo.attach("card-detail.png", { body: await page.screenshot(), contentType: "image/png" });
  } finally {
    await client.close();
    await testInfo.attach("mcp-checklists-evidence.json", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
  }
});
