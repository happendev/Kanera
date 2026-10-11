import type { APIRequestContext, Page } from "@playwright/test";
import { users } from "./support/env";
import { expect, test } from "./support/fixtures";
import { boardIdOf, cardTile, createCard, openBoard, openCard, workspaceSettingsHref } from "./support/ui";

type Member = { userId: string; displayName: string; role: string };
type Profile = {
  user: { email: string | null; homeOrganisationName: string | null };
  role: string | null;
  stats: { openCards: number; completedCards: number };
  activity: { total: number };
  sharedBoards: { total: number; boards: { id: string }[] };
  recentCards: { title: string }[];
};

async function json<T>(response: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as T;
}

async function workspaceMembers(page: Page, api: APIRequestContext): Promise<{ workspaceId: string; members: Member[] }> {
  const workspaceId = (await workspaceSettingsHref(page, "Platform Delivery")).split("/")[2]!;
  return { workspaceId, members: await json<Member[]>(await api.get(`/api/workspaces/${workspaceId}/members`)) };
}

function memberId(members: Member[], name: string): string {
  const member = members.find((candidate) => candidate.displayName === name);
  expect(member, `${name} in the workspace`).toBeTruthy();
  return member!.userId;
}

/**
 * Creates a card on Platform Delivery, opens it, and returns its id. The id comes from the create
 * response: the detail route carries the human card key, which the card API does not accept.
 */
async function cardOnPlatformDelivery(page: Page, title: string): Promise<string> {
  await openBoard(page, "Platform Delivery");
  const created = page.waitForResponse((response) =>
    response.request().method() === "POST" && /\/boards\/[^/]+\/lists\/[^/]+\/cards$/.test(new URL(response.url()).pathname) && response.ok(),
  );
  await createCard(page, title);
  const { id } = (await (await created).json()) as { id: string };
  await openCard(page, title);
  return id;
}

test("a card-tile avatar opens the person's profile instead of the card, and View cards focuses Team Cards on them", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const title = uniqueName("E2E profile card");
  await signIn(page, "amelia");
  const cardId = await cardOnPlatformDelivery(page, title);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: `Card detail: ${title}` })).toHaveCount(0);

  const amelia = await apiAs("amelia");
  const { members } = await workspaceMembers(page, amelia);
  const marcusId = memberId(members, users.marcus.name);
  await json(await amelia.put(`/api/cards/${cardId}/assignees`, { data: { userIds: [marcusId] } }));
  // Marcus's own comment puts the card under "Recently worked on"; a second card he completes lights
  // today's cell, since the grid plots completions exactly as Work done's Completed strip does. The
  // completed card is a different one so the assigned tile stays open on the board.
  const marcus = await apiAs("marcus");
  await json(await marcus.post(`/api/cards/${cardId}/comments`, { data: { body: "Picking this up today." } }));
  const doneTitle = uniqueName("E2E profile completed");
  const doneId = await cardOnPlatformDelivery(page, doneTitle);
  await page.keyboard.press("Escape");
  await json(await marcus.patch(`/api/cards/${doneId}/completion`, { data: { completed: true } }));

  const avatar = cardTile(page, title).getByRole("button", { name: `View profile of ${users.marcus.name}` });
  await expect(avatar).toBeVisible();
  await avatar.click();

  const profile = page.getByRole("dialog", { name: `${users.marcus.name} profile` });
  await expect(profile).toBeVisible();
  await expect(profile).toHaveAttribute("aria-busy", "false");
  // The avatar sits inside the tile's card link; the profile is the more specific intent.
  await expect(page.getByRole("dialog", { name: `Card detail: ${title}` })).toHaveCount(0);
  await expect(avatar).toHaveAttribute("aria-expanded", "true");

  await expect(profile.getByRole("link", { name: users.marcus.email })).toBeVisible();
  await expect(profile.locator(".up-stat").filter({ hasText: "Open cards" }).locator("strong")).not.toHaveText("0");
  await expect(profile.locator(".up-card").filter({ hasText: title })).toBeVisible();
  await expect(profile.locator(".up-stat").filter({ hasText: "Done" }).locator("strong")).not.toHaveText("0");

  // 18 Monday-first week columns of 7 days, ending on the running week; today is the last day that
  // is not in the future and must carry Marcus's completion.
  const weeks = profile.locator(".up-week");
  await expect(weeks).toHaveCount(18);
  for (const week of await weeks.all()) await expect(week.locator(".up-cell")).toHaveCount(7);
  const today = weeks.last().locator(".up-cell:not(.is-future)").last();
  await expect(today).not.toHaveAttribute("data-level", "0");
  await profile.screenshot({ path: testInfo.outputPath("profile-from-tile.png") });

  // Escape closes only the card and returns focus to the avatar that opened it.
  await page.keyboard.press("Escape");
  await expect(profile).toHaveCount(0);
  await expect(avatar).toBeFocused();

  await avatar.click();
  await expect(profile).toHaveAttribute("aria-busy", "false");
  await profile.getByRole("link", { name: "View cards" }).click();
  await expect(page).toHaveURL(/\/team-cards$/, { timeout: 15_000 });
  // The teammate trigger shows the focused person once the deep link has been applied.
  await expect(page.locator(".k-toolbar-trigger.is-set").filter({ hasText: users.marcus.name })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => cardTile(page, title).count(), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath("team-cards-focused.png") });
});

