import { expandCardSummary, type CompactCardSummary, type WireCardDetail } from "../packages/shared/src/events";
import { expect, test } from "./support/fixtures";
import { seedCalendar } from "../apps/api/src/scripts/seed-calendar";

// Verify Marketing's handoff against the real seed. These checks catch reordered identities,
// shuffled checklist sign-offs, discarded attachment/history, timed dates, duplicate intake cards,
// and missing recording fixtures, budgets or archived work.
test("the Marketing seed applies the approved content repairs and date-only deadlines", async ({ page, apiAs, signIn }, testInfo) => {
  const api = await apiAs("amelia");
  const boardsResponse = await api.get("/api/boards");
  expect(boardsResponse.ok()).toBe(true);
  const boards = await boardsResponse.json() as { id: string; name: string; workspaceId: string }[];
  const launchBoard = boards.find((board) => board.name === "Autumn Campaign Launch")!;
  const allCards: ReturnType<typeof expandCardSummary>[] = [];
  const lists = new Map<string, string>();
  for (const board of boards.filter((candidate) => candidate.workspaceId === launchBoard.workspaceId)) {
    const response = await api.post(`/api/boards/${board.id}/open?includeCompleted=true`);
    expect(response.ok()).toBe(true);
    const opened = await response.json() as { cards: CompactCardSummary[]; lists: { id: string; name: string }[] };
    allCards.push(...opened.cards.map(expandCardSummary));
    for (const list of opened.lists) lists.set(list.id, list.name);
  }
  // Twelve obsolete cards are archived; three delivery steps and the automation demo were added.
  expect(new Set(allCards.map((card) => card.id)).size).toBe(112);
  const card = (title: string) => {
    const matches = allCards.filter((candidate) => candidate.title === title);
    expect(matches, title).toHaveLength(1);
    return matches[0]!;
  };
  const detail = async (id: string) => {
    const response = await api.get(`/api/cards/${id}/detail`);
    expect(response.ok(), await response.text()).toBe(true);
    return await response.json() as WireCardDetail;
  };
  const email = card("Schedule the launch-day customer email");
  expect(email.number).toBe(120);
  expect(email.boardId).toBe(launchBoard.id);
  const calendar = seedCalendar(new Date(email.createdAt));
  const dateAt = (offset: number) => offset < 0 ? calendar.previous(-offset) : calendar.business(offset);
  const expectedDates = [
    ["Prepare the launch-week social schedule", 9, -1],
    ["Draft the autumn product-update changelog post", 73, 5],
    ["Assemble the webinar follow-up sequence", 91, 12],
    ["Finalise the campaign tracking and UTM plan", 11, 1],
    ["Approve the customer announcement email", 13, 4],
    [email.title, 120, 6],
    ["Refresh the customer onboarding email sequence", 102, 0],
  ] as const;
  for (const [title, number, offset] of expectedDates) {
    const row = card(title);
    expect(row.number, title).toBe(number);
    expect(row.dueDateLocalDate, title).toBe(dateAt(offset));
    expect(row.dueDateSlot, title).toBeNull();
    expect(row.dueDateTimezone, title).toBe("Europe/London");
  }

  const membersResponse = await api.get(`/api/workspaces/${launchBoard.workspaceId}/members`);
  expect(membersResponse.ok()).toBe(true);
  const members = await membersResponse.json() as { userId: string; displayName: string }[];
  const memberId = (name: string) => members.find((member) => member.displayName === name)!.userId;
  // The recording fixture assigns the video to Ben and retains the authored team totals.
  for (const [name, count] of [["Grace Liu", 18], ["Ben Ortega", 17]] as const) {
    expect(allCards.filter((row) => row.assigneeIds.includes(memberId(name))), name).toHaveLength(count);
  }
  const intake = card("Refresh the customer onboarding email sequence");
  expect(intake.assigneeIds).toEqual([]);
  expect(lists.get(intake.listId)).toBe("Ideas & Requests");

  const launch = card("Prepare autumn campaign launch");
  expect(launch.number).toBe(14);
  expect(lists.get(launch.listId)).toBe("Waiting on Others");
  expect(launch.assigneeIds).toEqual([memberId("Ben Ortega")]);
  expect(launch.coverAttachmentId).toBeNull();
  const launchDetail = await detail(launch.id);
  const approval = card("Approve the campaign launch package");
  expect(approval.number).toBe(12);
  expect(launchDetail.card.description).toContain(`Product messaging is signed off in ${card("Confirm final product messaging").key}; ${approval.key} remains the open launch-approval dependency.`);
  expect(launchDetail.card.description).not.toContain("{{campaignApprovalKey}}");
  expect(launchDetail.attachments).toHaveLength(1);
  expect(launch.blockedByCount).toBe(1);
  const messaging = card("Confirm final product messaging");
  expect(messaging.number).toBe(15);
  expect(messaging.completedAt).toBeTruthy();
  expect(lists.get(messaging.listId)).toBe("Done");
  expect(launchDetail.relations.map((relation) => relation.card.id)).toEqual(expect.arrayContaining([approval.id, messaging.id]));

  const checklist = launchDetail.checklists.find((list) => list.title === "Launch readiness")!;
  expect(checklist.items.filter((item) => item.completedAt)).toHaveLength(1);
  expect(checklist.items.find((item) => item.text === "Verify landing-page tracking")?.completedAt).toBeNull();
  const feedResponse = await api.get(`/api/cards/${launch.id}/feed?limit=100`);
  expect(feedResponse.ok()).toBe(true);
  const feed = await feedResponse.json() as { items: { type: string; data: { action?: string; createdAt?: string; payload?: { itemId?: string } } }[] };
  const signedOff = checklist.items.find((item) => item.text === "Confirm final product messaging")!;
  expect(new Date(signedOff.completedAt!).toISOString().slice(0, 10)).toBe(calendar.date);
  // The recording fixture sets the current sign-off without inventing a historical execution.
  expect(feed.items.filter((item) => item.type === "activity" && item.data.action === "checklistItem:completion")).toEqual([]);
  expect(feed.items.some((item) => item.type === "comment")).toBe(true);

  const graphics = card("Design the autumn campaign graphics");
  expect(graphics.number).toBe(7);
  expect(lists.get(graphics.listId)).toBe("Waiting on Others");
  expect(graphics.completedAt).toBeNull();
  expect(graphics.assigneeIds).toEqual([memberId("Nina Park")]);
  const graphicsFeedResponse = await api.get(`/api/cards/${graphics.id}/feed?limit=100`);
  expect(graphicsFeedResponse.ok()).toBe(true);
  const graphicsFeed = await graphicsFeedResponse.json() as { items: { type: string; data: { action?: string; createdAt?: string; actorKind?: string } }[] };
  const completed = graphicsFeed.items.filter((item) => item.type === "activity" && item.data.action === "completion:set");
  expect(completed).toHaveLength(0);
  expect(graphicsFeed.items).toContainEqual(expect.objectContaining({
    type: "activity", data: expect.objectContaining({ action: "attachment_added" }),
  }));
  const emailDetail = await detail(email.id);
  expect(emailDetail.assigneeIds).toEqual([memberId("Amelia Hart")]);
  expect(emailDetail.relations).toContainEqual(expect.objectContaining({ direction: "blocked_by", card: expect.objectContaining({ id: card("Approve the customer announcement email").id }) }));
  const workspaceResponse = await api.get(`/api/workspaces/${launchBoard.workspaceId}`);
  expect(workspaceResponse.ok()).toBe(true);
  const workspace = await workspaceResponse.json() as { customFields: { id: string; name: string }[] };
  const budgetId = workspace.customFields.find((field) => field.name === "Budget")!.id;
  expect(allCards.filter((row) => row.boardId === launchBoard.id).flatMap((row) => row.customFieldValues).filter((value) => value.fieldId === budgetId)).toHaveLength(8);
  expect((await detail(card("Update the recruitment brochure").id)).customFieldValues).toContainEqual(expect.objectContaining({ fieldId: budgetId, valueNumber: "2400" }));
  for (const title of ["Coordinate launch-day publishing and checks", "Run the customer webinar rehearsal", "Send the webinar recording and follow-up", "Design the campaign overview document"]) {
    expect(card(title).completedAt, title).toBeNull();
  }
  await testInfo.attach("marketing-seed-readback", { body: JSON.stringify({ cards: allCards, launchDetail, emailDetail }, null, 2), contentType: "application/json" });

  await signIn(page, "amelia");
  await page.goto(`/b/${launchBoard.id}/c/${launch.id}`);
  const dialog = page.getByRole("dialog", { name: `Card detail: ${launch.title}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".panel-cover")).toHaveCount(0);
  await expect(dialog.getByText("Product messaging is signed off in", { exact: false })).toBeVisible();
  await expect(dialog.locator(".checklist-count")).toContainText("1/4");
  await page.screenshot({ path: testInfo.outputPath("marketing-launch-desktop.png") });
  await page.setViewportSize({ width: 540, height: 960 });
  await expect(dialog.locator(".panel-cover")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("marketing-launch-phone.png") });
});
