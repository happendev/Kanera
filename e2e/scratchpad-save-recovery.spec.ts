import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { SocketLink } from "./support/socket";

async function content(api: APIRequestContext, id: string): Promise<string | undefined> {
  const response = await api.get("/api/scratchpad/notes");
  expect(response.ok(), await response.text()).toBe(true);
  const notes = await response.json() as { id: string; content: string }[];
  return notes.find((note) => note.id === id)?.content;
}

async function drafts(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("kanera:editor-drafts") ?? "{}") as unknown);
}

test("a single docked scratchpad preserves text across late foreground reads and reconnect", async ({ page, signIn, apiAs }, info) => {
  const api = await apiAs("amelia");
  const created = await api.post("/api/scratchpad/notes", { data: { title: "Existing page" } });
  expect(created.ok()).toBe(true);
  const note = await created.json() as { id: string };
  expect((await api.patch(`/api/scratchpad/notes/${note.id}`, { data: { content: "Original text" } })).ok()).toBe(true);
  const link = await SocketLink.install(page.context());
  await signIn(page, "amelia");
  await page.getByRole("button", { name: "Scratchpad", exact: true }).click();
  const editor = page.locator("k-scratchpad-panel .ProseMirror");
  await expect(editor).toHaveText("Original text");
  let release!: () => void;
  let held = false;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/scratchpad/notes", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    held = true;
    await pending;
    await route.fulfill({ response });
  });
  try {
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => held).toBe(true);
    await editor.fill("Original text with my morning notes");
    await expect.poll(() => content(api, note.id)).toBe("Original text with my morning notes");
    await expect.poll(() => drafts(page)).toEqual({});
    const refreshed = page.waitForResponse((response) => response.request().method() === "GET" && response.url().endsWith("/api/scratchpad/notes"));
    release();
    await refreshed;
    await expect(editor).toHaveText("Original text with my morning notes");
    await page.unrouteAll({ behavior: "wait" });
    await link.cut();
    await expect.poll(() => link.refusedAttempts).toBeGreaterThan(0);
    // Cutting realtime leaves HTTP available. Refuse saves too, otherwise a fast PATCH clears
    // the recovery draft before we can observe the unsaved text.
    const saveUrl = `**/api/scratchpad/notes/${note.id}`;
    await page.route(saveUrl, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await route.abort("connectionreset");
    });
    await editor.fill("Original text with my morning notes and offline additions");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    // The client may reject the save before HTTP once its offline indicator catches up.
    await expect(page.locator("k-scratchpad-panel").getByRole("status")).toHaveText("Not saved");
    await expect.poll(async () => JSON.stringify(await drafts(page))).toContain("offline additions");
    expect(await content(api, note.id)).toBe("Original text with my morning notes");
    await page.unroute(saveUrl);
    link.restore();
    // A refused handshake can recover through the 15-second reconnect watchdog.
    await expect.poll(() => link.connectionCount, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(() => content(api, note.id)).toBe("Original text with my morning notes and offline additions");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(editor).toHaveText("Original text with my morning notes and offline additions");
    await page.screenshot({ path: info.outputPath("single-tab-foreground.png") });
  } finally {
    release();
    link.restore();
  }
});