test("in card detail the assignee's profile opens above the drawer and its Unassign action persists", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const title = uniqueName("E2E profile unassign");
  await signIn(page, "amelia");
  const cardId = await cardOnPlatformDelivery(page, title);
  const amelia = await apiAs("amelia");
  const { members } = await workspaceMembers(page, amelia);
  await json(await amelia.put(`/api/cards/${cardId}/assignees`, { data: { userIds: [memberId(members, users.marcus.name)] } }));

  const detail = page.getByRole("dialog", { name: `Card detail: ${title}` });
  const assignee = detail.getByRole("button", { name: `View profile of ${users.marcus.name}` });
  await expect(assignee).toBeVisible();
  await assignee.click();
  const profile = page.getByRole("dialog", { name: `${users.marcus.name} profile` });
  await expect(profile).toHaveAttribute("aria-busy", "false");
  // Clicking the face no longer unassigns by itself.
  await expect(assignee).toBeVisible();

  // The card is mounted by the shell, outside the drawer; it must still be what the pointer hits.
  const hit = await profile.evaluate((panel) => {
    const box = panel.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return Boolean(top && panel.contains(top));
  });
  expect(hit, "profile card paints above the card-detail drawer").toBe(true);
  await page.screenshot({ path: testInfo.outputPath("profile-over-card-detail.png") });

  await profile.getByRole("button", { name: "Unassign" }).click();
  await expect(profile).toHaveCount(0);
  await expect(assignee).toHaveCount(0);
  await expect(detail).toBeVisible();

  await page.reload();
  await expect(page.getByRole("dialog", { name: `Card detail: ${title}` })).toBeVisible();
  await expect(page.getByRole("dialog", { name: `Card detail: ${title}` }).getByRole("button", { name: `View profile of ${users.marcus.name}` })).toHaveCount(0);
});

