import type { APIRequestContext, Page } from "@playwright/test";
import { users } from "./support/env";
import { expect, test } from "./support/scenario";
import { boardHref, expectBoardDenied, openBoard, workspaceSettingsHref } from "./support/ui";

// Each test grants Maya (a user in another organisation) access to a board it creates, so revoking
// access in one test cannot change what another test sees.
async function boardSharedWithMaya(owner: Page, api: APIRequestContext, boardName: string) {
  const workspaceId = (await workspaceSettingsHref(owner, "E2E primary board")).split("/")[2]!;
  const created = await api.post(`/api/workspaces/${workspaceId}/boards`, { data: { name: boardName } });
  expect(created.ok(), await created.text()).toBe(true);
  const board = (await created.json()) as { id: string };
  const granted = await api.post(`/api/workspaces/${workspaceId}/guests/invitations`, {
    data: { boardId: board.id, email: users.maya.email, role: "editor" },
  });
  expect(granted.ok(), await granted.text()).toBe(true);
  // An existing cross-organisation user is added straight to board_members; no invite link.
  expect(((await granted.json()) as { status: string }).status).toBe("added");
  return `/b/${board.id}`;
}

test("a cross-organisation guest sees only the invited board", async ({ page, signIn, pageAs, apiAs, uniqueName }) => {
  const boardName = uniqueName("E2E guest board");
  await signIn(page, "amelia");
  await boardSharedWithMaya(page, await apiAs("amelia"), boardName);
  const platformHref = await boardHref(page, "E2E primary board");

  const guest = await pageAs("maya");
  await expect(guest.locator("a.board-link").filter({ hasText: "E2E primary board" })).toHaveCount(0);
  await openBoard(guest, boardName);

  await guest.goto(platformHref);
  await expectBoardDenied(guest, "E2E primary board");
});

test("removing a live board guest ejects their open board and blocks cached reopening", async ({ page, signIn, pageAs, apiAs, uniqueName }) => {
  const boardName = uniqueName("E2E revoked board");
  await signIn(page, "amelia");
  const href = await boardSharedWithMaya(page, await apiAs("amelia"), boardName);

  const guest = await pageAs("maya");
  await openBoard(guest, boardName);

  await openBoard(page, boardName);
  await page.locator(".board-members-trigger").click();
  await expect(page.locator(".bmp-guests")).toContainText(users.maya.name);
  // Each person has a visible remove button beside their role.
  await page.getByRole("button", { name: `Remove ${users.maya.name}` }).click();

  // The DELETE waits out the 10s undo toast (UNDO_WINDOW_MS); the guest is ejected by the
  // committed server event, not by anything the owner's client does locally.
  await expectBoardDenied(guest, boardName, 25_000);
  await expect(guest.locator(`a.board-link[href="${href}"]`)).toHaveCount(0);
  await guest.goto(href);
  await expectBoardDenied(guest, boardName);
  await guest.reload();
  await expect(guest.locator(`a.board-link[href="${href}"]`)).toHaveCount(0);
});

test("board members menu invites an outsider by email, withdraws it, and adds an existing guest by name", async ({ page, signIn, apiAs, uniqueName }) => {
  const sharedBoard = uniqueName("E2E guest source");
  const boardName = uniqueName("E2E members menu");
  await signIn(page, "amelia");
  const api = await apiAs("amelia");
  // Maya holds one board here, which makes her a known guest the menu can offer by name elsewhere.
  await boardSharedWithMaya(page, api, sharedBoard);
  const workspaceId = (await workspaceSettingsHref(page, "E2E primary board")).split("/")[2]!;
  const created = await api.post(`/api/workspaces/${workspaceId}/boards`, { data: { name: boardName } });
  expect(created.ok(), await created.text()).toBe(true);

  await openBoard(page, boardName);
  const menu = page.locator("k-board-members-menu");
  await page.locator(".board-members-trigger").click();
  await expect(menu.locator(".bmp-section-title").first()).toHaveText("Admins");
  const search = menu.getByRole("searchbox", { name: "Search or add people" });

  const email = `${boardName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@client.test`;
  await search.fill(email);
  await menu.getByRole("button", { name: `Invite ${email} as a guest` }).click();
  await expect(page.getByText(`Invitation emailed to ${email}.`)).toBeVisible();
  const invites = menu.locator(".bmp-invites");
  await expect(invites).toContainText(email);
  await expect(invites).toContainText("Guest invite · Editor");
  await menu.screenshot({ path: test.info().outputPath("members-pending-invite.png") });
  await menu.getByRole("button", { name: `Withdraw invite for ${email}` }).click();
  await expect(invites).toHaveCount(0);

  await search.fill("maya");
  const result = menu.locator(".bmp-result").filter({ hasText: users.maya.name });
  await expect(result).toContainText("Guest");
  await result.click();
  await expect(menu.locator(".bmp-guests")).toContainText(users.maya.name);
  await expect(search).toHaveValue("");
});
