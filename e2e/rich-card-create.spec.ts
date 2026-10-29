import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Kanera, type Card, type CustomFieldValueInput } from "../packages/sdk/src/index";
import ports from "./ports.json";
import { expect, test } from "./support/fixtures";
import { createWorkspaceApiKey, expectBoardLoaded, openBoard, workspaceSettingsHref } from "./support/ui";

test("single and bulk creation save fields and external references through SDK, MCP and CLI", async ({ page, signIn, apiAs, testWorkspace, uniqueName }, testInfo) => {
  test.setTimeout(120_000);
  const api = await apiAs("amelia");
  const boardId = testWorkspace.boardId;
  const listId = testWorkspace.lists.get("Backlog")!;
  const fields: Record<string, { id: string; options: { id: string }[] }> = {};
  for (const type of ["text", "number", "checkbox", "date", "url", "select", "user"]) {
    const response = await api.post(`/api/workspaces/${testWorkspace.id}/custom-fields`, {
      data: { name: `Alert ${type}`, type, ...(type === "select" && { options: [{ label: "Critical" }, { label: "Minor" }] }) },
    });
    expect(response.ok(), await response.text()).toBe(true);
    fields[type] = await response.json() as { id: string; options: { id: string }[] };
  }
  const me = await (await api.get("/api/me")).json() as { id: string };
  const customFields: Record<string, CustomFieldValueInput> = {
    [fields.text!.id]: { valueText: "production-alert" },
    [fields.number!.id]: { valueNumber: 0.5 },
    [fields.checkbox!.id]: { valueCheckbox: false },
    [fields.date!.id]: { valueDate: "2026-12-01" },
    [fields.url!.id]: { valueUrl: "https://example.com/alert" },
    [fields.select!.id]: { valueOptionIds: [fields.select!.options[0]!.id] },
    [fields.user!.id]: { valueUserIds: [me.id] },
  };
  const frames: string[] = [];
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => frames.push(String(payload))));
  await signIn(page, "amelia");
  const apiKey = await createWorkspaceApiKey(page, await workspaceSettingsHref(page, testWorkspace.boardName), uniqueName("Rich create key"));
  const sdk = new Kanera({ apiKey, baseUrl: `http://localhost:${ports.publicApi}`, maxRetries: 0 });
  const client = new Client({ name: "kanera-e2e-rich-create", version: "1" });
  const configHome = mkdtempSync(path.join(tmpdir(), "kanera-rich-create-"));
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${ports.mcp}/mcp`), {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${apiKey}`);
      return fetch(input, { ...init, headers });
    },
  }));
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.structuredContent as T;
  };
  const cli = (args: string[]) => {
    const env: NodeJS.ProcessEnv = { ...process.env, KANERA_API_KEY: apiKey, KANERA_PUBLIC_API_URL: `http://localhost:${ports.publicApi}`, XDG_CONFIG_HOME: configHome };
    delete env.KANERA_PROFILE;
    delete env.KANERA_MCP_URL;
    return JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "../apps/cli/dist/kanera.mjs"), ...args, "--json"], { env, encoding: "utf8" })) as { ok: boolean; data: Card | { cards: Card[] } };
  };
  const ref = (id: string) => ({ provider: "alert-test", type: "issue", id });
  const verify = async (card: Card, referenceId: string, expectedFields = customFields) => {
    const detail = await sdk.cards.get(card.id);
    expect(detail.customFieldValues).toHaveLength(Object.keys(expectedFields).length);
    for (const [fieldId, value] of Object.entries(expectedFields)) {
      expect(detail.customFieldValues.find((row) => row.fieldId === fieldId)).toMatchObject({
        ...value, ...(value.valueNumber !== undefined && { valueNumber: String(value.valueNumber) }),
      });
    }
    const links = await sdk.http.get<Array<{ entityId: string; externalId: string }>>(`/api/v1/workspaces/${testWorkspace.id}/external-links`, {
      query: { provider: "alert-test", externalType: "issue", externalId: referenceId },
    });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ entityId: card.id, externalId: referenceId });
  };
  try {
    await openBoard(page, testWorkspace.boardName);
    await expectBoardLoaded(page, testWorkspace.boardName);
    const title = uniqueName("SDK alert");
    const body = { title, customFields, externalRef: ref("sdk-single") };
    const idempotencyKey = randomUUID();
    const card = await sdk.cards.create(boardId, listId, body, { idempotencyKey });
    await verify(card, "sdk-single");
    expect((await sdk.cards.create(boardId, listId, body, { idempotencyKey })).id).toBe(card.id);
    const tile = page.locator("k-card").filter({ hasText: title });
    await expect(tile).toContainText("production-alert");
    await expect.poll(() => frames.some((frame) => frame.includes("card:customFieldValue:set") && frame.includes(card.id) && frame.includes("production-alert"))).toBe(true);
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("rich-create-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(tile).toContainText("production-alert");
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("rich-create-phone.png") });

    const sdkBatch = await sdk.cards.bulk.create(boardId, [{ listId, title: uniqueName("SDK batch"), customFields, externalRef: ref("sdk-bulk") }]);
    await verify(sdkBatch.cards[0]!, "sdk-bulk");
    const mcpCard = await call<Card>("cards.create", { boardId, listId, title: uniqueName("MCP alert"), customFields, externalRef: ref("mcp-single") });
    await verify(mcpCard, "mcp-single");
    const mcpBatch = await call<{ cards: Card[] }>("cards.bulk_create", { boardId, cards: [{ listId, title: uniqueName("MCP batch"), customFields, externalRef: ref("mcp-bulk") }] });
    await verify(mcpBatch.cards[0]!, "mcp-bulk");
    const cliCard = cli(["card", "create", uniqueName("CLI alert"), "--boardId", boardId, "--listId", listId,
      `--customFields.${fields.checkbox!.id}.valueCheckbox`, "false", `--customFields.${fields.number!.id}.valueNumber`, "0.5",
      "--externalRef.provider", "alert-test", "--externalRef.type", "issue", "--externalRef.id", "cli-single"]);
    expect(cliCard.ok).toBe(true);
    await verify(cliCard.data as Card, "cli-single", { [fields.checkbox!.id]: { valueCheckbox: false }, [fields.number!.id]: { valueNumber: 0.5 } });
    const cliBatch = cli(["call", "cards.bulk_create", "--boardId", boardId, "--cards", JSON.stringify([{ listId, title: uniqueName("CLI batch"), customFields, externalRef: ref("cli-bulk") }])]);
    expect(cliBatch.ok).toBe(true);
    await verify((cliBatch.data as { cards: Card[] }).cards[0]!, "cli-bulk");

    // Every invalid second entry must leave the valid first entry and its external identity unwritten.
    const invalidItems = [
      { customFields: { [randomUUID()]: { valueText: "missing field" } } },
      { customFields: { [fields.text!.id]: { valueCheckbox: true } } },
      { customFields: { [fields.select!.id]: { valueOptionIds: [randomUUID()] } } },
      { customFields: { [fields.select!.id]: { valueOptionIds: fields.select!.options.map((option) => option.id) } } },
      { customFields: { [fields.user!.id]: { valueUserIds: [randomUUID()] } } },
      { externalRef: ref("sdk-single") },
      { externalRef: { provider: "mirror:reserved", type: "card", id: "source" } },
    ];
    for (const [index, invalid] of invalidItems.entries()) {
      const referenceId = `invalid-${index}`;
      await expect(sdk.cards.bulk.create(boardId, [
        { listId, title: "Must not be created", customFields, externalRef: ref(referenceId) },
        { listId, title: "Invalid", ...invalid },
      ])).rejects.toMatchObject({ message: expect.stringContaining("cards[1]") });
      const links = await sdk.http.get<unknown[]>(`/api/v1/workspaces/${testWorkspace.id}/external-links`, { query: { externalId: referenceId } });
      expect(links).toEqual([]);
    }
    await expect(sdk.cards.bulk.create(boardId, [
      { listId, title: "Duplicate one", externalRef: ref("batch-duplicate") },
      { listId, title: "Duplicate two", externalRef: ref("batch-duplicate") },
    ])).rejects.toMatchObject({ status: 409 });
    await expect(sdk.cards.create(boardId, listId, { title: "Conflict", customFields, externalRef: ref("sdk-single") })).rejects.toMatchObject({ status: 409 });
    await verify(card, "sdk-single");
    const board = await api.post(`/api/boards/${boardId}/open`);
    expect(board.ok()).toBe(true);
    const stored = await board.json() as { cards: Card[] };
    expect(stored.cards).toHaveLength(6);
    const activity = await (await api.get(`/api/boards/${boardId}/activity`)).json() as Array<{ type: string; data: { entityId: string; action: string; payload: unknown } }>;
    const created = activity.filter((item) => item.type === "activity" && item.data.entityId === card.id);
    expect(created).toHaveLength(1);
    expect(created[0]!.data).toMatchObject({ action: "created", payload: { customFields, externalRef: ref("sdk-single") } });

    // A field-change rule must see initial values, and its newer value must win on an open board.
    const rule = await api.post(`/api/workspaces/${testWorkspace.id}/automations`, { data: {
      enabled: true, triggerType: "custom_field_value_changed", triggerCustomFieldId: fields.number!.id,
      triggerCustomFieldValue: { kind: "number", number: 0.5 },
      actions: [{ type: "populate_custom_field", config: {
        fieldId: fields.text!.id, onlyIfEmpty: false, value: { kind: "text", text: "triaged-alert" },
      } }],
    } });
    expect(rule.ok(), await rule.text()).toBe(true);
    const automatedTitle = uniqueName("Automated alert");
    const automated = await sdk.cards.create(boardId, listId, { title: automatedTitle, customFields, externalRef: ref("automated") });
    await verify(automated, "automated", { ...customFields, [fields.text!.id]: { valueText: "triaged-alert" } });
    const automatedTile = page.locator("k-card").filter({ hasText: automatedTitle });
    await expect(automatedTile).toContainText("triaged-alert");
    await expect(automatedTile).not.toContainText("production-alert");
    const fieldFrames = frames.filter((frame) => frame.includes("card:customFieldValue:set") && frame.includes(automated.id) && frame.includes(fields.text!.id));
    expect(fieldFrames).toHaveLength(2);
    expect(fieldFrames[0]).toContain("production-alert");
    expect(fieldFrames[1]).toContain("triaged-alert");

  } finally {
    await client.close();
    rmSync(configHome, { recursive: true, force: true });
  }
});