test("profiles are scoped to shared work: a cross-organisation guest sees no email and none of the work they cannot open", async ({ page, signIn, apiAs, uniqueName }) => {
  await signIn(page, "amelia");
  const amelia = await apiAs("amelia");
  const maya = await apiAs("maya");
  const { workspaceId, members } = await workspaceMembers(page, amelia);
  const ameliaId = memberId(members, users.amelia.name);
  const platformId = await boardIdOf(page, "Platform Delivery");
  const profileOf = (api: APIRequestContext, userId: string) =>
    api.get(`/api/users/${userId}/profile?workspaceId=${workspaceId}`).then((response) => json<Profile>(response));
  // Maya already shares the seeded Mobile Experience board with Amelia (and, in a full run, guest
  // boards other specs created), so shared-board assertions compare totals rather than the preview,
  // which lists only the first few boards.
  const mayaBeforeGrant = await profileOf(maya, ameliaId);
  const board = await json<{ id: string }>(await amelia.post(`/api/workspaces/${workspaceId}/boards`, { data: { name: uniqueName("E2E profile guest board") } }));
  const granted = await json<{ status: string }>(await amelia.post(`/api/workspaces/${workspaceId}/guests/invitations`, {
    data: { boardId: board.id, email: users.maya.email, role: "editor" },
  }));
  expect(granted.status).toBe("added");

  const mayaBefore = await profileOf(maya, ameliaId);
  const selfBefore = await profileOf(amelia, ameliaId);
  expect(mayaBefore.user.email).toBeNull();
  expect(selfBefore.user.email).toBe(users.amelia.email);
  expect(mayaBefore.sharedBoards.total).toBe(mayaBeforeGrant.sharedBoards.total + 1);
  expect(mayaBefore.sharedBoards.boards.map((shared) => shared.id)).not.toContain(platformId);

  // New work for Amelia on a board Maya cannot open: Amelia's own view counts it, Maya's must not.
  const hiddenTitle = uniqueName("E2E profile hidden work");
  const hiddenCardId = await cardOnPlatformDelivery(page, hiddenTitle);
  await json(await amelia.put(`/api/cards/${hiddenCardId}/assignees`, { data: { userIds: [ameliaId] } }));
  const selfAfter = await profileOf(amelia, ameliaId);
  const mayaAfter = await profileOf(maya, ameliaId);
  expect(selfAfter.stats.openCards).toBe(selfBefore.stats.openCards + 1);
  expect(selfAfter.recentCards.map((card) => card.title)).toContain(hiddenTitle);
  expect(mayaAfter.stats.openCards).toBe(mayaBefore.stats.openCards);
  expect(mayaAfter.recentCards.map((card) => card.title)).not.toContain(hiddenTitle);

  // Completing that hidden card counts on Amelia's own grid and tile, and on neither for Maya.
  await json(await amelia.patch(`/api/cards/${hiddenCardId}/completion`, { data: { completed: true } }));
  const selfCompleted = await profileOf(amelia, ameliaId);
  const mayaCompleted = await profileOf(maya, ameliaId);
  expect(selfCompleted.activity.total).toBe(selfBefore.activity.total + 1);
  expect(selfCompleted.stats.completedCards).toBe(selfBefore.stats.completedCards + 1);
  expect(mayaCompleted.activity.total).toBe(mayaBefore.activity.total);
  expect(mayaCompleted.stats.completedCards).toBe(mayaBefore.stats.completedCards);

  // Unknown and malformed ids are both a plain 404, so the route cannot be used to probe accounts.
  expect((await maya.get("/api/users/00000000-0000-4000-8000-000000000000/profile")).status()).toBe(404);
  expect((await maya.get("/api/users/not-a-user/profile")).status()).toBe(404);

  const mayaId = (await json<{ id: string }>(await maya.get("/api/me"))).id;
  const mayaSeenByAmelia = await profileOf(amelia, mayaId);
  expect(mayaSeenByAmelia.role).toBe("guest");
  expect(mayaSeenByAmelia.user.email).toBeNull();
  expect(mayaSeenByAmelia.user.homeOrganisationName).toBeTruthy();

  // Revoking the guest narrows their view on the very next request. They still share the seeded
  // Mobile Experience board with Amelia, so the profile stays reachable without the revoked board.
  const removed = await amelia.delete(`/api/workspaces/${workspaceId}/guests/${board.id}/${mayaId}`);
  expect(removed.ok(), await removed.text()).toBe(true);
  const revoked = await profileOf(maya, ameliaId);
  expect(revoked.sharedBoards.total).toBe(mayaBeforeGrant.sharedBoards.total);
  expect(revoked.sharedBoards.boards.map((shared) => shared.id)).not.toContain(board.id);
});
