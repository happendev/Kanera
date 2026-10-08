import { readFileSync } from "node:fs";
import path from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { expectBoardLoaded, openCard } from "./support/ui";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function setup(api: APIRequestContext, name: string) {
  const response = await api.post("/api/workspaces", {
    data: { name, initialBoard: { name }, listNames: ["To do", "Done"], customFields: [] },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const workspace = await response.json() as { id: string; initialBoard: { id: string } };
  const boardId = workspace.initialBoard.id;
  const board = await (await api.get(`/api/boards/${boardId}?includeCards=false`)).json() as { lists: { id: string }[] };
  const created = await api.post(`/api/boards/${boardId}/lists/${board.lists[0]!.id}/cards`, { data: { title: name } });
  expect(created.ok(), await created.text()).toBe(true);
  const card = await created.json() as { id: string };
  return { workspaceId: workspace.id, boardId, cardId: card.id, name };
}

async function openFixture(page: Page, fixture: Awaited<ReturnType<typeof setup>>) {
  await page.goto(`/b/${fixture.boardId}`);
  await expectBoardLoaded(page, fixture.name);
  return openCard(page, fixture.name);
}

test("description save freezes the submitted document until its response settles", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const fixture = await setup(api, uniqueName("Editor snapshot"));
  await signIn(page, "amelia");
  const detail = await openFixture(page, fixture);
  await detail.locator(".description-viewer-wrap").click();
  const editor = detail.locator("k-description-editor");
  await editor.locator(".tiptap").fill("The submitted description");
  const pending = gate();
  let started = false;
  await page.route(`**/api/cards/${fixture.cardId}`, async (route) => {
    if (route.request().method() === "PATCH") {
      started = true;
      await pending.promise;
    }
    await route.continue();
  });
  try {
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => started).toBe(true);
    await expect(editor.locator(".tiptap")).toHaveAttribute("contenteditable", "false");
    await expect(editor.locator(".de-shell")).toHaveAttribute("inert", "");
    await page.screenshot({ path: testInfo.outputPath("description-save-in-flight.png") });
  } finally {
    pending.release();
  }
  await expect(editor).toHaveCount(0);
  await expect(detail.locator(".description-viewer-wrap")).toContainText("The submitted description");
});

test("a rejected description save keeps the draft editable and can be retried", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const fixture = await setup(api, uniqueName("Description retry"));
  await signIn(page, "amelia");
  const detail = await openFixture(page, fixture);
  await detail.locator(".description-viewer-wrap").click();
  const editor = detail.locator("k-description-editor");
  await editor.locator(".tiptap").fill("Keep this draft after rejection");
  let reject = true;
  await page.route(`**/api/cards/${fixture.cardId}`, async (route) => {
    if (route.request().method() === "PATCH" && reject) {
      reject = false;
      await route.fulfill({ status: 422, json: { code: "VALIDATION_ERROR", message: "Retry this edit" } });
    } else await route.continue();
  });
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await expect(editor.locator(".tiptap")).toHaveAttribute("contenteditable", "true");
  await expect(editor.locator(".tiptap")).toContainText("Keep this draft after rejection");
  await page.screenshot({ path: testInfo.outputPath("description-retry-ready.png") });
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(detail.locator(".description-viewer-wrap")).toContainText("Keep this draft after rejection");
});

