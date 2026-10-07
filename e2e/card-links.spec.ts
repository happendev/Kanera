import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { webOrigin } from "./support/env";
import { expect, test } from "./support/fixtures";
import { boardIdOf, expectCardTileMounted, openBoard, openCard } from "./support/ui";

// Two-way card links: a link written in one card's description is recorded server-side and listed
// under "Linked items" on *both* cards. Nothing here reloads, so the viewer's assertions measure
// realtime delivery (card:links:changed through the outbox), and the clicks must stay in the SPA.

type CreatedCard = { id: string; key: string; organisationKey: string; title: string };

async function createCardViaApi(page: Page, api: APIRequestContext, title: string): Promise<CreatedCard> {
  const boardId = await boardIdOf(page, "Platform Delivery");
  const board = await api.get(`/api/boards/${boardId}?includeCards=false`);
  const { lists } = (await board.json()) as { lists: { id: string; name: string }[] };
  const backlog = lists.find((list) => list.name === "Backlog")!;
  const created = await api.post(`/api/boards/${boardId}/lists/${backlog.id}/cards`, { data: { title } });
  expect(created.ok(), await created.text()).toBe(true);
  return (await created.json()) as CreatedCard;
}

function linkedItems(detail: Locator): Locator {
  return detail.locator(".linked-notes-list .linked-note-item");
}

/** Saves a description through the editor, as a person would, and waits for the viewer. */
async function writeDescription(detail: Locator, text: string) {
  // The corner, not the centre: a resolved link chip in the body navigates instead of editing.
  await detail.locator(".description-viewer-wrap").click({ position: { x: 4, y: 4 } });
  const editor = detail.locator("k-description-editor");
  await editor.locator(".tiptap").fill(text);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
}

test("a card link shows on both cards live, and linked items open the other card in-app", async ({ page, signIn, pageAs, apiAs, uniqueName }) => {
  await signIn(page, "amelia");
  await openBoard(page, "Platform Delivery");
  const api = await apiAs("amelia");
  const source = await createCardViaApi(page, api, uniqueName("E2E link source"));
  const target = await createCardViaApi(page, api, uniqueName("E2E link target"));
  const targetUrl = `${webOrigin}/o/${source.organisationKey}/c/${target.key}`;

  // A second member already has the target card open and has never been told about the link.
  const viewer = await pageAs("marcus");
  await openBoard(viewer, "Platform Delivery");
  await expectCardTileMounted(viewer, target.title);
  const viewerDetail = await openCard(viewer, target.title);
  await expect(linkedItems(viewerDetail)).toHaveCount(0);

  await expectCardTileMounted(page, source.title);
  const sourceDetail = await openCard(page, source.title);
  // Survives in-app navigation, cleared by a full page load: proves the clicks below stay in the SPA.
  await page.evaluate(() => { (window as { __noReload?: boolean }).__noReload = true; });
  await writeDescription(sourceDetail, `Depends on ${targetUrl}`);

  // The author's own list updates without reopening the card.
  await expect(linkedItems(sourceDetail)).toHaveCount(1);
  await expect(linkedItems(sourceDetail).first()).toContainText(target.title);
  await expect(linkedItems(sourceDetail).first()).toHaveAttribute("href", `/o/${target.organisationKey}/c/${target.key}`);

  // The other end of the link learns about it live.
  await expect(linkedItems(viewerDetail)).toHaveCount(1);
  await expect(linkedItems(viewerDetail).first()).toContainText(source.title);
  await viewer.screenshot({ path: test.info().outputPath("card-links-viewer-backlink.png") });

  // Clicking a linked item swaps the drawer to that card on its canonical key URL.
  await linkedItems(sourceDetail).first().click();
  const targetDetail = page.getByRole("dialog", { name: `Card detail: ${target.title}` });
  await expect(targetDetail).toBeVisible();
  await expect(page).toHaveURL(`${webOrigin}/o/${target.organisationKey}/c/${target.key}`);
  await expect(linkedItems(targetDetail)).toHaveCount(1);
  await expect(linkedItems(targetDetail).first()).toContainText(source.title);

  // And back again from the reverse side.
  await linkedItems(targetDetail).first().click();
  const sourceAgain = page.getByRole("dialog", { name: `Card detail: ${source.title}` });
  await expect(sourceAgain).toBeVisible();
  await expect(page).toHaveURL(`${webOrigin}/o/${source.organisationKey}/c/${source.key}`);

  // The resolved chip inside the description navigates the same way.
  const chip = sourceAgain.locator(".description-viewer-wrap a.internal-link-chip.is-card");
  await expect(chip).toContainText(target.title);
  await page.screenshot({ path: test.info().outputPath("card-links-source.png") });
  await chip.click();
  await expect(page.getByRole("dialog", { name: `Card detail: ${target.title}` })).toBeVisible();
  expect(await page.evaluate(() => (window as { __noReload?: boolean }).__noReload)).toBe(true);

  // Back on the linking card. Renaming either end reaches the other live: the linker's linked item
  // and description chip, and the viewer's linked item. Both renames come from outside the pages.
  await page.getByRole("dialog", { name: `Card detail: ${target.title}` }).locator(".linked-note-item").first().click();
  const sourceDetailAgain = page.getByRole("dialog", { name: `Card detail: ${source.title}` });
  await expect(sourceDetailAgain).toBeVisible();
  const renamedTarget = `${target.title} renamed`;
  const renamedSource = `${source.title} renamed`;
  expect((await api.patch(`/api/cards/${target.id}`, { data: { title: renamedTarget } })).ok()).toBe(true);
  await expect(linkedItems(sourceDetailAgain).first()).toContainText(renamedTarget);
  await expect(sourceDetailAgain.locator(".description-viewer-wrap a.internal-link-chip.is-card")).toContainText(renamedTarget);
  expect((await api.patch(`/api/cards/${source.id}`, { data: { title: renamedSource } })).ok()).toBe(true);
  const viewerOpen = viewer.getByRole("dialog", { name: /^Card detail: / });
  await expect(linkedItems(viewerOpen).first()).toContainText(renamedSource);

  // Removing the link clears it from the other card live too.
  const renamedSourceDetail = page.getByRole("dialog", { name: `Card detail: ${renamedSource}` });
  await writeDescription(renamedSourceDetail, "No dependencies any more");
  await expect(linkedItems(viewerOpen)).toHaveCount(0);
  await expect(linkedItems(renamedSourceDetail)).toHaveCount(0);
});

