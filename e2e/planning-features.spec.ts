import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { expectBoardLoaded, openCard } from "./support/ui";

// The workspace and organisation switches for dependencies, start dates with the Timeline, and time
// in progress. The test owns its workspace, and restores the organisation switch it flips. A second
// page for the same user is a second socket, so every change it shows after the first load arrived
// over realtime (`board:updated` with `features`), not a reload.

/** Ticks a General settings switch and waits for the PATCH, so later assertions never race the save. */
async function setWorkspaceFeature(page: Page, workspaceId: string, name: string, enabled: boolean) {
  const toggle = page.getByRole("checkbox", { name, exact: true });
  await expect(toggle).toBeChecked({ checked: !enabled });
  const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/workspaces/${workspaceId}`));
  await toggle.click();
  expect((await saved).ok()).toBe(true);
  await expect(toggle).toBeChecked({ checked: enabled });
}

test("workspace planning switches hide dependencies, the timeline and time in progress live and close the API", async ({ page, signIn, pageAs, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const workspaceName = uniqueName("E2E planning switches");
  const boardName = uniqueName("E2E planning board");
  const created = await api.post("/api/workspaces", {
    data: {
      name: workspaceName,
      initialBoard: { name: boardName },
      lists: [{ name: "To do" }, { name: "Doing", inProgress: true }, { name: "Done" }],
      customFields: [],
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspace = await created.json() as { id: string; initialBoard: { id: string } };
  const boardId = workspace.initialBoard.id;
  const board = await (await api.get(`/api/boards/${boardId}?includeCards=false`)).json() as { lists: { id: string; name: string }[] };
  const listId = (name: string) => board.lists.find((list) => list.name === name)!.id;
  const createCard = async (title: string, list = "To do", extra: object = {}) => {
    const response = await api.post(`/api/boards/${boardId}/lists/${listId(list)}/cards`, { data: { title, ...extra } });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json() as { id: string }).id;
  };
  const blockerTitle = uniqueName("E2E blocker");
  const blockedTitle = uniqueName("E2E blocked");
  const plannedTitle = uniqueName("E2E planned");
  const workingTitle = uniqueName("E2E working");
  const blockerId = await createCard(blockerTitle);
  const blockedId = await createCard(blockedTitle);
  await createCard(plannedTitle, "To do", { startDateLocalDate: "2030-06-03", dueDateLocalDate: "2030-06-07" });
  await createCard(workingTitle, "Doing");
  expect((await api.post(`/api/cards/${blockerId}/relations`, { data: { targetCardId: blockedId, direction: "blocks" } })).status()).toBe(201);

  // The viewer watches the board while an admin flips the switches in settings.
  const viewer = await pageAs("amelia");
  await viewer.goto(`/b/${boardId}`);
  await expectBoardLoaded(viewer, boardName);
  const tile = (title: string) => viewer.locator("k-card").filter({ hasText: title });
  await expect(tile(blockedTitle).locator(".card-blocked")).toBeVisible();
  await expect(tile(workingTitle).locator(".card-time-in-progress")).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Timeline view" })).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Dependencies view" })).toBeVisible();

  await signIn(page, "amelia");
  await page.goto(`/w/${workspace.id}/settings/general`);
  await expect(page.getByRole("heading", { name: `${workspaceName} Settings`, exact: true })).toBeVisible();
  await setWorkspaceFeature(page, workspace.id, "Enable dependencies", false);
  await setWorkspaceFeature(page, workspace.id, "Enable start dates and timeline", false);
  await setWorkspaceFeature(page, workspace.id, "Enable time in progress", false);
  await page.locator(".board-settings-section").filter({ hasText: "Planning features" }).screenshot({ path: testInfo.outputPath("settings-planning-features.png") });

  // Live: the Blocked chip, the running clock and both views go without a reload.
  await expect(tile(blockedTitle).locator(".card-blocked")).toHaveCount(0);
  await expect(tile(workingTitle).locator(".card-time-in-progress")).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "Timeline view" })).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "Dependencies view" })).toHaveCount(0);
  await viewer.screenshot({ path: testInfo.outputPath("board-planning-features-off.png") });

  // Card detail offers no start date, and only plain links between cards.
  const detail = await openCard(viewer, plannedTitle);
  await expect(detail.getByRole("button", { name: "Set start date" })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "Change start date" })).toHaveCount(0);

  // The API is closed for agents, the CLI and integrations too.
  const relation = await api.post(`/api/cards/${blockedId}/relations`, { data: { targetCardId: blockerId, direction: "blocked_by" } });
  expect(relation.status()).toBe(403);
  expect(await relation.text()).toContain("DEPENDENCIES_DISABLED");
  const start = await api.patch(`/api/cards/${blockedId}`, { data: { startDateLocalDate: "2030-06-03" } });
  expect(start.status()).toBe(403);
  expect(await start.text()).toContain("TIMELINE_DISABLED");
  expect((await api.post("/api/cards/schedule", { data: { boardId } })).status()).toBe(403);
  expect((await api.post("/api/cards/dependency-graph", { data: { boardId } })).status()).toBe(403);

  // A `?view=timeline` link lands on the kanban.
  await viewer.goto(`/b/${boardId}?view=timeline`);
  await expectBoardLoaded(viewer, boardName);
  await expect(viewer.getByRole("button", { name: "Board view" })).toHaveAttribute("aria-pressed", "true");
  await expect(viewer.locator("k-board-timeline-view")).toHaveCount(0);
  // Back to the plain board URL: with `?view=timeline` still in it, re-enabling the timeline would
  // (rightly) switch this page to the Timeline, which has no kanban tiles to assert on.
  await viewer.goto(`/b/${boardId}`);
  await expectBoardLoaded(viewer, boardName);

  // Re-enabling restores everything: relations, start dates and recorded time were only hidden.
  await setWorkspaceFeature(page, workspace.id, "Enable dependencies", true);
  await setWorkspaceFeature(page, workspace.id, "Enable start dates and timeline", true);
  await setWorkspaceFeature(page, workspace.id, "Enable time in progress", true);
  await expect(tile(blockedTitle).locator(".card-blocked")).toBeVisible();
  await expect(tile(workingTitle).locator(".card-time-in-progress")).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Timeline view" })).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Dependencies view" })).toBeVisible();
  const restored = await openCard(viewer, plannedTitle);
  await expect(restored.getByRole("button", { name: "Change start date" })).toBeVisible();
});

test("the organisation switch overrides a workspace that keeps dependencies on", async ({ page, signIn, pageAs, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const workspaceName = uniqueName("E2E org planning switch");
  const boardName = uniqueName("E2E org planning board");
  const created = await api.post("/api/workspaces", { data: { name: workspaceName, initialBoard: { name: boardName }, listNames: ["To do", "Done"], customFields: [] } });
  expect(created.ok(), await created.text()).toBe(true);
  const workspace = await created.json() as { id: string; initialBoard: { id: string } };
  const boardId = workspace.initialBoard.id;
  const board = await (await api.get(`/api/boards/${boardId}?includeCards=false`)).json() as { lists: { id: string }[] };
  const createCard = async (title: string) => {
    const response = await api.post(`/api/boards/${boardId}/lists/${board.lists[0]!.id}/cards`, { data: { title } });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json() as { id: string }).id;
  };
  const blockedTitle = uniqueName("E2E org blocked");
  const blockerId = await createCard(uniqueName("E2E org blocker"));
  const blockedId = await createCard(blockedTitle);
  expect((await api.post(`/api/cards/${blockerId}/relations`, { data: { targetCardId: blockedId, direction: "blocks" } })).status()).toBe(201);

  const viewer = await pageAs("amelia");
  await viewer.goto(`/b/${boardId}`);
  await expectBoardLoaded(viewer, boardName);
  const chip = viewer.locator("k-card").filter({ hasText: blockedTitle }).locator(".card-blocked");
  await expect(chip).toBeVisible();

  try {
    // The owner flips the organisation's master switch from Organisation settings.
    await signIn(page, "amelia");
    await page.goto("/settings/org");
    const masterSwitch = page.getByRole("checkbox", { name: "Enable dependencies", exact: true });
    await expect(masterSwitch).toBeChecked();
    const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith("/api/clients/me"));
    await masterSwitch.click();
    expect((await saved).ok()).toBe(true);
    await expect(masterSwitch).not.toBeChecked();
    await page.locator(".settings-section").filter({ hasText: "Planning features" }).screenshot({ path: testInfo.outputPath("org-planning-features.png") });
    await expect(chip).toHaveCount(0);
    await expect(viewer.getByRole("button", { name: "Dependencies view" })).toHaveCount(0);

    // The workspace's own switch stays on but is locked while the organisation has it off.
    await page.goto(`/w/${workspace.id}/settings/general`);
    const toggle = page.getByRole("checkbox", { name: "Enable dependencies", exact: true });
    await expect(toggle).toBeDisabled();
    await expect(toggle).not.toBeChecked();
    await expect(page.getByText("Turned off for the whole organisation.").first()).toBeVisible();
  } finally {
    expect((await api.patch("/api/clients/me", { data: { dependenciesEnabled: true } })).ok()).toBe(true);
  }
  await expect(chip).toBeVisible();
});
