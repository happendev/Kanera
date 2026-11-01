import type { APIRequestContext, Page, TestInfo } from "@playwright/test";
import { expect, test } from "./support/fixtures";

type Note = { id: string; title: string; content: string; updatedAt: string; editingUserId: string | null };
const draftKey = "kanera:editor-drafts";

async function createNote(api: APIRequestContext, boardId: string, title: string): Promise<Note> {
  const created = await api.post(`/api/boards/${boardId}/notes`, { data: { scope: "team", title } });
  expect(created.ok(), await created.text()).toBe(true);
  const note = await created.json() as Note;
  const saved = await api.patch(`/api/notes/${note.id}`, { data: { content: "Original body" } });
  expect(saved.ok(), await saved.text()).toBe(true);
  return saved.json() as Promise<Note>;
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function screenshots(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}-desktop.png`), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("k-note-editor")).toBeVisible();
  await page.screenshot({ path: info.outputPath(`${name}-phone.png`), animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function leaveDraft(page: Page, api: APIRequestContext, note: Note) {
  await page.locator("k-note-editor .ne-viewer").click();
  await page.locator("k-note-editor .tiptap").fill("My recovered draft");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Board view", exact: true }).click();
  await expect(page.locator("k-note-editor")).toHaveCount(0);
  await expect.poll(async () => ((await (await api.get(`/api/notes/${note.id}`)).json()) as Note).editingUserId).toBeNull();
}

for (const legacy of [false, true]) {
  test(`recovered ${legacy ? "legacy" : "versioned"} note drafts cannot overwrite intervening edits`, async ({ page, signIn, apiAs, testWorkspace }, info) => {
    const api = await apiAs("amelia");
    const note = await createNote(api, testWorkspace.boardId, "Recovered note");
    const url = `/b/${testWorkspace.boardId}?view=notes&noteId=${note.id}`;
    await signIn(page, "amelia", url);
    await leaveDraft(page, api, note);
    if (legacy) {
      await page.evaluate((key) => {
        const drafts = JSON.parse(localStorage.getItem(key)!) as Record<string, { baseUpdatedAt?: string }>;
        for (const draft of Object.values(drafts)) delete draft.baseUpdatedAt;
        localStorage.setItem(key, JSON.stringify(drafts));
      }, draftKey);
    }
    expect((await api.patch(`/api/notes/${note.id}`, { data: { content: "Newer server body" } })).ok()).toBe(true);
    await page.goto(url);
    const editor = page.locator("k-note-editor");
    await expect(editor.locator(".tiptap")).toHaveText("My recovered draft");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor.locator(".ne-banner.is-error")).toContainText("This note changed since you started editing");
    await expect(editor.locator(".tiptap")).toHaveText("My recovered draft");
    expect(((await (await api.get(`/api/notes/${note.id}`)).json()) as Note).content).toBe("Newer server body");
    // Continuing to type must retain the original baseline for the next recovery.
    await editor.locator(".tiptap").fill("My recovered draft continued");
    const drafts = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!) as Record<string, { markdown: string; baseMarkdown: string; baseUpdatedAt?: string }>, draftKey);
    expect(Object.values(drafts)).toContainEqual(expect.objectContaining({ markdown: "My recovered draft continued", baseMarkdown: "Original body" }));
    if (!legacy) expect(Object.values(drafts)[0]?.baseUpdatedAt).toBe(note.updatedAt);
    await screenshots(page, info, `conflict-${legacy ? "legacy" : "versioned"}`);
  });
}

test("a foreground refresh keeps the recovered draft preview while another user holds the lock", async ({ page, signIn, apiAs, testWorkspace }, info) => {
  const api = await apiAs("amelia");
  const note = await createNote(api, testWorkspace.boardId, "Locked recovered note");
  const url = `/b/${testWorkspace.boardId}?view=notes&noteId=${note.id}`;
  await signIn(page, "amelia", url);
  await leaveDraft(page, api, note);
  const other = await apiAs("marcus");
  expect((await other.post(`/api/notes/${note.id}/lock`, { data: {} })).ok()).toBe(true);
  await page.goto(url);
  const viewer = page.locator("k-note-editor .ne-viewer");
  await expect(viewer).toContainText("My recovered draft");
  const refreshed = page.waitForResponse((response) => response.url().includes(`/boards/${testWorkspace.boardId}/notes?scope=team`));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await refreshed;
  // The lock banner also confirms that the refresh retained the current lock metadata.
  await expect(page.locator("k-note-editor .ne-banner").first()).toContainText("editing this note");
  await expect(viewer).toContainText("My recovered draft");
  await screenshots(page, info, "locked-draft");
});

test("an attachment refresh arriving after a body save cannot restore the old body", async ({ page, signIn, apiAs, testWorkspace }, info) => {
  const api = await apiAs("amelia");
  const note = await createNote(api, testWorkspace.boardId, "Delayed attachment refresh");
  await signIn(page, "amelia", `/b/${testWorkspace.boardId}?view=notes&noteId=${note.id}`);
  const pending = gate();
  let held = false;
  await page.route(`**/api/notes/${note.id}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    held = true;
    await pending.promise;
    await route.fulfill({ response });
  });
  const editor = page.locator("k-note-editor");
  const refreshed = page.waitForResponse((response) => response.url().endsWith(`/api/notes/${note.id}`) && response.request().method() === "GET");
  try {
    await editor.locator('input[type="file"]').setInputFiles({ name: "context.txt", mimeType: "text/plain", buffer: Buffer.from("Attachment context") });
    await expect.poll(() => held).toBe(true);
    await editor.locator(".ne-viewer").click();
    await editor.locator(".tiptap").fill("New saved body");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor.locator(".ne-viewer")).toContainText("New saved body");
  } finally {
    pending.release();
  }
  await refreshed;
  await expect(editor.locator(".ne-viewer")).toContainText("New saved body");
  await screenshots(page, info, "late-read");
});