test("detail multi-select and user selections compose while their first writes are pending", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const fixture = await setup(api, uniqueName("Pending field choices"));
  const createField = async (data: object) => {
    const response = await api.post(`/api/workspaces/${fixture.workspaceId}/custom-fields`, { data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json() as Promise<{ id: string; options: { id: string; label: string }[] }>;
  };
  const select = await createField({ name: "Concurrent options", type: "select", allowMultiple: true, options: [{ label: "First choice" }, { label: "Second choice" }] });
  const user = await createField({ name: "Concurrent people", type: "user", allowMultiple: true });
  await signIn(page, "amelia");
  const detail = await openFixture(page, fixture);
  const writes: { valueOptionIds?: string[] }[] = [];
  const pending = gate();
  await page.route(`**/api/cards/${fixture.cardId}/custom-fields/${select.id}`, async (route) => {
    if (route.request().method() === "PUT") {
      writes.push(route.request().postDataJSON() as { valueOptionIds?: string[] });
      if (writes.length === 1) await pending.promise;
    }
    await route.continue();
  });
  const selectRow = detail.locator(".cf-row").filter({ hasText: "Concurrent options" });
  try {
    await selectRow.locator(".cf-trigger").click();
    await page.locator("k-select-picker").getByRole("button", { name: "First choice", exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    await page.locator("k-select-picker").getByRole("button", { name: "Second choice", exact: true }).click();
    await expect(page.locator("k-select-picker .lp-row.is-selected")).toHaveCount(2);
  } finally {
    pending.release();
  }
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]?.valueOptionIds).toEqual(select.options.map((option) => option.id));
  await page.keyboard.press("Escape");
  await expect(selectRow.locator(".cf-chip")).toHaveCount(2);

  const userPending = gate();
  let userStarted = false;
  await page.route(`**/api/cards/${fixture.cardId}/custom-fields/${user.id}`, async (route) => {
    if (route.request().method() === "PUT" && !userStarted) {
      userStarted = true;
      await userPending.promise;
    }
    await route.continue();
  });
  const userRow = detail.locator(".cf-row").filter({ hasText: "Concurrent people" });
  const userCleared = page.waitForResponse((response) => response.url().endsWith(`/api/cards/${fixture.cardId}/custom-fields/${user.id}`) && response.request().method() === "DELETE");
  try {
    await userRow.locator(".cf-trigger").click();
    await page.locator("k-member-picker").getByText("Me", { exact: true }).click();
    await expect.poll(() => userStarted).toBe(true);
    await page.locator("k-member-picker").getByText("Me", { exact: true }).click();
    await expect(page.locator("k-member-picker .mp-row.is-selected")).toHaveCount(0);
  } finally {
    userPending.release();
  }
  expect((await userCleared).ok()).toBe(true);
  await expect.poll(async () => {
    const response = await api.get(`/api/cards/${fixture.cardId}/detail`);
    const detailData = await response.json() as { customFieldValues: { fieldId: string }[] };
    return detailData.customFieldValues.some((value) => value.fieldId === user.id);
  }).toBe(false);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: testInfo.outputPath("composed-field-selections.png") });
});

test("a text field can return to its earlier value after a remote edit", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const fixture = await setup(api, uniqueName("Field memo reset"));
  const created = await api.post(`/api/workspaces/${fixture.workspaceId}/custom-fields`, { data: { name: "Memo regression", type: "text" } });
  expect(created.ok(), await created.text()).toBe(true);
  const field = await created.json() as { id: string };
  await signIn(page, "amelia");
  const detail = await openFixture(page, fixture);
  const input = detail.locator(".cf-row").filter({ hasText: "Memo regression" }).locator("input");
  const endpoint = `/api/cards/${fixture.cardId}/custom-fields/${field.id}`;
  const first = page.waitForResponse((response) => response.url().endsWith(endpoint) && response.request().method() === "PUT");
  await input.fill("Original local value");
  await input.press("Enter");
  expect((await first).ok()).toBe(true);
  expect((await api.put(endpoint, { data: { valueText: "Remote replacement" } })).ok()).toBe(true);
  await expect(input).toHaveValue("Remote replacement");
  await input.fill("Original local value");
  await input.press("Enter");
  await expect.poll(async () => {
    const body = await (await api.get(`/api/cards/${fixture.cardId}/detail`)).json() as { customFieldValues: { fieldId: string; valueText: string }[] };
    return body.customFieldValues.find((value) => value.fieldId === field.id)?.valueText;
  }).toBe("Original local value");
  await page.screenshot({ path: testInfo.outputPath("restored-custom-field-value.png") });
});

test("comment submission waits for every concurrent dropped upload", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const fixture = await setup(api, uniqueName("Concurrent editor uploads"));
  await signIn(page, "amelia");
  const detail = await openFixture(page, fixture);
  await detail.getByRole("button", { name: "Write a comment..." }).click();
  const editor = detail.locator(".comment-form k-description-editor");
  const slow = gate();
  let slowStarted = false;
  await page.route(`**/api/cards/${fixture.cardId}/attachments?source=comment`, async (route) => {
    if (route.request().postDataBuffer()?.includes(Buffer.from("slow-image.png"))) {
      slowStarted = true;
      await slow.promise;
    }
    await route.continue();
  });
  const image = readFileSync(path.join(__dirname, "..", "dev-db-seed-content/attachments/images/access-review-symbol.png")).toString("base64");
  try {
    await editor.locator(".tiptap").evaluate((element, base64) => {
      const transfer = new DataTransfer();
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      for (const name of ["fast-image.png", "slow-image.png"]) transfer.items.add(new File([bytes], name, { type: "image/png" }));
      element.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, image);
    await expect.poll(() => slowStarted).toBe(true);
    await expect(editor.locator(".tiptap img")).toHaveCount(1);
    await expect(editor.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("second-upload-still-pending.png") });
  } finally {
    slow.release();
  }
  await expect(editor.locator(".tiptap img")).toHaveCount(2);
  await expect(editor.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await editor.getByRole("button", { name: "Send", exact: true }).click();
  await expect(detail.locator(".comment k-description-viewer img")).toHaveCount(2);
});

