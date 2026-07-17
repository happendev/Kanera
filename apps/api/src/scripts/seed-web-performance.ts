import {
  boardMembers,
  boards,
  cardAssignees,
  cardChecklistItems,
  cardChecklists,
  cardCustomFieldValues,
  cardLabelAssignments,
  cardLabels,
  cards,
  clients,
  comments,
  customFieldOptions,
  customFields,
  lists,
  users,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { hashPassword } from "../auth/password.js";
import { db, pool, type Db } from "../db.js";
import { env } from "../env.js";

const PERF_CLIENT_ID = "70000000-0000-4000-8000-000000000001";
const PERF_WORKSPACE_ID = "70000000-0000-4000-8000-000000000100";
const PERF_BOARD_ID = "70000000-0000-4000-8000-000000000200";
const PERF_USER_ID = "70000000-0000-4000-8000-000000000010";
const PERF_CLIENT_NAME = "[LOCAL PERF] Kanera Web Benchmark";
const PERF_WORKSPACE_NAME = "[LOCAL PERF] Scale Lab";
const PERF_EMAIL = "perf@kanera.local";
const PERF_PASSWORD = "Perf12345";
const CARD_COUNT = 1_000;
const LIST_COUNT = 20;
const BOARD_COUNT = 40;
const RICH_CARDS_PER_LIST = 3;
const INSERT_CHUNK_SIZE = 500;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const MEMBER_SEEDS = [
  { id: PERF_USER_ID, email: PERF_EMAIL, displayName: "Amelia Benchmark", clientRole: "owner" as const, workspaceRole: "admin" as const },
  { id: "70000000-0000-4000-8000-000000000011", email: "marcus.perf@kanera.local", displayName: "Marcus Chen", clientRole: "member" as const, workspaceRole: "admin" as const },
  { id: "70000000-0000-4000-8000-000000000012", email: "priya.perf@kanera.local", displayName: "Priya Nair", clientRole: "member" as const, workspaceRole: "member" as const },
  { id: "70000000-0000-4000-8000-000000000013", email: "ben.perf@kanera.local", displayName: "Ben Carter", clientRole: "member" as const, workspaceRole: "member" as const },
  { id: "70000000-0000-4000-8000-000000000014", email: "nina.perf@kanera.local", displayName: "Nina Alvarez", clientRole: "member" as const, workspaceRole: "member" as const },
  { id: "70000000-0000-4000-8000-000000000015", email: "zoe.perf@kanera.local", displayName: "Zoe Williams", clientRole: "member" as const, workspaceRole: "member" as const },
];

const LIST_NAMES = [
  "Inbox", "Discovery", "Ready", "In progress", "Review", "Validation", "Blocked", "Waiting",
  "Design", "Engineering", "Content", "Data", "Security", "Mobile", "Web", "API", "Release",
  "Follow-up", "Done soon", "Backlog",
];

const LABEL_SEEDS = [
  ["Critical", "red"], ["Customer", "orange"], ["Growth", "amber"], ["Research", "yellow"],
  ["Design", "lime"], ["Frontend", "green"], ["Backend", "teal"], ["Data", "cyan"],
  ["Mobile", "blue"], ["Security", "indigo"], ["Platform", "violet"], ["Follow-up", "pink"],
] as const;

function assertLocalOnly(): void {
  const databaseUrl = new URL(env.DATABASE_URL);
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (env.NODE_ENV === "production" || !localHosts.has(databaseUrl.hostname)) {
    throw new Error("Refusing to create the web performance fixture outside a local, non-production database.");
  }
}

function position(index: number): string {
  return ((index + 1) * 1_000).toFixed(10);
}

function localDate(offsetDays: number): string {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

async function insertChunks<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK_SIZE) {
    await insert(rows.slice(offset, offset + INSERT_CHUNK_SIZE));
  }
}