for (const field of ["icon", "color"] as const) {
  test(`a late ${field} response cannot change the next note's save baseline`, async ({ page, signIn, apiAs, testWorkspace }, info) => {
    const api = await apiAs("amelia");
    const first = await createNote(api, testWorkspace.boardId, "First note");
    const second = await createNote(api, testWorkspace.boardId, "Second note");
    await signIn(page, "amelia", `/b/${testWorkspace.boardId}?view=notes&noteId=${first.id}`);
    const pending = gate();
    let held = false;
    await page.route(`**/api/notes/${first.id}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      const response = await route.fetch();
      held = true;
      await pending.promise;
      await route.fulfill({ response });
    });
    const saved = page.waitForResponse((response) => response.url().endsWith(`/api/notes/${first.id}`) && response.request().method() === "PATCH");
    const editor = page.locator("k-note-editor");
    try {
      if (field === "icon") {
        await editor.locator(".ip-trigger").click();
        await editor.locator(".ip-icon").filter({ has: page.locator(".ti-rocket") }).click();
      } else {
        await editor.locator(".cp-trigger").click();
        await editor.locator(".cp-cell:not(.cp-no-color)").first().click();
      }
      await expect.poll(() => held).toBe(true);
      await page.locator("k-notes-tree").getByText(second.title, { exact: true }).click();
      await expect(editor.locator(".ne-title")).toHaveText(second.title);
      await editor.locator(".ne-viewer").click();
      await editor.locator(".tiptap").fill("Second note saved safely");
    } finally {
      pending.release();
    }
    await saved;
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor.locator(".ne-viewer")).toContainText("Second note saved safely");
    await expect(editor.locator(".ne-banner.is-error")).toHaveCount(0);
    expect(((await (await api.get(`/api/notes/${second.id}`)).json()) as Note).content).toBe("Second note saved safely");
    await screenshots(page, info, `late-${field}`);
  });
}

test("an unchanged draft resumes and saves after its own title update", async ({ page, signIn, apiAs, testWorkspace }, info) => {
  const api = await apiAs("amelia");
  const note = await createNote(api, testWorkspace.boardId, "Safe recovery");
  const url = `/b/${testWorkspace.boardId}?view=notes&noteId=${note.id}`;
  await signIn(page, "amelia", url);
  const editor = page.locator("k-note-editor");
  await editor.locator(".ne-viewer").click();
  await editor.locator(".tiptap").fill("Recovered and saved safely");
  await editor.locator(".ne-title").click();
  await editor.locator(".ne-title-input").fill("Renamed before recovery");
  const renamed = page.waitForResponse((response) => response.url().endsWith(`/api/notes/${note.id}`) && response.request().method() === "PATCH");
  await editor.locator(".ne-title-input").press("Enter");
  expect((await renamed).ok()).toBe(true);
  await expect(editor.locator(".ne-title")).toHaveText("Renamed before recovery");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Board view", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await page.goto(url);
  await expect(editor.locator(".tiptap")).toHaveText("Recovered and saved safely");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor.locator(".ne-viewer")).toContainText("Recovered and saved safely");
  await expect(editor.locator(".ne-banner.is-error")).toHaveCount(0);
  expect(((await (await api.get(`/api/notes/${note.id}`)).json()) as Note).content).toBe("Recovered and saved safely");
  await screenshots(page, info, "successful-recovery");
});
