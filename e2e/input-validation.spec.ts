import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./support/fixtures";
import { TEST_PASSWORD, users, webOrigin } from "./support/env";

const v1 = "/public-api/api/v1";

test("logged public API failures reject missing IDs, misplaced card keys and oversized card numbers", async ({ apiAs, testWorkspace, playwright, uniqueName }) => {
  const api = await apiAs("amelia");
  const key = await (await api.post("/api/me/api-keys", { data: { label: uniqueName("logged errors") } })).json() as { id: string; secret: string };
  const publicApi = await playwright.request.newContext({ baseURL: webOrigin, extraHTTPHeaders: { authorization: `Bearer ${key.secret}` } });
  try {
    const created = await api.post(`/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")}/cards`, { data: { title: uniqueName("API validation") } });
    expect(created.status()).toBe(201);
    const card = await created.json() as { id: string; key: string; organisationKey: string };
    for (const client of [api, publicApi]) {
      const prefix = client === api ? "/api" : v1;
      for (const id of ["undefined", card.key]) {
        const responses = [
          await client.post(`${prefix}/boards/${id}/open?includeCards=false`),
          await client.get(`${prefix}/cards/${id}/detail`),
          await client.get(`${prefix}/cards/${id}/comments?limit=3`),
          await client.post(`${prefix}/cards/${id}/comments`, { data: { body: "Rejected comment" } }),
        ];
        for (const response of responses) {
          expect.soft(response.status(), await response.text()).toBe(400);
          expect.soft(await response.json()).toMatchObject({ code: "VALIDATION" });
        }
      }
      const lookup = `${prefix}/organisations/${card.organisationKey}/cards/by-key`;
      for (const invalidKey of ["prompt-1794732052269", "PROMPT-1794732052269", "AB-2147483648", `AB-${"9".repeat(80)}`]) {
        const response = await client.get(`${lookup}/${invalidKey}`);
        expect.soft(response.status(), await response.text()).toBe(404);
      }
      expect(await (await client.get(`${lookup}/${card.key.toLowerCase()}`)).json()).toMatchObject({ id: card.id });
      expect((await client.get(`${prefix}/cards/${card.id}/detail`)).status()).toBe(200);
      expect((await (await client.get(`${prefix}/cards/${card.id}/comments`)).json() as { items: unknown[] }).items).toEqual([]);
    }
  } finally {
    await publicApi.dispose();
    await api.delete(`/api/me/api-keys/${key.id}`);
  }
});

test("corrupt JPEG uploads leave no attachment or stored file and valid uploads still work", async ({ apiAs, testWorkspace, playwright, uniqueName }) => {
  const api = await apiAs("amelia");
  const key = await (await api.post("/api/me/api-keys", { data: { label: uniqueName("image validation") } })).json() as { id: string; secret: string };
  const publicApi = await playwright.request.newContext({ baseURL: webOrigin, extraHTTPHeaders: { authorization: `Bearer ${key.secret}` } });
  try {
    const created = await api.post(`/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")}/cards`, { data: { title: uniqueName("Corrupt image") } });
    expect(created.status()).toBe(201);
    const card = await created.json() as { id: string };
    const jpeg = readFileSync(path.join(__dirname, "fixtures/sample.jpg"));
    const me = await (await api.get("/api/me")).json() as { clientId: string };
    const uploadRoot = path.join(process.env.UPLOADS_DIR!, me.clientId);
    const storedFiles = () => existsSync(uploadRoot)
      ? readdirSync(uploadRoot, { recursive: true, withFileTypes: true })
        .filter(file => file.isFile()).map(file => path.join(file.parentPath, file.name)).sort()
      : [];
    const before = storedFiles();
    for (const client of [api, publicApi]) {
      const prefix = client === api ? "/api" : v1;
      const response = await client.post(`${prefix}/cards/${card.id}/attachments`, { multipart: {
        file: { name: "truncated.jpg", mimeType: "image/jpeg", buffer: jpeg.subarray(0, Math.floor(jpeg.length / 2)) },
      } });
      expect(response.status(), await response.text()).toBe(400);
    }
    expect(storedFiles()).toEqual(before);
    expect((await (await api.get(`/api/cards/${card.id}/attachments`)).json() as unknown[])).toEqual([]);
    const valid = await publicApi.post(`${v1}/cards/${card.id}/attachments`, { multipart: {
      file: { name: "valid.jpg", mimeType: "image/jpeg", buffer: jpeg },
    } });
    expect(valid.status(), await valid.text()).toBe(201);
  } finally {
    await publicApi.dispose();
    await api.delete(`/api/me/api-keys/${key.id}`);
  }
});

