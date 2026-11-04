import type { APIRequestContext, Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { openCard } from "./support/ui";
import { SocketLink } from "./support/socket";

type Surface = "note" | "description" | "comment-new" | "comment-edit";
const surfaces: Surface[] = ["note", "description", "comment-new", "comment-edit"];
const original = "Original published text";

async function setup(api: APIRequestContext, surface: Surface, boardId: string, listId: string) {
  const title = `Recovery audit ${surface}`;
  if (surface === "note") {
    const created = await api.post(`/api/boards/${boardId}/notes`, { data: { scope: "team", title } });
    expect(created.ok()).toBe(true);
    const note = await created.json() as { id: string };
    expect((await api.patch(`/api/notes/${note.id}`, { data: { content: original } })).ok()).toBe(true);
    return { surface, title, boardId, id: note.id, url: `/b/${boardId}?view=notes&noteId=${note.id}`, endpoint: `/api/notes/${note.id}`, method: "PATCH", read: `/api/boards/${boardId}/notes?scope=team` };
  }
  const created = await api.post(`/api/boards/${boardId}/lists/${listId}/cards`, { data: { title, description: original } });
  expect(created.ok()).toBe(true);
  const card = await created.json() as { id: string };
  let commentId: string | undefined;
  if (surface === "comment-edit") {
    const comment = await api.post(`/api/cards/${card.id}/comments`, { data: { body: original } });
    expect(comment.ok()).toBe(true);
    commentId = (await comment.json() as { id: string }).id;
  }
  return {
    surface, title, boardId, id: card.id, commentId, url: `/b/${boardId}/c/${card.id}`,
    endpoint: surface === "description" ? `/api/cards/${card.id}` : commentId ? `/api/comments/${commentId}` : `/api/cards/${card.id}/comments`,
    method: surface === "comment-new" ? "POST" : "PATCH",
    read: `/api/cards/${card.id}/${surface === "description" ? "detail" : "feed"}`,
  };
}
type Subject = Awaited<ReturnType<typeof setup>>;

function owner(page: Page, subject: Subject): Locator {
  if (subject.surface === "note") return page.locator("k-note-editor");
  if (subject.surface === "description") return page.locator("k-card-detail-description");
  if (subject.surface === "comment-new") return page.locator(".comment-form");
  return page.locator(".comment").first();
}

async function startEditing(page: Page, subject: Subject) {
  const host = owner(page, subject);
  await expect(host).toBeVisible();
  const editor = host.locator(".tiptap");
  if (!await editor.isVisible()) {
    if (subject.surface === "note") await host.locator(".ne-viewer").click();
    else if (subject.surface === "description") await host.locator(".description-viewer-wrap").click();
    else if (await host.locator(".draft-preview").isVisible()) await host.locator(".draft-preview").click();
    else await host.getByRole("button", { name: subject.surface === "comment-new" ? "Write a comment..." : "Edit", exact: true }).click();
  }
  await expect(editor).toBeEditable();
  return editor;
}

async function submit(page: Page, subject: Subject) {
  await owner(page, subject).getByRole("button", { name: subject.surface === "comment-new" ? "Send" : "Save", exact: true }).click();
}

async function drafts(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("kanera:editor-drafts") ?? "{}") as unknown);
}

async function published(api: APIRequestContext, subject: Subject) {
  if (subject.surface === "note") return (await (await api.get(subject.endpoint)).json() as { content: string }).content;
  if (subject.surface === "description") return (await (await api.get(`/api/cards/${subject.id}/detail`)).json() as { card: { description: string } }).card.description;
  const response = await api.get(`/api/cards/${subject.id}/comments`);
  expect(response.ok()).toBe(true);
  return JSON.stringify(await response.json());
}