test("an idle scratchpad session cannot autosave received text over a newer edit", async ({ page, signIn, pageAs, apiAs, uniqueName }, info) => {
  const api = await apiAs("amelia");
  const created = await api.post("/api/scratchpad/notes", { data: { title: uniqueName("Scratchpad save recovery") } });
  expect(created.ok(), await created.text()).toBe(true);
  const note = await created.json() as { id: string };
  await signIn(page, "amelia");
  await page.goto("/scratchpad");
  const other = await pageAs("amelia");
  await other.goto("/scratchpad");
  const editor = page.locator("k-scratchpad-panel .ProseMirror");
  const otherEditor = other.locator("k-scratchpad-panel .ProseMirror");
  await expect(editor).toBeVisible();
  await expect(otherEditor).toBeVisible();

  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const idleWrites: unknown[] = [];
  await other.route(`**/api/scratchpad/notes/${note.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    idleWrites.push(route.request().postDataJSON());
    await pending;
    await route.continue();
  });
  try {
    await editor.fill("First thought");
    await expect.poll(() => content(api, note.id)).toBe("First thought");
    await expect(otherEditor).toHaveText("First thought");
    // Bound the observation past the 600 ms autosave debounce. Only the writing session may
    // issue a PATCH; the idle session must treat incoming text as already persisted.
    await other.waitForTimeout(900);
    await editor.fill("First thought and the important new notes");
    await expect.poll(() => content(api, note.id)).toBe("First thought and the important new notes");
    await expect.poll(() => drafts(page)).toEqual({});
    release();
    // Allow a mistakenly queued idle write to commit and fan out through the real outbox.
    await other.waitForTimeout(1500);
    await info.attach("save-recovery-evidence.json", {
      body: JSON.stringify({ idleWrites, persisted: await content(api, note.id), writerText: await editor.innerText(), writerDrafts: await drafts(page), idleDrafts: await drafts(other) }, null, 2),
      contentType: "application/json",
    });
    await page.screenshot({ path: info.outputPath("scratchpad-recovery-desktop.png"), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: info.outputPath("scratchpad-recovery-phone.png"), animations: "disabled" });
    expect(idleWrites).toEqual([]);
    await expect.poll(() => content(api, note.id)).toBe("First thought and the important new notes");
    await expect(editor).toHaveText("First thought and the important new notes");
    await expect(otherEditor).toHaveText("First thought and the important new notes");
  } finally {
    release();
    await other.unrouteAll({ behavior: "wait" });
  }
});

test("saving a note in another tab preserves this tab's unsaved recovery copy", async ({ page, signIn, apiAs, testWorkspace }, info) => {
  const api = await apiAs("amelia");
  const created = await api.post(`/api/boards/${testWorkspace.boardId}/notes`, { data: { scope: "personal", title: "Two-tab recovery" } });
  expect(created.ok(), await created.text()).toBe(true);
  const note = await created.json() as { id: string };
  expect((await api.patch(`/api/notes/${note.id}`, { data: { content: "Original body" } })).ok()).toBe(true);
  const url = `/b/${testWorkspace.boardId}?view=notes&noteId=${note.id}`;
  await signIn(page, "amelia", url);
  const other = await page.context().newPage();
  await other.goto(url);
  await expect(other.locator("k-note-editor .ne-viewer")).toContainText("Original body");
  await page.locator("k-note-editor .ne-viewer").click();
  await page.locator("k-note-editor .tiptap").fill("Unsaved notes in the first tab");
  await other.locator("k-note-editor .ne-viewer").click();
  await other.locator("k-note-editor .tiptap").fill("Published from the second tab");
  // Keep the first tab's draft as the latest recovery copy while the second tab saves its own text.
  await page.locator("k-note-editor .tiptap").fill("Unsaved notes in the first tab continued");
  const before = await drafts(page);
  await other.locator("k-note-editor").getByRole("button", { name: "Save", exact: true }).click();
  await expect(other.locator("k-note-editor .ne-viewer")).toContainText("Published from the second tab");
  await expect(page.locator("k-note-editor .tiptap")).toHaveText("Unsaved notes in the first tab continued");
  const after = await drafts(page);
  await info.attach("note-draft-evidence.json", { body: JSON.stringify({ before, after }, null, 2), contentType: "application/json" });
  await page.screenshot({ path: info.outputPath("note-draft-desktop.png") });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.reload();
  await page.screenshot({ path: info.outputPath("note-after-reload.png") });
  expect(JSON.stringify(after)).toContain("Unsaved notes in the first tab continued");
  await expect(page.locator("k-note-editor")).toContainText("Unsaved notes in the first tab continued");
});