test("malformed workspace paths and rejected writes leave the board unchanged", async ({ apiAs, testWorkspace, playwright, uniqueName }) => {
  const api = await apiAs("amelia");
  const keyResponse = await api.post("/api/me/api-keys", { data: { label: uniqueName("validation") } });
  expect(keyResponse.ok()).toBe(true);
  const key = await keyResponse.json() as { id: string; secret: string };
  const publicApi = await playwright.request.newContext({ baseURL: webOrigin, extraHTTPHeaders: { authorization: `Bearer ${key.secret}` } });
  try {
    for (const client of [api, publicApi]) {
      const prefix = client === api ? "/api" : v1;
      for (const id of ["undefined", "null", "not-a-uuid"]) {
        const response = await client.get(`${prefix}/workspaces/${id}/boards`);
        expect(response.status(), await response.text()).toBe(400);
        expect(await response.json()).toMatchObject({ code: "VALIDATION" });
      }
      expect((await client.get(`${prefix}/workspaces/${testWorkspace.id}/boards`)).status()).toBe(200);
      expect((await client.get(`${prefix}/workspaces/${randomUUID()}/boards`)).status()).toBe(404);
      const rejected = await client.patch(`${prefix}/boards/${testWorkspace.boardId}`, { data: { name: [] } });
      expect(rejected.status()).toBe(400);
      expect(await (await client.get(`${prefix}/boards/${testWorkspace.boardId}`)).json()).toMatchObject({ name: testWorkspace.boardName });
      const badQuery = await client.post(`${prefix}/boards/${testWorkspace.boardId}/open?listId=undefined&includeCards=false`);
      expect(badQuery.status()).toBe(400);
    }
    const callback = await publicApi.post(`${v1}/mcp-events/subscribe`, { data: {
      name: "priorities.changed", arguments: {}, delivery: { mode: "webhook", url: "not a URL", secret: `whsec_${"A".repeat(32)}` },
    } });
    expect(callback.status(), await callback.text()).toBe(400);
    for (const u of [`/api/media/${testWorkspace.id}/%`, "/api/media/undefined/file.png"]) {
      expect((await api.get("/api/media/resign", { params: { u } })).status()).toBe(404);
    }
    expect((await api.get(`/api/media/${testWorkspace.id}/%25`, { params: { t: "a".repeat(32), e: String(Date.now() + 60_000) } })).status()).toBe(404);
    const outsider = await apiAs("maya");
    expect([403, 404]).toContain((await outsider.get(`/api/workspaces/${testWorkspace.id}/boards`)).status());
  } finally {
    await publicApi.dispose();
    await api.delete(`/api/me/api-keys/${key.id}`);
  }
});

