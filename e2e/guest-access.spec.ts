import type { APIRequestContext, Page } from "@playwright/test";
import { users } from "./support/env";
import { expect, test } from "./support/fixtures";
import { boardHref, expectBoardDenied, openBoard, workspaceSettingsHref } from "./support/ui";

// Each test grants Maya (a user in another organisation) access to a board it creates, so revoking
// access in one test cannot change what another test sees.
async function boardSharedWithMaya(owner: Page, api: APIRequestContext, boardName: string) {
  const workspaceId = (await workspaceSettingsHref(owner, "Platform Delivery")).split("/")[2]!;
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
  const platformHref = await boardHref(page, "Platform Delivery");

  const guest = await pageAs("maya");
  await expect(guest.locator("a.board-link").filter({ hasText: "Platform Delivery" })).toHaveCount(0);
  await openBoard(guest, boardName);

  await guest.goto(platformHref);
  await expectBoardDenied(guest, "Platform Delivery");
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