async function evidence(page: Page, info: TestInfo, name: string, value: unknown, comments = false) {
  await info.attach(`${name}.json`, { body: JSON.stringify(value, null, 2), contentType: "application/json" });
  await page.screenshot({ path: info.outputPath(`${name}-desktop.png`), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  if (comments) await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.screenshot({ path: info.outputPath(`${name}-phone.png`), animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 900 });
}

for (const surface of surfaces) {
  for (const boundary of ["close", "reconnect"] as const) {
    test(`${surface}: an older save response cannot erase newer work after ${boundary}`, async ({ page, signIn, apiAs, testWorkspace }, info) => {
      const api = await apiAs("amelia");
      const subject = await setup(api, surface, testWorkspace.boardId, testWorkspace.lists.get("Backlog")!);
      const link = boundary === "reconnect" ? await SocketLink.install(page.context()) : null;
      await signIn(page, "amelia", subject.url);
      await (await startEditing(page, subject)).fill("First submitted text");
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      let held = false;
      await page.route(`**${subject.endpoint}`, async (route) => {
        if (route.request().method() !== subject.method || held) return route.continue();
        const response = await route.fetch();
        held = true;
        await pending;
        await route.fulfill({ response });
      });
      try {
        await submit(page, subject);
        await expect.poll(() => held).toBe(true);
        if (link) {
          await link.cut();
          await expect.poll(() => link.refusedAttempts).toBeGreaterThan(0);
          await expect(owner(page, subject).locator(".tiptap")).toHaveCount(0);
          const refreshed = page.waitForResponse((response) => response.request().method() === "GET" && response.url().includes(subject.read), { timeout: 40_000 });
          link.restore();
          await refreshed;
        } else if (surface === "note") {
          page.once("dialog", (dialog) => void dialog.accept());
          await page.getByRole("button", { name: "Board view", exact: true }).click();
          await expect(page.locator("k-note-editor")).toHaveCount(0);
          await page.getByRole("button", { name: "Board Notes", exact: true }).click();
          await page.locator("k-notes-tree").getByText(subject.title, { exact: true }).click();
        } else {
          page.once("dialog", (dialog) => void dialog.accept());
          await page.locator("k-card-detail").getByRole("button", { name: "Close", exact: true }).click();
          await expect(page.locator("k-card-detail")).toHaveCount(0);
          await openCard(page, subject.title);
        }
        const editor = await startEditing(page, subject);
        await editor.fill("New work after reopening the editor");
        const before = await drafts(page);
        const ack = page.waitForResponse((response) => response.request().method() === subject.method && response.url().endsWith(subject.endpoint));
        release();
        expect((await ack).ok()).toBe(true);
        // Observe after the acknowledgement's microtasks and Angular rendering have settled.
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const after = await drafts(page);
        await evidence(page, info, "late-ack", { before, after, editor: await editor.count() ? await editor.innerText() : null, published: await published(api, subject) }, surface.startsWith("comment"));
        // Preserving storage alone is insufficient: the active editor must also retain the text.
        await expect(editor).toHaveText("New work after reopening the editor");
        page.once("dialog", (dialog) => void dialog.accept());
        await page.reload();
        await expect(owner(page, subject)).toBeVisible();
        await evidence(page, info, "after-reload", { text: await owner(page, subject).innerText(), drafts: await drafts(page) }, surface.startsWith("comment"));
        expect(JSON.stringify(after)).toContain("New work after reopening the editor");
        await expect(owner(page, subject)).toContainText("New work after reopening the editor");
        // Recovery must remain saveable, including Notes' optimistic revision check.
        await startEditing(page, subject);
        await submit(page, subject);
        await expect.poll(() => published(api, subject)).toContain("New work after reopening the editor");
      } finally {
        release();
        link?.restore();
      }
    });
  }

  test(`${surface}: a draft survives offline remount, failed refresh and rejected save`, async ({ page, signIn, apiAs, testWorkspace }, info) => {
    const api = await apiAs("amelia");
    const subject = await setup(api, surface, testWorkspace.boardId, testWorkspace.lists.get("Backlog")!);
    await signIn(page, "amelia", subject.url);
    const text = `Unsaved ${surface} work before going away`;
    await (await startEditing(page, subject)).fill(text);
    let failedRead = false;
    await page.route(`**${subject.read}*`, async (route) => {
      if (failedRead || route.request().method() !== "GET") return route.continue();
      failedRead = true;
      await route.abort("connectionreset");
    });
    await page.context().setOffline(true);
    await expect(owner(page, subject).locator(".tiptap")).toHaveCount(0);
    await expect.poll(async () => JSON.stringify(await drafts(page))).toContain(text);
    await page.context().setOffline(false);
    // Notes refreshes on socket connect/foreground. Chromium may retain its socket through
    // setOffline(), so explicitly exercise returning to the tab instead of assuming a reconnect.
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => failedRead).toBe(true);
    await expect(owner(page, subject)).toContainText(text);
    const editor = await startEditing(page, subject);
    await expect(editor).toHaveText(text);
    let rejected = false;
    await page.route(`**${subject.endpoint}`, async (route) => {
      if (route.request().method() !== subject.method || rejected) return route.continue();
      rejected = true;
      await route.fulfill({ status: 422, json: { code: "VALIDATION_ERROR", message: "Test rejection" } });
    });
    await submit(page, subject);
    await expect.poll(() => rejected).toBe(true);
    await expect(editor).toBeEditable();
    await expect(editor).toHaveText(text);
    await expect.poll(async () => JSON.stringify(await drafts(page))).toContain(text);
    await evidence(page, info, "failed-read-and-save", { text: await editor.innerText(), drafts: await drafts(page), published: await published(api, subject) }, surface.startsWith("comment"));
    await submit(page, subject);
    await expect.poll(() => published(api, subject)).toContain(text);
  });
}