test("late note lock responses neither open another note's editor nor retain abandoned locks", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const fixture = await setup(api, uniqueName("Abandoned note lock"));
  const notes = [] as { id: string; title: string }[];
  for (const title of ["First note", "Second note"]) {
    const response = await api.post(`/api/boards/${fixture.boardId}/notes`, { data: { scope: "team", title } });
    expect(response.ok(), await response.text()).toBe(true);
    const note = await response.json() as { id: string; title: string };
    expect((await api.patch(`/api/notes/${note.id}`, { data: { content: `${title} body` } })).ok()).toBe(true);
    notes.push(note);
  }
  await signIn(page, "amelia");
  await page.goto(`/b/${fixture.boardId}?view=notes&noteId=${notes[0]!.id}`);
  await expect(page.locator("k-note-editor .ne-title")).toHaveText("First note");
  let pending = gate();
  let locked = false;
  let released = false;
  page.on("response", (response) => {
    if (response.url().endsWith(`/api/notes/${notes[0]!.id}/unlock`) && response.ok()) released = true;
  });
  await page.route(`**/api/notes/${notes[0]!.id}/lock`, async (route) => {
    const response = await route.fetch();
    locked = true;
    await pending.promise;
    await route.fulfill({ response });
  });
  try {
    await page.locator("k-note-editor .ne-viewer").click();
    await expect.poll(() => locked).toBe(true);
    await page.locator("k-notes-tree").getByText("Second note", { exact: true }).click();
    await expect(page.locator("k-note-editor .ne-title")).toHaveText("Second note");
  } finally {
    pending.release();
  }
  await expect.poll(() => released).toBe(true);
  await expect(page.locator("k-note-editor k-description-editor")).toHaveCount(0);
  await expect(page.locator("k-note-editor .ne-viewer")).toContainText("Second note body");
  await expect.poll(async () => {
    const note = await (await api.get(`/api/notes/${notes[0]!.id}`)).json() as { editingUserId: string | null };
    return note.editingUserId;
  }).toBeNull();
  await page.screenshot({ path: testInfo.outputPath("late-lock-released-current-note-intact.png") });

  // Repeat with a real component teardown, where the old acquisition used to create a heartbeat
  // after ngOnDestroy had already run and keep the abandoned note locked indefinitely.
  pending = gate();
  locked = false;
  released = false;
  await page.locator("k-notes-tree").getByText("First note", { exact: true }).click();
  await expect(page.locator("k-note-editor .ne-title")).toHaveText("First note");
  try {
    await page.locator("k-note-editor .ne-viewer").click();
    await expect.poll(() => locked).toBe(true);
    await page.getByRole("button", { name: "Board view", exact: true }).click();
    await expect(page.locator("k-note-editor")).toHaveCount(0);
  } finally {
    pending.release();
  }
  await expect.poll(() => released).toBe(true);
  await expect.poll(async () => {
    const note = await (await api.get(`/api/notes/${notes[0]!.id}`)).json() as { editingUserId: string | null };
    return note.editingUserId;
  }).toBeNull();
  await page.screenshot({ path: testInfo.outputPath("destroyed-editor-late-lock-released.png") });
});

test("a saved note response cannot close the next note's unsaved editor", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const fixture = await setup(api, uniqueName("Note save response scope"));
  const notes = [] as { id: string; title: string }[];
  for (const title of ["Saving note", "Next note"]) {
    const response = await api.post(`/api/boards/${fixture.boardId}/notes`, { data: { scope: "team", title } });
    expect(response.ok(), await response.text()).toBe(true);
    notes.push(await response.json() as { id: string; title: string });
  }
  await signIn(page, "amelia");
  await page.goto(`/b/${fixture.boardId}?view=notes&noteId=${notes[0]!.id}`);
  await expect(page.locator("k-note-editor .ne-title")).toHaveText("Saving note");
  await page.locator("k-note-editor .ne-viewer").click();
  const editor = page.locator("k-note-editor k-description-editor");
  await editor.locator(".tiptap").fill("Saved on the first note");
  const pending = gate();
  let started = false;
  await page.route(`**/api/notes/${notes[0]!.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    started = true;
    await pending.promise;
    await route.fulfill({ response });
  });
  const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/notes/${notes[0]!.id}`));
  try {
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => started).toBe(true);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.locator("k-notes-tree").getByText("Next note", { exact: true }).click();
    await expect(page.locator("k-note-editor .ne-title")).toHaveText("Next note");
    await page.locator("k-note-editor .ne-viewer").click();
    await editor.locator(".tiptap").fill("Keep the second note's draft");
  } finally {
    pending.release();
  }
  expect((await saved).ok()).toBe(true);
  await editor.locator(".tiptap").fill("Keep the second note's draft after acknowledgement");
  await page.screenshot({ path: testInfo.outputPath("next-note-draft-survives-old-save.png") });
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const persisted = await (await api.get(`/api/notes/${notes[1]!.id}`)).json() as { content: string };
  expect(persisted.content).toBe("Keep the second note's draft after acknowledgement");
});