test("notification cursors survive empty polls and page tied timestamps in both directions", async ({ apiAs, testWorkspace, playwright, uniqueName }) => {
  const api = await apiAs("amelia");
  const me = await (await api.get("/api/me")).json() as { id: string; clientId: string };
  const key = await (await api.post("/api/me/api-keys", { data: { label: uniqueName("cursor") } })).json() as { id: string; secret: string };
  const publicApi = await playwright.request.newContext({ baseURL: webOrigin, extraHTTPHeaders: { authorization: `Bearer ${key.secret}` } });
  try {
    const empty = await publicApi.get(`${v1}/notifications`);
    expect(empty.status()).toBe(200);
    const baseline = await empty.json() as { items: unknown[]; cursor: string };
    expect(baseline.items).toEqual([]);
    const poll = await publicApi.get(`${v1}/notifications`, { params: { since: baseline.cursor } });
    expect(poll.status(), await poll.text()).toBe(200);
    expect(await poll.json()).toMatchObject({ items: [], cursor: baseline.cursor, hasMore: false });

    // Manufacture exact ties in the isolated E2E database: real fanout timing cannot reliably
    // create millisecond ties. All rows belong to this test's fixture and are cascade-cleaned.
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    const timestamp = baseline.cursor.split("|")[0]!;
    for (const id of [me.id, me.clientId, testWorkspace.id, testWorkspace.boardId, ...ids]) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    execFileSync("docker", ["compose", "-p", "kanera-e2e", "-f", path.join(__dirname, "../docker-compose.e2e.yml"), "exec", "-T", "postgres", "psql", "-U", "kanera_test", "-d", "kanera_test_e2e", "-v", "ON_ERROR_STOP=1", "-c",
      `INSERT INTO notification (id,user_id,client_id,workspace_id,board_id,reason,created_at) VALUES ${ids.map((id, index) => `('${id}','${me.id}','${me.clientId}','${testWorkspace.id}','${testWorkspace.boardId}','board_member_left','${timestamp}'::timestamptz + interval '1 microsecond' * ${Math.min(index, 1)})`).join(",")}`,
    ], { encoding: "utf8", timeout: 10_000 });
    let cursor = baseline.cursor;
    const forward: string[] = [];
    for (let i = 0; i < 3; i++) {
      const response = await publicApi.get(`${v1}/notifications`, { params: { since: cursor, limit: 1 } });
      expect(response.status(), await response.text()).toBe(200);
      const page = await response.json() as { items: { id: string }[]; cursor: string; hasMore: boolean };
      forward.push(...page.items.map(item => item.id));
      expect(page.hasMore).toBe(i < 2);
      cursor = page.cursor;
    }
    expect(forward).toEqual(ids);
    expect((await (await publicApi.get(`${v1}/notifications`, { params: { since: cursor } })).json() as { items: unknown[] }).items).toEqual([]);
    let reverseCursor: string | undefined;
    const reverse: string[] = [];
    for (let i = 0; i < 3; i++) {
      const response = await api.get("/api/notifications", { params: { limit: 1, ...(reverseCursor ? { cursor: reverseCursor } : {}) } });
      expect(response.status()).toBe(200);
      const page = await response.json() as { items: { id: string }[]; nextCursor: string };
      reverse.push(...page.items.map(item => item.id));
      reverseCursor = page.nextCursor;
    }
    expect(reverse).toEqual([...ids].reverse());
    const secondsOnly = new Date(Date.parse(timestamp) - 1_000).toISOString().replace(/\.\d+Z$/, "Z");
    for (const legacy of [timestamp, `${timestamp}|`, secondsOnly]) {
      const response = await api.get("/api/notifications", { params: { cursor: legacy } });
      expect(response.status(), await response.text()).toBe(200);
      expect((await response.json() as { items: unknown[] }).items).toEqual([]);
      const forwardPage = await publicApi.get(`${v1}/notifications`, { params: { since: legacy, limit: 30, includeSelf: false } });
      expect(forwardPage.status(), await forwardPage.text()).toBe(200);
      const body = await forwardPage.json() as { items: { id: string }[]; cursor: string; hasMore: boolean };
      expect(body.items.map(item => item.id)).toEqual(ids);
      expect(body.hasMore).toBe(false);
      expect((await (await publicApi.get(`${v1}/notifications`, { params: { since: body.cursor } })).json() as { items: unknown[] }).items).toEqual([]);
    }
    for (const malformed of ["garbage", "2026-02-30T00:00:00.000Z", `${timestamp}|undefined`, `${timestamp}|${randomUUID()}|extra`]) {
      expect((await api.get("/api/notifications", { params: { cursor: malformed } })).status()).toBe(400);
      expect((await publicApi.get(`${v1}/notifications`, { params: { since: malformed } })).status()).toBe(400);
    }
  } finally {
    await publicApi.dispose();
    await api.delete(`/api/me/api-keys/${key.id}`);
  }
});

