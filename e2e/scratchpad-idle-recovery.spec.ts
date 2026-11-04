import type { APIRequestContext, Page, TestInfo } from "@playwright/test";
import { expect, test } from "./support/fixtures";

async function savedContent(api: APIRequestContext, id: string): Promise<string | undefined> {
  const response = await api.get("/api/scratchpad/notes");
  expect(response.ok(), await response.text()).toBe(true);
  const notes = await response.json() as { id: string; content: string }[];
  return notes.find((note) => note.id === id)?.content;
}

async function recoveryDrafts(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("kanera:editor-drafts") ?? "{}") as unknown);
}

async function foreground(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

async function evidence(page: Page, info: TestInfo, name: string, details: unknown) {
  await info.attach(`${name}.json`, { body: JSON.stringify(details, null, 2), contentType: "application/json" });
  await page.screenshot({ path: info.outputPath(`${name}-desktop.png`), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath(`${name}-phone.png`), animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 900 });
}

for (const saveSucceeds of [true, false]) {
  test(`a single-tab background read failure preserves ${saveSucceeds ? "saved" : "unsaved"} text`, async ({ page, signIn, apiAs }, info) => {
    const api = await apiAs("amelia");
    const created = await api.post("/api/scratchpad/notes", { data: { title: "Morning scratchpad" } });
    expect(created.ok()).toBe(true);
    const note = await created.json() as { id: string };
    expect((await api.patch(`/api/scratchpad/notes/${note.id}`, { data: { content: "Yesterday's notes" } })).ok()).toBe(true);
    await signIn(page, "amelia");
    await page.getByRole("button", { name: "Scratchpad", exact: true }).click();
    const editor = page.locator("k-scratchpad-panel .ProseMirror");
    await expect(editor).toHaveText("Yesterday's notes");
    const morning = "Yesterday's notes plus this morning's work";
    if (!saveSucceeds) {
      await page.route(`**/api/scratchpad/notes/${note.id}`, (route) => route.request().method() === "PATCH"
        ? route.abort("connectionreset") : route.continue());
    }
    await editor.fill(morning);
    if (saveSucceeds) {
      await expect.poll(() => savedContent(api, note.id)).toBe(morning);
      await expect.poll(() => recoveryDrafts(page)).toEqual({});
    } else {
      await expect.poll(async () => JSON.stringify(await recoveryDrafts(page))).toContain(morning);
    }

    let failedRead = false;
    await page.route("**/api/scratchpad/notes", async (route) => {
      if (route.request().method() !== "GET" || failedRead) return route.continue();
      failedRead = true;
      await route.abort("connectionreset");
    });
    const failedRequest = page.waitForEvent("requestfailed", (request) => request.url().endsWith("/api/scratchpad/notes") && request.method() === "GET");
    await foreground(page);
    await failedRequest;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect.poll(() => failedRead).toBe(true);
    // A background read failure must leave the warm editor and its current document mounted.
    await expect(editor).toHaveText(morning);
    // Recovery is another automatic foreground read; no close/reopen, second tab or user retry.
    await foreground(page);
    await expect(editor).toBeVisible();
    const restored = await editor.innerText();
    const persistedBeforeTyping = await savedContent(api, note.id);
    await evidence(page, info, "background-read-recovery", { restored, persistedBeforeTyping, drafts: await recoveryDrafts(page) });

    // A display-only rollback becomes a destructive write when the user continues typing.
    await editor.press("Control+End");
    await page.keyboard.insertText(" continued");
    if (saveSucceeds) await expect.poll(() => savedContent(api, note.id)).toBe(`${restored} continued`);
    else await expect.poll(async () => JSON.stringify(await recoveryDrafts(page))).toContain(`${restored} continued`);
    await info.attach("after-next-keystroke.json", {
      body: JSON.stringify({ persisted: await savedContent(api, note.id), drafts: await recoveryDrafts(page) }, null, 2),
      contentType: "application/json",
    });
    expect(restored).toBe(morning);
    if (saveSucceeds) expect(await savedContent(api, note.id)).toBe(`${morning} continued`);
  });
}

test("a late scratchpad acknowledgement preserves newer work after closing the dock", async ({ page, signIn, apiAs }, info) => {
  const api = await apiAs("amelia");
  const created = await api.post("/api/scratchpad/notes", { data: { title: "Delayed autosave" } });
  expect(created.ok()).toBe(true);
  const note = await created.json() as { id: string };
  await signIn(page, "amelia");
  await page.getByRole("button", { name: "Scratchpad", exact: true }).click();
  const editor = page.locator("k-scratchpad-panel .ProseMirror");
  await expect(editor).toBeVisible();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  let rejected = false;
  await page.route(`**/api/scratchpad/notes/${note.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    if (held) { rejected = true; return route.abort("connectionreset"); }
    const response = await route.fetch();
    held = true;
    await pending;
    await route.fulfill({ response });
  });
  try {
    await editor.fill("First saved sentence");
    await expect.poll(() => held).toBe(true);
    await editor.fill("First saved sentence with additional unsaved work");
    await page.getByRole("button", { name: "Close scratchpad", exact: true }).click();
    await expect(editor).toHaveCount(0);
    const before = await recoveryDrafts(page);
    release();
    await expect.poll(() => rejected).toBe(true);
    const after = await recoveryDrafts(page);
    await evidence(page, info, "late-save-closed-dock", { before, after, persisted: await savedContent(api, note.id) });
    // Reload only after confirming the second save failed: recovery must not depend on RAM.
    await page.unrouteAll({ behavior: "wait" });
    page.once("dialog", (dialog) => void dialog.accept());
    await page.reload();
    await page.getByRole("button", { name: "Scratchpad", exact: true }).click();
    await expect(editor).toBeVisible();
    await evidence(page, info, "late-save-after-reload", { restored: await editor.innerText(), drafts: await recoveryDrafts(page) });
    expect(JSON.stringify(after)).toContain("additional unsaved work");
    await expect(editor).toHaveText("First saved sentence with additional unsaved work");
  } finally {
    release();
  }
});

test("a single-tab note retains its draft through a failed foreground read", async ({ page, signIn, apiAs, testWorkspace }, info) => {
  const api = await apiAs("amelia");
  const created = await api.post(`/api/boards/${testWorkspace.boardId}/notes`, { data: { scope: "personal", title: "Morning note" } });
  expect(created.ok()).toBe(true);
  const note = await created.json() as { id: string };
  expect((await api.patch(`/api/notes/${note.id}`, { data: { content: "Yesterday's notes" } })).ok()).toBe(true);
  await signIn(page, "amelia", `/b/${testWorkspace.boardId}?view=notes&noteId=${note.id}`);
  await page.locator("k-note-editor .ne-viewer").click();
  const editor = page.locator("k-note-editor .tiptap");
  const morning = "Yesterday's notes plus this morning's work";
  await editor.fill(morning);
  let failedRead = false;
  await page.route(`**/api/boards/${testWorkspace.boardId}/notes?scope=personal`, async (route) => {
    if (failedRead) return route.continue();
    failedRead = true;
    await route.abort("connectionreset");
  });
  await foreground(page);
  await expect.poll(() => failedRead).toBe(true);
  const refreshed = page.waitForResponse((response) => response.url().endsWith(`/notes?scope=personal`));
  await foreground(page);
  expect((await refreshed).ok()).toBe(true);
  await expect(editor).toHaveText(morning);
  await expect.poll(async () => JSON.stringify(await recoveryDrafts(page))).toContain(morning);
  await evidence(page, info, "note-foreground-recovery", { restored: await editor.innerText(), drafts: await recoveryDrafts(page) });
  await page.locator("k-note-editor").getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("k-note-editor .ne-viewer")).toContainText(morning);
  expect((await (await api.get(`/api/notes/${note.id}`)).json() as { content: string }).content).toBe(morning);
});