test("notes and cards link both ways live: backlinks, linked items, renames and in-app clicks", async ({ page, signIn, pageAs, apiAs, uniqueName }) => {
  await signIn(page, "amelia");
  await openBoard(page, "Platform Delivery");
  const api = await apiAs("amelia");
  const boardId = await boardIdOf(page, "Platform Delivery");
  const card = await createCardViaApi(page, api, uniqueName("E2E note-linked card"));
  const noteCreated = await api.post(`/api/boards/${boardId}/notes`, { data: { scope: "team", title: uniqueName("E2E linked note") } });
  expect(noteCreated.ok(), await noteCreated.text()).toBe(true);
  const note = (await noteCreated.json()) as { id: string; title: string };
  const noteUrl = `${webOrigin}/b/${boardId}?view=notes&noteId=${note.id}`;

  // One page shows the note, another member has the card open; neither reloads from here on.
  await page.goto(`/b/${boardId}?view=notes&noteId=${note.id}`);
  const noteEditor = page.locator("k-note-editor");
  await expect(noteEditor).toContainText(note.title);
  await expect(noteEditor.locator(".ne-backlink")).toHaveCount(0);
  await page.evaluate(() => { (window as { __noReload?: boolean }).__noReload = true; });

  const viewer = await pageAs("marcus");
  await openBoard(viewer, "Platform Delivery");
  await expectCardTileMounted(viewer, card.title);
  const cardDetail = await openCard(viewer, card.title);
  await expect(linkedItems(cardDetail)).toHaveCount(0);

  // card → note: the note's backlinks gain the card, and the card lists the note.
  expect((await api.patch(`/api/cards/${card.id}`, { data: { description: `Spec: ${noteUrl}` } })).ok()).toBe(true);
  await expect(noteEditor.locator(".ne-backlink")).toHaveCount(1);
  await expect(noteEditor.locator(".ne-backlink").first()).toContainText(card.title);
  await expect(linkedItems(cardDetail)).toHaveCount(1);
  await expect(linkedItems(cardDetail).first()).toContainText(note.title);

  // Renaming the note reaches the card's linked item and its description chip.
  const renamedNote = `${note.title} renamed`;
  expect((await api.patch(`/api/notes/${note.id}`, { data: { title: renamedNote } })).ok()).toBe(true);
  await expect(linkedItems(cardDetail).first()).toContainText(renamedNote);
  await expect(cardDetail.locator(".description-viewer-wrap a.internal-link-chip.is-note")).toContainText(renamedNote);

  // Renaming the card reaches the note's backlinks.
  const renamedCard = `${card.title} renamed`;
  expect((await api.patch(`/api/cards/${card.id}`, { data: { title: renamedCard } })).ok()).toBe(true);
  await expect(noteEditor.locator(".ne-backlink").first()).toContainText(renamedCard);
  await page.screenshot({ path: test.info().outputPath("note-backlinks-renamed.png") });

  // A backlink opens the card in-app on its canonical key URL.
  await noteEditor.locator(".ne-backlink").first().click();
  await expect(page.getByRole("dialog", { name: `Card detail: ${renamedCard}` })).toBeVisible();
  await expect(page).toHaveURL(`${webOrigin}/o/${card.organisationKey}/c/${card.key}`);
  expect(await page.evaluate(() => (window as { __noReload?: boolean }).__noReload)).toBe(true);

  // Unlinking from the card side clears the note's backlink for a viewer who has the note open.
  const noteViewer = await pageAs("marcus");
  await noteViewer.goto(`/b/${boardId}?view=notes&noteId=${note.id}`);
  await expect(noteViewer.locator("k-note-editor .ne-backlink")).toHaveCount(1);
  expect((await api.patch(`/api/cards/${card.id}`, { data: { description: "No spec" } })).ok()).toBe(true);
  await expect(noteViewer.locator("k-note-editor .ne-backlink")).toHaveCount(0);
  await expect(linkedItems(cardDetail)).toHaveCount(0);
});