test("invalid realtime payloads and rejected public writes cause no room or board effects", async ({ apiAs, testWorkspace, uniqueName }) => {
  const api = await apiAs("amelia");
  const keyResponse = await api.post("/api/me/api-keys", { data: { label: uniqueName("socket") } });
  expect(keyResponse.status(), await keyResponse.text()).toBe(201);
  const key = await keyResponse.json() as { id: string; secret: string };
  const login = await (await api.post("/api/auth/login", { data: { email: users.amelia.email, password: TEST_PASSWORD } })).json() as { accessToken: string };
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", String.raw`
      import assert from "node:assert/strict";
      import { io } from "socket.io-client";
      const socket = io(process.env.TEST_ORIGIN, { auth: { token: process.env.TEST_TOKEN }, transports: ["websocket"], reconnection: false });
      try {
        await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
        for (const value of [null, {}, [], "undefined", "null", ""]) {
          assert.equal(await socket.timeout(3000).emitWithAck("workspace:join", value), false);
          assert.equal(await socket.timeout(3000).emitWithAck("board:join", value), false);
          socket.emit("workspace:leave", value);
          socket.emit("board:leave", value);
        }
        // Missing callbacks must be harmless even with a syntactically valid resource.
        socket.emit("workspace:join", process.env.TEST_WORKSPACE);
        socket.emit("board:join", process.env.TEST_BOARD);
        assert.equal(await socket.timeout(3000).emitWithAck("workspace:join", process.env.TEST_WORKSPACE), true);
        assert.equal(await socket.timeout(3000).emitWithAck("board:join", process.env.TEST_BOARD), true);
        const events = [];
        socket.on("board:updated", data => events.push(data));
        const endpoint = process.env.TEST_ORIGIN + "/public-api/api/v1/boards/" + process.env.TEST_BOARD;
        const patch = name => fetch(endpoint, { method: "PATCH", headers: { authorization: "Bearer " + process.env.TEST_KEY, "content-type": "application/json" }, body: JSON.stringify({ name }) });
        assert.equal((await patch([])).status, 400);
        await new Promise(resolve => setTimeout(resolve, 750));
        assert.equal(events.length, 0);
        const changed = process.env.TEST_NAME + " valid";
        assert.equal((await patch(changed)).status, 200);
        const deadline = Date.now() + 10000;
        while (!events.some(event => JSON.stringify(event).includes(changed)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        assert.ok(events.some(event => JSON.stringify(event).includes(changed)), "valid control write must arrive through real outbox/socket");
        assert.equal((await patch(process.env.TEST_NAME)).status, 200);
      } finally { socket.close(); }
    `], {
      cwd: path.join(__dirname, "../apps/api"), encoding: "utf8", timeout: 25_000,
      env: { ...process.env, TEST_ORIGIN: webOrigin, TEST_TOKEN: login.accessToken, TEST_KEY: key.secret, TEST_WORKSPACE: testWorkspace.id, TEST_BOARD: testWorkspace.boardId, TEST_NAME: testWorkspace.boardName },
    });
  } finally {
    await api.patch(`/api/boards/${testWorkspace.boardId}`, { data: { name: testWorkspace.boardName } });
    await api.delete(`/api/me/api-keys/${key.id}`);
  }
});

test("work history accepts checklist completion keys when paging", async ({ apiAs, testWorkspace, uniqueName }) => {
  const api = await apiAs("amelia");
  const created = await api.post(`/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")}/cards`, { data: { title: uniqueName("history") } });
  expect(created.status()).toBe(201);
  const card = await created.json() as { id: string };
  const checklistResponse = await api.post(`/api/cards/${card.id}/checklists`, { data: { title: "History", items: [{ text: "One" }, { text: "Two" }] } });
  expect(checklistResponse.status(), await checklistResponse.text()).toBe(201);
  const checklist = await checklistResponse.json() as { items: { id: string }[] };
  for (const item of checklist.items) {
    expect((await api.patch(`/api/cards/${card.id}/checklist-items/${item.id}`, { data: { completed: true } })).status()).toBe(200);
  }
  let cursor: string | undefined;
  let usedChecklistCursor = false;
  const seen: string[] = [];
  for (let page = 0; page < 10; page++) {
    if (cursor) usedChecklistCursor ||= (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { id: string }).id.startsWith("checklistItem:");
    const response = await api.post("/api/me/work-history", { data: { preset: "today", timeZone: "UTC", limit: 1, ...(cursor ? { cursor } : {}) } });
    expect(response.status(), await response.text()).toBe(200);
    const result = await response.json() as { events: { id: string }[]; nextCursor: string | null };
    seen.push(...result.events.map(event => event.id));
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  expect(usedChecklistCursor).toBe(true);
  expect(new Set(seen).size).toBe(seen.length);
  for (const item of checklist.items) expect(seen).toContain(`checklistItem:${item.id}`);
});

test("direct writes reject invalid scalar values before mutation or activity", async ({ apiAs, testWorkspace, uniqueName }) => {
  const api = await apiAs("amelia");
  const created = await api.post(`/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")}/cards`, { data: { title: uniqueName("Scalar boundaries") } });
  expect(created.status()).toBe(201);
  const card = await created.json() as { id: string };
  for (const createdAt of ["0000-01-01T00:00:00Z", "2026-02-30T00:00:00Z"]) {
    const cursor = Buffer.from(JSON.stringify({ kind: "cardFeed", createdAt, id: randomUUID(), priority: 0 })).toString("base64url");
    const response = await api.get(`/api/cards/${card.id}/feed`, { params: { cursor } });
    expect(response.status(), await response.text()).toBe(400);
  }
  const numberField = await api.post(`/api/workspaces/${testWorkspace.id}/custom-fields`, { data: { name: uniqueName("Number"), type: "number" } });
  expect(numberField.status()).toBe(201);
  const field = await numberField.json() as { id: string };
  const urlFieldResponse = await api.post(`/api/workspaces/${testWorkspace.id}/custom-fields`, { data: { name: uniqueName("URL"), type: "url" } });
  expect(urlFieldResponse.status()).toBe(201);
  const urlField = await urlFieldResponse.json() as { id: string };
  const detailBefore = await api.get(`/api/cards/${card.id}/detail`);
  expect(detailBefore.status()).toBe(200);
  const before: unknown = await detailBefore.json();
  const feedResponse = await api.get(`/api/cards/${card.id}/feed`);
  expect(feedResponse.status()).toBe(200);
  const activityBefore: unknown = await feedResponse.json();
  const invalid = [
    ...["javascript:alert(1)", "data:text/html,<script>alert(1)</script>"].map(valueUrl => ({ method: "put" as const, url: `/api/cards/${card.id}/custom-fields/${urlField.id}`, data: { valueUrl } })),
    ...["not-a-number", "NaN", "Infinity", "1e999999", "1e-999999", "0e999999", "0x10", ""].map(valueNumber => ({ method: "put" as const, url: `/api/cards/${card.id}/custom-fields/${field.id}`, data: { valueNumber } })),
    ...["2026-02-30", "2025-02-29", "2026-13-01", "2026-00-01", "0000-01-01"].map(dueDateLocalDate => ({ method: "patch" as const, url: `/api/cards/${card.id}`, data: { dueDateLocalDate } })),
  ];
  for (const request of invalid) {
    const response = await api[request.method](request.url, { data: request.data });
    expect.soft(response.status(), `${JSON.stringify(request.data)}: ${await response.text()}`).toBe(400);
  }
  const run = await api.post(`/api/cards/${card.id}/agent-runs`, { data: { title: "Unsafe run URL", externalUrl: "javascript:alert(1)" } });
  expect(run.status(), await run.text()).toBe(400);
  expect(await (await api.get(`/api/cards/${card.id}/detail`)).json()).toEqual(before);
  expect(await (await api.get(`/api/cards/${card.id}/feed`)).json()).toEqual(activityBefore);
  // Decimal/exponent strings preserve the API's string-or-number contract, and leap days remain valid.
  expect((await api.put(`/api/cards/${card.id}/custom-fields/${field.id}`, { data: { valueNumber: "-1.25e2" } })).status()).toBe(200);
  expect((await api.patch(`/api/cards/${card.id}`, { data: { dueDateLocalDate: "2028-02-29" } })).status()).toBe(200);
});

test("decoded text and uploaded archives reject unsafe values before storage", async ({ apiAs, testWorkspace, uniqueName }) => {
  const api = await apiAs("amelia");
  const boardBefore: unknown = await (await api.get(`/api/boards/${testWorkspace.boardId}`)).json();
  const nul = await api.patch(`/api/boards/${testWorkspace.boardId}`, { data: { name: "unsafe\u0000name" } });
  expect.soft(nul.status(), await nul.text()).toBe(400);
  expect(await (await api.get(`/api/boards/${testWorkspace.boardId}`)).json()).toEqual(boardBefore);
  const exported = await api.get(`/api/boards/${testWorkspace.boardId}/export`);
  expect(exported.status(), await exported.text()).toBe(200);
  const archive = await exported.json() as { board: Record<string, unknown>; lists: { id: string }[] };
  const fieldId = randomUUID();
  for (const changes of [
    { board: { ...archive.board, description: { injected: true } } },
    { customFields: [{ id: fieldId, name: "Malformed field", type: "number", options: "not-an-array" }] },
    { cards: [{ id: randomUUID(), listId: archive.lists[0]!.id, title: "Invalid date", position: "1", dueDateLocalDate: "2026-02-30" }] },
    { cardCustomFieldValues: [{ cardId: randomUUID(), fieldId, valueNumber: "NaN" }] },
    { board: { ...archive.board, name: "bad\u0000archive" } },
  ]) {
    const response = await api.post(`/api/workspaces/${testWorkspace.id}/imports/kanera-board/analyze`, { multipart: { file: { name: `${uniqueName("invalid")}.json`, mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...archive, ...changes })) } } });
    expect.soft(response.status(), await response.text()).toBe(400);
  }
});