async function replaceFixture(tx: Tx): Promise<void> {
  const [existingClient] = await tx.select({ name: clients.name }).from(clients).where(eq(clients.id, PERF_CLIENT_ID)).limit(1);
  if (existingClient && existingClient.name !== PERF_CLIENT_NAME) {
    throw new Error(`Refusing to replace client ${PERF_CLIENT_ID}; it is not the marked local performance fixture.`);
  }
  if (existingClient) {
    // Cards restrict deletion of their creator, so remove the fixture's workspace tree before the
    // client cascade reaches users. This ordering keeps repeated benchmark seeding deterministic.
    await tx.delete(workspaces).where(eq(workspaces.clientId, PERF_CLIENT_ID));
    await tx.delete(clients).where(eq(clients.id, PERF_CLIENT_ID));
  }

  const conflictingUsers = await tx.select({ id: users.id, clientId: users.clientId }).from(users).where(eq(users.email, PERF_EMAIL)).limit(1);
  if (conflictingUsers[0] && conflictingUsers[0].clientId !== PERF_CLIENT_ID) {
    throw new Error(`Refusing to create ${PERF_EMAIL}; that email belongs to a non-fixture account.`);
  }

  const passwordHash = await hashPassword(PERF_PASSWORD);
  const now = new Date();
  const createdAt = new Date(now.getTime() - 90 * 86_400_000);

  await tx.insert(clients).values({
    id: PERF_CLIENT_ID,
    name: PERF_CLIENT_NAME,
    plan: "paid",
    billingStatus: "active",
    seatLimit: MEMBER_SEEDS.length,
    storageConfig: { kind: "local" },
    createdAt,
    updatedAt: now,
  });

  await tx.insert(users).values(MEMBER_SEEDS.map((member, index) => ({
    id: member.id,
    clientId: PERF_CLIENT_ID,
    clientRole: member.clientRole,
    email: member.email,
    emailVerifiedAt: createdAt,
    passwordHash,
    displayName: member.displayName,
    timezone: index % 2 === 0 ? "Europe/London" : "America/New_York",
    createdAt,
    updatedAt: now,
  })));

  await tx.insert(workspaces).values({
    id: PERF_WORKSPACE_ID,
    clientId: PERF_CLIENT_ID,
    name: PERF_WORKSPACE_NAME,
    icon: "chart-histogram",
    accentColor: "violet",
    createdAt,
    updatedAt: now,
  });
  await tx.insert(workspaceMembers).values(MEMBER_SEEDS.map((member) => ({
    workspaceId: PERF_WORKSPACE_ID,
    userId: member.id,
    role: member.workspaceRole,
    addedAt: createdAt,
  })));

  const listRows: (typeof lists.$inferInsert)[] = LIST_NAMES.map((name, index) => ({
    id: randomUUID(),
    workspaceId: PERF_WORKSPACE_ID,
    name,
    icon: ["inbox", "bulb", "circle-check", "progress", "eye", "test-pipe", "ban", "clock"][index % 8],
    color: LABEL_SEEDS[index % LABEL_SEEDS.length]![1],
    position: position(index),
    createdAt,
    updatedAt: now,
  }));
  await tx.insert(lists).values(listRows);

  const boardRows: (typeof boards.$inferInsert)[] = Array.from({ length: BOARD_COUNT }, (_, index) => ({
    id: index === 0 ? PERF_BOARD_ID : randomUUID(),
    workspaceId: PERF_WORKSPACE_ID,
    name: index === 0 ? "[LOCAL PERF] 1,000 Card Board" : `[LOCAL PERF] Supporting Board ${String(index).padStart(2, "0")}`,
    description: index === 0
      ? "A deterministic local-only fixture for measuring Angular rendering, interactions, and retained memory at realistic scale."
      : "A shell-navigation fixture used to make workspace and board filtering representative.",
    icon: index === 0 ? "chart-histogram" : "layout-kanban",
    iconColor: LABEL_SEEDS[index % LABEL_SEEDS.length]![1],
    backgroundGradient: index === 0 ? "violet" : null,
    position: position(index),
    createdAt,
    updatedAt: now,
  }));
  await tx.insert(boards).values(boardRows);

  const adminMembers = MEMBER_SEEDS.filter((member) => member.workspaceRole === "admin");
  await tx.insert(boardMembers).values(boardRows.flatMap((board) => adminMembers.map((member) => ({
    boardId: board.id!,
    userId: member.id,
    role: "editor" as const,
    pinned: true,
    addedAt: createdAt,
  }))));

  const labelRows: (typeof cardLabels.$inferInsert)[] = LABEL_SEEDS.map(([name, color], index) => ({
    id: randomUUID(), workspaceId: PERF_WORKSPACE_ID, name, color, position: position(index), createdAt, updatedAt: now,
  }));
  await tx.insert(cardLabels).values(labelRows);

  const fieldRows: (typeof customFields.$inferInsert)[] = [
    { id: randomUUID(), workspaceId: PERF_WORKSPACE_ID, name: "Priority", icon: "flag", type: "select", position: position(0), showOnCard: true },
    { id: randomUUID(), workspaceId: PERF_WORKSPACE_ID, name: "Effort", icon: "ruler", type: "number", position: position(1), showOnCard: true },
    { id: randomUUID(), workspaceId: PERF_WORKSPACE_ID, name: "Initiative", icon: "target-arrow", type: "text", position: position(2), showOnCard: true },
    { id: randomUUID(), workspaceId: PERF_WORKSPACE_ID, name: "At risk", icon: "alert-triangle", type: "checkbox", position: position(3), showOnCard: true },
    { id: randomUUID(), workspaceId: PERF_WORKSPACE_ID, name: "Target date", icon: "calendar", type: "date", position: position(4), showOnCard: false },
    { id: randomUUID(), workspaceId: PERF_WORKSPACE_ID, name: "Reference", icon: "link", type: "url", position: position(5), showOnCard: false },
    { id: randomUUID(), workspaceId: PERF_WORKSPACE_ID, name: "Stakeholders", icon: "users", type: "user", allowMultiple: true, position: position(6), showOnCard: false },
  ];
  await tx.insert(customFields).values(fieldRows);
  const priorityOptions: (typeof customFieldOptions.$inferInsert)[] = ["Urgent", "High", "Medium", "Low"].map((label, index) => ({
    id: randomUUID(), fieldId: fieldRows[0]!.id!, label, color: LABEL_SEEDS[index]![1], position: position(index), createdAt, updatedAt: now,
  }));
  await tx.insert(customFieldOptions).values(priorityOptions);

  const cardRows: (typeof cards.$inferInsert)[] = [];
  const assigneeRows: (typeof cardAssignees.$inferInsert)[] = [];
  const labelAssignmentRows: (typeof cardLabelAssignments.$inferInsert)[] = [];
  const fieldValueRows: (typeof cardCustomFieldValues.$inferInsert)[] = [];
  const richCardIds: string[] = [];

  for (let cardIndex = 0; cardIndex < CARD_COUNT; cardIndex += 1) {
    const listIndex = cardIndex % LIST_COUNT;
    const listPosition = Math.floor(cardIndex / LIST_COUNT);
    const rich = listPosition < RICH_CARDS_PER_LIST;
    const cardId = randomUUID();
    const sequence = String(cardIndex + 1).padStart(4, "0");
    if (rich) richCardIds.push(cardId);
    cardRows.push({
      id: cardId,
      boardId: PERF_BOARD_ID,
      listId: listRows[listIndex]!.id!,
      title: `${rich ? "[Rich] " : ""}Scale scenario ${sequence}: ${["customer onboarding", "permissions review", "mobile navigation", "realtime reconciliation", "reporting workflow"][cardIndex % 5]}`,
      description: `### Benchmark scenario ${sequence}\n\nValidate the ${LIST_NAMES[listIndex]} workflow with realistic text density, keyboard navigation, filtering, and cross-team ownership. This description is intentionally substantial so card summaries and detail views exercise normal string allocation and Markdown rendering.\n\n- Confirm acceptance criteria\n- Review edge cases and accessibility\n- Record follow-up decisions for the delivery team`,
      position: position(listPosition),
      dueDateLocalDate: localDate((cardIndex % 45) - 12),
      dueDateSlot: ["morning", "afternoon", "endOfWorkDay", "anyTime"][cardIndex % 4] as "morning" | "afternoon" | "endOfWorkDay" | "anyTime",
      dueDateTimezone: "Europe/London",
      createdById: MEMBER_SEEDS[cardIndex % MEMBER_SEEDS.length]!.id,
      createdAt: new Date(createdAt.getTime() + cardIndex * 60_000),
      updatedAt: now,
    });

    const extraAssignees = cardIndex % 3 === 0 ? 2 : 1;
    const assignedUserIds = new Set([PERF_USER_ID]);
    for (let offset = 0; offset < extraAssignees; offset += 1) {
      assignedUserIds.add(MEMBER_SEEDS[1 + ((cardIndex + offset) % (MEMBER_SEEDS.length - 1))]!.id);
    }
    assigneeRows.push(...Array.from(assignedUserIds, (userId) => ({ cardId, userId, assignedAt: createdAt })));

    for (let offset = 0; offset < 3; offset += 1) {
      labelAssignmentRows.push({ cardId, labelId: labelRows[(cardIndex + offset * 3) % labelRows.length]!.id!, assignedAt: createdAt });
    }

    fieldValueRows.push(
      { cardId, fieldId: fieldRows[0]!.id!, valueOptionIds: [priorityOptions[cardIndex % priorityOptions.length]!.id!], updatedAt: now },
      { cardId, fieldId: fieldRows[1]!.id!, valueNumber: String((cardIndex % 13) + 1), updatedAt: now },
      { cardId, fieldId: fieldRows[2]!.id!, valueText: ["Retention", "Activation", "Reliability", "Enterprise", "Foundations"][cardIndex % 5], updatedAt: now },
      { cardId, fieldId: fieldRows[3]!.id!, valueCheckbox: cardIndex % 7 === 0, updatedAt: now },
      { cardId, fieldId: fieldRows[4]!.id!, valueDate: localDate((cardIndex % 60) - 15), updatedAt: now },
      { cardId, fieldId: fieldRows[5]!.id!, valueUrl: `https://example.test/benchmark/scenario-${sequence}`, updatedAt: now },
      { cardId, fieldId: fieldRows[6]!.id!, valueUserIds: [MEMBER_SEEDS[cardIndex % MEMBER_SEEDS.length]!.id, MEMBER_SEEDS[(cardIndex + 2) % MEMBER_SEEDS.length]!.id], updatedAt: now },
    );
  }

  await insertChunks(cardRows, (chunk) => tx.insert(cards).values(chunk));
  await insertChunks(assigneeRows, (chunk) => tx.insert(cardAssignees).values(chunk));
  await insertChunks(labelAssignmentRows, (chunk) => tx.insert(cardLabelAssignments).values(chunk));
  await insertChunks(fieldValueRows, (chunk) => tx.insert(cardCustomFieldValues).values(chunk));

  const checklistRows: (typeof cardChecklists.$inferInsert)[] = [];
  const checklistItemRows: (typeof cardChecklistItems.$inferInsert)[] = [];
  const commentRows: (typeof comments.$inferInsert)[] = [];
  for (const [richIndex, cardId] of richCardIds.entries()) {
    for (let checklistIndex = 0; checklistIndex < 2; checklistIndex += 1) {
      const checklistId = randomUUID();
      checklistRows.push({ id: checklistId, cardId, title: checklistIndex === 0 ? "Delivery readiness" : "Quality and rollout", position: position(checklistIndex), createdAt, updatedAt: now });
      for (let itemIndex = 0; itemIndex < 8; itemIndex += 1) {
        const completed = itemIndex < 3;
        checklistItemRows.push({
          id: randomUUID(), checklistId, text: `Benchmark checklist item ${itemIndex + 1}: verify ${["scope", "copy", "permissions", "analytics", "fallback", "accessibility", "rollout", "monitoring"][itemIndex]}`,
          description: "Detailed checklist context ensures expanded card tiles and the card-detail checklist editor receive representative content.",
          position: position(itemIndex), assigneeId: MEMBER_SEEDS[(richIndex + itemIndex) % MEMBER_SEEDS.length]!.id,
          dueDateLocalDate: localDate(itemIndex - 2), dueDateSlot: "endOfWorkDay", dueDateTimezone: "Europe/London",
          completedAt: completed ? new Date(now.getTime() - (itemIndex + 1) * 3_600_000) : null,
          completedById: completed ? PERF_USER_ID : null, createdAt, updatedAt: now,
        });
      }
    }
    for (let commentIndex = 0; commentIndex < 8; commentIndex += 1) {
      commentRows.push({
        id: randomUUID(), cardId, authorId: MEMBER_SEEDS[(richIndex + commentIndex) % MEMBER_SEEDS.length]!.id,
        body: `Benchmark discussion ${commentIndex + 1}: the team reviewed the current state, noted a realistic implementation tradeoff, and recorded a concrete follow-up for the next validation pass.`,
        createdAt: new Date(createdAt.getTime() + (commentIndex + 1) * 3_600_000),
      });
    }
  }
  await insertChunks(checklistRows, (chunk) => tx.insert(cardChecklists).values(chunk));
  await insertChunks(checklistItemRows, (chunk) => tx.insert(cardChecklistItems).values(chunk));
  await insertChunks(commentRows, (chunk) => tx.insert(comments).values(chunk));
}

assertLocalOnly();
try {
  const startedAt = performance.now();
  await db.transaction(replaceFixture);
  console.log("local web performance fixture ready");
  console.log(`login: ${PERF_EMAIL} / ${PERF_PASSWORD}`);
  console.log(`workspace: ${PERF_WORKSPACE_ID}`);
  console.log(`primary board: ${PERF_BOARD_ID}`);
  console.log(`shape: ${BOARD_COUNT} boards, ${LIST_COUNT} lists, ${CARD_COUNT} cards, ${RICH_CARDS_PER_LIST * LIST_COUNT} rich card details`);
  console.log(`elapsed: ${Math.round(performance.now() - startedAt)}ms`);
} finally {
  await pool.end();
}
