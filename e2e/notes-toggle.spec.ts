import type { APIRequestContext, Page } from "@playwright/test";
import { webOrigin } from "./support/env";
import { expect, test } from "./support/fixtures";
import { expectBoardLoaded, openCard } from "./support/ui";

type Note = { id: string; title: string };

async function createNote(api: APIRequestContext, path: string, title: string): Promise<Note> {
  const response = await api.post(path, { data: { scope: "team", title } });
  expect(response.status(), await response.text()).toBe(201);
  return response.json() as Promise<Note>;
}

/** Ticks the settings checkbox and waits for the PATCH, so later assertions never race the save. */
async function setNotesEnabled(page: Page, workspaceId: string, enabled: boolean) {
  const toggle = page.getByRole("checkbox", { name: "Enable notes" });
  await expect(toggle).toBeChecked({ checked: !enabled });
  const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/workspaces/${workspaceId}`));
  await toggle.click();
  expect((await saved).ok()).toBe(true);
  await expect(toggle).toBeChecked({ checked: enabled });
}

test("turning workspace notes off hides every notes surface live, closes the API, and keeps the notes", async ({ page, signIn, pageAs, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const workspaceName = uniqueName("E2E notes toggle");
  const boardName = uniqueName("E2E notes board");
  const created = await api.post("/api/workspaces", { data: { name: workspaceName, initialBoard: { name: boardName }, listNames: ["To do", "Done"], customFields: [] } });
  expect(created.ok(), await created.text()).toBe(true);
  const workspace = await created.json() as { id: string; initialBoard: { id: string } };
  const boardId = workspace.initialBoard.id;
  const workspaceNote = await createNote(api, `/api/workspaces/${workspace.id}/notes`, uniqueName("Quokkaledger workspace"));
  const boardNote = await createNote(api, `/api/boards/${boardId}/notes`, uniqueName("Quokkaledger board"));
  const board = await (await api.get(`/api/boards/${boardId}?includeCards=false`)).json() as { lists: { id: string }[] };
  const cardTitle = uniqueName("E2E card linking a note");
  const card = await api.post(`/api/boards/${boardId}/lists/${board.lists[0]!.id}/cards`, { data: { title: cardTitle } });
  expect(card.ok(), await card.text()).toBe(true);
  const cardId = (await card.json() as { id: string }).id;
  const noteUrl = `${webOrigin}/b/${boardId}?view=notes&noteId=${boardNote.id}`;
  expect((await api.patch(`/api/cards/${cardId}`, { data: { description: `Spec: ${noteUrl}` } })).ok()).toBe(true);
  const searchNoteIds = async () => {
    const response = await api.get(`/api/search?q=Quokkaledger&limit=20`);
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { notes: { id: string }[] }).notes.map((note) => note.id);
  };

  // A second session sits on the workspace Notes page while an admin flips the switch elsewhere.
  const viewer = await pageAs("amelia");
  await viewer.goto(`/w/${workspace.id}/notes?noteId=${workspaceNote.id}`);
  await expect(viewer.locator("k-notes-view").getByText(workspaceNote.title).first()).toBeVisible();
  const viewerNotesLink = viewer.locator(`a.board-link[href="/w/${workspace.id}/notes"]`);
  await expect(viewerNotesLink).toBeVisible();

  await signIn(page, "amelia");
  await page.goto(`/b/${boardId}`);
  await expectBoardLoaded(page, boardName);
  await expect(page.getByRole("button", { name: "Board Notes" })).toBeVisible();
  const linkedNotes = (await openCard(page, cardTitle)).locator(".linked-notes-list .linked-note-item");
  await expect(linkedNotes).toHaveCount(1);
  expect(await searchNoteIds()).toEqual(expect.arrayContaining([workspaceNote.id, boardNote.id]));

  await page.goto(`/w/${workspace.id}/settings/general`);
  await expect(page.getByRole("heading", { name: `${workspaceName} Settings`, exact: true })).toBeVisible();
  await setNotesEnabled(page, workspace.id, false);
  await page.locator(".board-settings-section").filter({ hasText: "Enable notes" }).screenshot({ path: testInfo.outputPath("settings-notes-toggle.png") });

  // Live: the open Notes page swaps to the empty state and the sidebar link goes, with no reload.
  await expect(viewer.getByText("Notes are turned off")).toBeVisible();
  await expect(viewer.locator("k-notes-view")).toHaveCount(0);
  await expect(viewerNotesLink).toHaveCount(0);
  await viewer.screenshot({ path: testInfo.outputPath("workspace-notes-disabled.png") });

  // The API is closed for both workspace and board notes, and search no longer returns them.
  const blocked = await api.get(`/api/notes/${boardNote.id}`);
  expect(blocked.status()).toBe(403);
  expect(await blocked.text()).toContain("NOTES_DISABLED");
  expect((await api.get(`/api/workspaces/${workspace.id}/notes?scope=team`)).status()).toBe(403);
  expect((await api.post(`/api/boards/${boardId}/notes`, { data: { scope: "team", title: "blocked" } })).status()).toBe(403);
  expect(await searchNoteIds()).not.toEqual(expect.arrayContaining([workspaceNote.id]));
  expect(await searchNoteIds()).not.toEqual(expect.arrayContaining([boardNote.id]));

  // A `?view=notes` link lands on the kanban, the view switch drops Notes, and the card's linked
  // note disappears rather than pointing at a page that would refuse to open.
  await page.goto(`/b/${boardId}?view=notes&noteId=${boardNote.id}`);
  await expectBoardLoaded(page, boardName);
  await expect(page.getByRole("button", { name: "Board Notes" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Board view" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("k-notes-view")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("board-notes-disabled.png") });
  await expect((await openCard(page, cardTitle)).locator(".linked-notes-list .linked-note-item")).toHaveCount(0);

  // Re-enabling restores everything untouched: the notes were hidden, never deleted.
  await page.goto(`/w/${workspace.id}/settings/general`);
  await setNotesEnabled(page, workspace.id, true);
  await expect(viewer.locator("k-notes-view").getByText(workspaceNote.title).first()).toBeVisible();
  await expect(viewerNotesLink).toBeVisible();
  expect((await api.get(`/api/notes/${boardNote.id}`)).status()).toBe(200);
  expect(await searchNoteIds()).toEqual(expect.arrayContaining([workspaceNote.id, boardNote.id]));
  await page.goto(`/b/${boardId}`);
  await expectBoardLoaded(page, boardName);
  await expect(page.getByRole("button", { name: "Board Notes" })).toBeVisible();
  await expect((await openCard(page, cardTitle)).locator(".linked-notes-list .linked-note-item")).toHaveCount(1);
});

test("a standalone board turns its notes off from its own settings", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const boardName = uniqueName("E2E standalone notes");
  const created = await api.post("/api/workspaces", { data: { name: boardName, kind: "board", initialBoard: { name: boardName }, listNames: ["To do", "Done"], customFields: [] } });
  expect(created.ok(), await created.text()).toBe(true);
  const workspace = await created.json() as { id: string; initialBoard: { id: string } };
  const boardId = workspace.initialBoard.id;
  const note = await createNote(api, `/api/boards/${boardId}/notes`, uniqueName("Standalone note"));

  await signIn(page, "amelia");
  await page.goto(`/b/${boardId}?view=notes&noteId=${note.id}`);
  await expectBoardLoaded(page, boardName);
  await expect(page.locator("k-notes-view").getByText(note.title).first()).toBeVisible();

  await page.goto(`/b/${boardId}/settings/general`);
  await expect(page.getByText("Show Notes on this board.")).toBeVisible();
  await setNotesEnabled(page, workspace.id, false);
  expect((await api.get(`/api/boards/${boardId}/notes?scope=team`)).status()).toBe(403);

  await page.goto(`/b/${boardId}?view=notes&noteId=${note.id}`);
  await expectBoardLoaded(page, boardName);
  await expect(page.getByRole("button", { name: "Board Notes" })).toHaveCount(0);
  await expect(page.locator("k-notes-view")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("standalone-notes-disabled.png") });
});