test("public replay fingerprints reject excessive JSON nesting without side effects", async ({ apiAs, testWorkspace, playwright, uniqueName }) => {
  const api = await apiAs("amelia");
  const key = await (await api.post("/api/me/api-keys", { data: { label: uniqueName("depth") } })).json() as { id: string; secret: string };
  const publicApi = await playwright.request.newContext({ baseURL: webOrigin, extraHTTPHeaders: { authorization: `Bearer ${key.secret}` } });
  try {
    const body = '{"name":"Unsafe change","extension":' + '['.repeat(10_000) + 'null' + ']'.repeat(10_000) + '}';
    const response = await publicApi.patch(`${v1}/boards/${testWorkspace.boardId}`, { headers: { "content-type": "application/json", "idempotency-key": randomUUID() }, data: body });
    expect(response.status(), await response.text()).toBe(400);
    expect(await (await api.get(`/api/boards/${testWorkspace.boardId}`)).json()).toMatchObject({ name: testWorkspace.boardName });
  } finally {
    await publicApi.dispose();
    await api.delete(`/api/me/api-keys/${key.id}`);
  }
});

test("text search and external-link decoders handle malformed embedded identifiers", async ({ apiAs, testWorkspace }) => {
  const api = await apiAs("amelia");
  for (const q of ["AB-2147483648", `AB-${"9".repeat(150)}`]) {
    const response = await api.get("/api/search", { params: { q } });
    expect.soft(response.status(), await response.text()).toBe(200);
  }
  const created = await api.post(`/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")}/cards`, { data: { title: 'validationneedle <a href=javascript:alert(1)>unsafe link</a> remains text' } });
  expect(created.status()).toBe(201);
  const results = await (await api.get("/api/search", { params: { q: "validationneedle" } })).json() as { cards: { snippet: string }[] };
  expect(results.cards.length).toBeGreaterThan(0);
  for (const result of results.cards) expect.soft(result.snippet).not.toMatch(/<(?!\/?mark>)/);
  const embedded = await api.post(`/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")}/cards`, { data: {
    title: "Malformed internal link remains text", description: `[Example](/w/${testWorkspace.id}/notes?noteId=${"f".repeat(36)})`,
  } });
  expect(embedded.status(), await embedded.text()).toBe(201);
  const github = await api.post("/api/github-links/resolve", { data: { workspaceId: testWorkspace.id, urls: ["https://github.com/example/repo/releases/tag/%"] } });
  expect.soft(github.status(), await github.text()).toBe(200);
});


test("direct organisation configuration rejects header and protocol injection", async ({ apiAs }) => {
  const api = await apiAs("amelia");
  const before: unknown = await (await api.get("/api/clients/me")).json();
  const smtp = { host: "mail.example.test", port: 587, security: "starttls", fromEmail: "sender@example.test" };
  for (const data of [
    { smtpConfig: { ...smtp, fromName: "Sender\r\nBcc: injected@example.test" } },
    { smtpConfig: { ...smtp, host: "mail.example.test\r\nMAIL FROM: x" } },
    { storageConfig: { kind: "s3", endpoint: "file:///etc/passwd", region: "test", bucket: "test", accessKeyId: "test", secretAccessKey: "test" } },
  ]) {
    const response = await api.patch("/api/clients/me", { data });
    expect(response.status(), await response.text()).toBe(400);
  }
  expect(await (await api.get("/api/clients/me")).json()).toEqual(before);
});

test("external import identifiers cannot inherit mappings from object prototypes", async ({ apiAs, testWorkspace, uniqueName }) => {
  const api = await apiAs("amelia");
  const source = {
    id: "board", name: "Imported board",
    lists: [{ id: "constructor", name: "Must stay skipped" }, { id: "safe", name: "Imported list" }],
    labels: [{ id: "label", name: "Prototype color", color: "constructor" }],
    customFields: [{ id: "field", name: "Prototype type", type: "constructor" }],
    cards: [{ id: "card", idList: "safe", name: "Imported card", idMembers: ["constructor"] }],
    actions: [{ id: "comment", type: "commentCard", date: "0000-01-01T00:00:00Z", data: { card: { id: "card" }, text: "Legacy invalid timestamp" } }],
  };
  const analyzed = await api.post(`/api/workspaces/${testWorkspace.id}/imports/trello/analyze`, { multipart: {
    file: { name: "prototype-ids.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(source)) },
  } });
  expect(analyzed.status(), await analyzed.text()).toBe(201);
  const plan = await analyzed.json() as { importId: string; manifest: { labels: { suggestedToken: string }[]; customFields: { suggestedType: string }[] } };
  expect(plan.manifest.labels[0]?.suggestedToken).toBe("gray");
  expect(plan.manifest.customFields[0]?.suggestedType).toBe("text");
  const committed = await api.post(`/api/imports/${plan.importId}/commit`, { data: {
    board: { name: uniqueName("Import mappings") }, lists: { safe: { action: "create" } },
    labels: { label: { action: "create" } }, customFields: { field: { action: "create" } }, members: {}, options: { attachmentCopyMode: "skip" },
  } });
  expect(committed.status(), await committed.text()).toBe(200);
  expect(await committed.json()).toMatchObject({ lists: { created: 1 }, labels: { created: 1 }, customFields: { created: 1 }, cards: { created: 1 }, comments: 1 });
});
