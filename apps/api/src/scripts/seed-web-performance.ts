import {
  boardMembers,
  boards,
  cardAttachments,
  cardAssignees,
  cardChecklistItems,
  cardChecklists,
  cardCustomFieldValues,
  cardLabelAssignments,
  cardLabels,
  cards,
  clients,
  clientMembers,
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
import { allocateCardKeys } from "../lib/card-keys.js";

const PERF_CLIENT_ID = "70000000-0000-4000-8000-000000000001";
const PERF_WORKSPACE_ID = "70000000-0000-4000-8000-000000000100";
const PERF_BOARD_ID = "70000000-0000-4000-8000-000000000200";
const PERF_USER_ID = "70000000-0000-4000-8000-000000000010";
const PERF_CLIENT_NAME = "[LOCAL PERF] Kanera Web Benchmark";
const PERF_WORKSPACE_NAME = "[LOCAL PERF] Scale Lab";
const PERF_EMAIL = "perf@kanera.local";
const PERF_PASSWORD = "Perf12345";

/**
 * Fixture shape is env-tunable so one script can serve both the historical single-user web
 * baseline and larger API load tests. Defaults reproduce the original 1,000-card / 40-board
 * fixture exactly, so previously captured `benchmarks/web/results` runs stay comparable.
 */
function envCount(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

const CARD_COUNT = envCount("PERF_CARD_COUNT", 1_000, 50_000);
const LIST_COUNT = 20;
const BOARD_COUNT = envCount("PERF_BOARD_COUNT", 40, 500);
// Extra standard workspaces and a wider membership exist so `loadAccessibleBoards` fan-out,
// `/work/catalog` breadth, and multi-page work cursors are exercised; the original fixture had a
// single workspace and six members, which made every cross-workspace query trivially small.
const WORKSPACE_COUNT = envCount("PERF_WORKSPACE_COUNT", 4, 50);
const MEMBER_COUNT = envCount("PERF_MEMBER_COUNT", 20, 200);
const SECONDARY_BOARDS_PER_WORKSPACE = envCount("PERF_SECONDARY_BOARDS", 3, 100);
const SECONDARY_LIST_COUNT = 8;
const SECONDARY_CARDS_PER_WORKSPACE = envCount("PERF_SECONDARY_CARDS", 200, 20_000);
const RICH_CARDS_PER_LIST = 3;
const COVER_EVERY_NTH_CARD_IN_LIST = 2;
const EXPECTED_COVER_COUNT = LIST_COUNT * Math.ceil((CARD_COUNT / LIST_COUNT) / COVER_EVERY_NTH_CARD_IN_LIST);
const INSERT_CHUNK_SIZE = 500;

const COVER_ASSETS = [
  { fileName: "benchmark-cover-wide.svg", url: "/assets/perf/benchmark-cover-wide.svg", width: 1200, height: 420, color: "#0b6f69" },
  { fileName: "benchmark-cover-square.svg", url: "/assets/perf/benchmark-cover-square.svg", width: 900, height: 900, color: "#c85f38" },
  { fileName: "benchmark-cover-tall.svg", url: "/assets/perf/benchmark-cover-tall.svg", width: 700, height: 1200, color: "#285783" },
] as const;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface MemberSeed {
  id: string;
  email: string;
  displayName: string;
  clientRole: "owner" | "member";
  workspaceRole: "admin" | "member";
}

// The first six members keep their original ids, emails, and roles so existing local logins and
// captured benchmark results keep referring to the same people. Anything above six is generated.
const NAMED_MEMBER_SEEDS: MemberSeed[] = [
  { id: PERF_USER_ID, email: PERF_EMAIL, displayName: "Amelia Benchmark", clientRole: "owner", workspaceRole: "admin" },
  { id: "70000000-0000-4000-8000-000000000011", email: "marcus.perf@kanera.local", displayName: "Marcus Chen", clientRole: "member", workspaceRole: "admin" },
  { id: "70000000-0000-4000-8000-000000000012", email: "priya.perf@kanera.local", displayName: "Priya Nair", clientRole: "member", workspaceRole: "member" },
  { id: "70000000-0000-4000-8000-000000000013", email: "ben.perf@kanera.local", displayName: "Ben Carter", clientRole: "member", workspaceRole: "member" },
  { id: "70000000-0000-4000-8000-000000000014", email: "nina.perf@kanera.local", displayName: "Nina Alvarez", clientRole: "member", workspaceRole: "member" },
  { id: "70000000-0000-4000-8000-000000000015", email: "zoe.perf@kanera.local", displayName: "Zoe Williams", clientRole: "member", workspaceRole: "member" },
];

const GENERATED_FIRST_NAMES = [
  "Ana", "Owen", "Lena", "Theo", "Maya", "Ivan", "Ruth", "Kai", "Nora", "Sami",
  "Iris", "Liam", "Eve", "Noel", "Sara", "Dev", "Tara", "Hugo", "Mira", "Otis",
];
const GENERATED_LAST_NAMES = [
  "Okafor", "Lindqvist", "Ferreira", "Novak", "Kaur", "Petrov", "Bello", "Tanaka",
  "Costa", "Meyer", "Haddad", "Rossi", "Kowalski", "Dlamini", "Ivanov", "Silva",
];

function buildMemberSeeds(total: number): MemberSeed[] {
  const seeds = NAMED_MEMBER_SEEDS.slice(0, total);
  for (let index = seeds.length; index < total; index += 1) {
    const first = GENERATED_FIRST_NAMES[index % GENERATED_FIRST_NAMES.length]!;
    const last = GENERATED_LAST_NAMES[index % GENERATED_LAST_NAMES.length]!;
    const suffix = String(index).padStart(3, "0");
    seeds.push({
      // Deterministic ids keep repeated seeding idempotent and make fixture rows recognisable.
      id: `70000000-0000-4000-8000-001${String(index).padStart(9, "0")}`,
      email: `member${suffix}.perf@kanera.local`,
      displayName: `${first} ${last}`,
      clientRole: "member",
      // A couple of extra admins exercise admin-implicit board access without making everyone one.
      workspaceRole: index % 7 === 0 ? "admin" : "member",
    });
  }
  return seeds;
}

const MEMBER_SEEDS = buildMemberSeeds(MEMBER_COUNT);

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

interface SecondarySummary { workspaces: number; boards: number; cards: number }

async function replaceFixture(tx: Tx): Promise<SecondarySummary> {
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
    activeClientId: PERF_CLIENT_ID,
    email: member.email,
    emailVerifiedAt: createdAt,
    passwordHash,
    displayName: member.displayName,
    timezone: index % 2 === 0 ? "Europe/London" : "America/New_York",
    createdAt,
    updatedAt: now,
  })));
  await tx.insert(clientMembers).values(MEMBER_SEEDS.map((member) => ({
    clientId: PERF_CLIENT_ID,
    userId: member.id,
    clientRole: member.clientRole,
    addedAt: createdAt,
  })));
  await tx.update(clients).set({ createdByUserId: PERF_USER_ID }).where(eq(clients.id, PERF_CLIENT_ID));

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
    backgroundGradient: index === 0 ? "lavender" : null,
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
  const attachmentRows: (typeof cardAttachments.$inferInsert)[] = [];
  const richCardIds: string[] = [];
  const cardIdentities = await allocateCardKeys(tx, PERF_WORKSPACE_ID, CARD_COUNT);

  for (let cardIndex = 0; cardIndex < CARD_COUNT; cardIndex += 1) {
    const listIndex = cardIndex % LIST_COUNT;
    const listPosition = Math.floor(cardIndex / LIST_COUNT);
    const rich = listPosition < RICH_CARDS_PER_LIST;
    const cardId = randomUUID();
    const hasCover = listPosition % COVER_EVERY_NTH_CARD_IN_LIST === 0;
    const coverAttachmentId = hasCover ? randomUUID() : null;
    const sequence = String(cardIndex + 1).padStart(4, "0");
    if (rich) richCardIds.push(cardId);
    cardRows.push({
      ...cardIdentities[cardIndex]!,
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
      coverAttachmentId,
      createdAt: new Date(createdAt.getTime() + cardIndex * 60_000),
      updatedAt: now,
    });

    if (coverAttachmentId) {
      const asset = COVER_ASSETS[(listPosition + listIndex) % COVER_ASSETS.length]!;
      // Each URL is unique so browser caching cannot collapse hundreds of cover-load callbacks
      // into three resource entries. The underlying files stay tiny, local, and deterministic.
      const assetUrl = `${asset.url}?card=${sequence}`;
      attachmentRows.push({
        id: coverAttachmentId,
        cardId,
        clientId: PERF_CLIENT_ID,
        uploadedById: PERF_USER_ID,
        fileName: asset.fileName,
        mimeType: "image/svg+xml",
        byteSize: 2_048,
        fileKey: `local-perf/${sequence}/${asset.fileName}`,
        url: assetUrl,
        coverImageUrl: assetUrl,
        coverImageFileKey: `local-perf/${sequence}/${asset.fileName}`,
        coverImageWidth: asset.width,
        coverImageHeight: asset.height,
        coverImageColor: asset.color,
        source: "attachment",
        createdAt,
      });
    }

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
  await insertChunks(attachmentRows, (chunk) => tx.insert(cardAttachments).values(chunk));
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

  return await insertSecondaryWorkspaces(tx, createdAt, now);
}


const SECONDARY_LIST_NAMES = ["Intake", "Shaping", "Building", "Review", "Blocked", "Shipping", "Watching", "Archive soon"];
const SECONDARY_WORKSPACE_NAMES = [
  "Client Delivery", "Platform Group", "Growth Studio", "Support Desk", "Data Practice",
  "Mobile Guild", "Security Office", "Partnerships", "Field Ops", "Research Lab",
];

/**
 * Extra standard workspaces with their own lists, fields, boards and cards. These exist purely so
 * cross-workspace read paths have realistic breadth: `loadAccessibleBoards` fan-out, `/work/catalog`,
 * Global Work cursors that must page across boards, and the app shell's per-workspace requests.
 * Content here is deliberately lighter than the primary board so seeding stays fast.
 */
async function insertSecondaryWorkspaces(tx: Tx, createdAt: Date, now: Date): Promise<{ workspaces: number; boards: number; cards: number }> {
  const extraWorkspaces = WORKSPACE_COUNT - 1;
  if (extraWorkspaces < 1) return { workspaces: 0, boards: 0, cards: 0 };

  let boardTotal = 0;
  let cardTotal = 0;

  for (let workspaceIndex = 0; workspaceIndex < extraWorkspaces; workspaceIndex += 1) {
    const workspaceId = randomUUID();
    const label = SECONDARY_WORKSPACE_NAMES[workspaceIndex % SECONDARY_WORKSPACE_NAMES.length]!;
    // Names must be distinct within the organisation: the workspace insert trigger derives the card
    // key prefix from the name and only disambiguates collisions with a numeric suffix.
    const name = `[LOCAL PERF] ${label} ${String(workspaceIndex + 2).padStart(2, "0")}`;
    await tx.insert(workspaces).values({
      id: workspaceId,
      clientId: PERF_CLIENT_ID,
      name,
      icon: "layout-kanban",
      accentColor: LABEL_SEEDS[workspaceIndex % LABEL_SEEDS.length]![1],
      createdAt,
      updatedAt: now,
    });
    await tx.insert(workspaceMembers).values(MEMBER_SEEDS.map((member) => ({
      workspaceId,
      userId: member.id,
      role: member.workspaceRole,
      addedAt: createdAt,
    })));

    const listRows: (typeof lists.$inferInsert)[] = Array.from({ length: SECONDARY_LIST_COUNT }, (_, index) => ({
      id: randomUUID(),
      workspaceId,
      name: SECONDARY_LIST_NAMES[index % SECONDARY_LIST_NAMES.length]!,
      icon: ["inbox", "bulb", "progress", "eye", "ban", "rocket", "radar", "archive"][index % 8],
      color: LABEL_SEEDS[(index + workspaceIndex) % LABEL_SEEDS.length]![1],
      position: position(index),
      createdAt,
      updatedAt: now,
    }));
    await tx.insert(lists).values(listRows);

    const labelRows: (typeof cardLabels.$inferInsert)[] = LABEL_SEEDS.slice(0, 4).map(([labelName, color], index) => ({
      id: randomUUID(), workspaceId, name: labelName, color, position: position(index), createdAt, updatedAt: now,
    }));
    await tx.insert(cardLabels).values(labelRows);

    const fieldRows: (typeof customFields.$inferInsert)[] = [
      { id: randomUUID(), workspaceId, name: "Priority", icon: "flag", type: "select", position: position(0), showOnCard: true },
      { id: randomUUID(), workspaceId, name: "Effort", icon: "ruler", type: "number", position: position(1), showOnCard: true },
    ];
    await tx.insert(customFields).values(fieldRows);
    const optionRows: (typeof customFieldOptions.$inferInsert)[] = ["Urgent", "High", "Medium", "Low"].map((optionLabel, index) => ({
      id: randomUUID(), fieldId: fieldRows[0]!.id!, label: optionLabel, color: LABEL_SEEDS[index]![1], position: position(index), createdAt, updatedAt: now,
    }));
    await tx.insert(customFieldOptions).values(optionRows);

    const boardRows: (typeof boards.$inferInsert)[] = Array.from({ length: SECONDARY_BOARDS_PER_WORKSPACE }, (_, index) => ({
      id: randomUUID(),
      workspaceId,
      name: `${label} board ${String(index + 1).padStart(2, "0")}`,
      icon: "layout-kanban",
      iconColor: LABEL_SEEDS[(index + workspaceIndex) % LABEL_SEEDS.length]![1],
      position: position(index),
      createdAt,
      updatedAt: now,
    }));
    await tx.insert(boards).values(boardRows);
    boardTotal += boardRows.length;

    const adminMembers = MEMBER_SEEDS.filter((member) => member.workspaceRole === "admin");
    await tx.insert(boardMembers).values(boardRows.flatMap((board) => adminMembers.map((member) => ({
      boardId: board.id!,
      userId: member.id,
      role: "editor" as const,
      pinned: false,
      addedAt: createdAt,
    }))));

    const identities = await allocateCardKeys(tx, workspaceId, SECONDARY_CARDS_PER_WORKSPACE);
    const cardRows: (typeof cards.$inferInsert)[] = [];
    const assigneeRows: (typeof cardAssignees.$inferInsert)[] = [];
    const labelAssignmentRows: (typeof cardLabelAssignments.$inferInsert)[] = [];
    const fieldValueRows: (typeof cardCustomFieldValues.$inferInsert)[] = [];

    for (let cardIndex = 0; cardIndex < SECONDARY_CARDS_PER_WORKSPACE; cardIndex += 1) {
      const cardId = randomUUID();
      const board = boardRows[cardIndex % boardRows.length]!;
      const list = listRows[cardIndex % listRows.length]!;
      // A mix of open, completed, and archived cards so partial indexes and the completed/inactive
      // work filters see representative selectivity instead of an all-open scope.
      const completed = cardIndex % 5 === 0;
      const archived = cardIndex % 17 === 0;
      cardRows.push({
        ...identities[cardIndex]!,
        id: cardId,
        boardId: board.id!,
        listId: list.id!,
        title: `${label} item ${String(cardIndex + 1).padStart(4, "0")}: ${["scoping", "handover", "regression", "rollout", "audit"][cardIndex % 5]}`,
        description: `Cross-workspace fixture card used to give portfolio, catalog, and work-cursor queries realistic breadth across ${label}.`,
        position: position(Math.floor(cardIndex / boardRows.length)),
        dueDateLocalDate: cardIndex % 3 === 0 ? localDate((cardIndex % 40) - 10) : null,
        dueDateSlot: cardIndex % 3 === 0 ? "endOfWorkDay" : null,
        dueDateTimezone: cardIndex % 3 === 0 ? "Europe/London" : null,
        completedAt: completed ? new Date(now.getTime() - (cardIndex % 30) * 86_400_000) : null,
        archivedAt: archived ? new Date(now.getTime() - (cardIndex % 20) * 86_400_000) : null,
        createdById: MEMBER_SEEDS[cardIndex % MEMBER_SEEDS.length]!.id,
        createdAt: new Date(createdAt.getTime() + cardIndex * 120_000),
        updatedAt: new Date(now.getTime() - (cardIndex % 90) * 86_400_000),
      });

      const assigned = new Set<string>();
      // Keep roughly a third of cross-workspace work on the benchmark login so its Global Work
      // queries actually page, while the rest spreads across the wider membership.
      if (cardIndex % 3 === 0) assigned.add(PERF_USER_ID);
      assigned.add(MEMBER_SEEDS[(cardIndex + workspaceIndex) % MEMBER_SEEDS.length]!.id);
      assigneeRows.push(...Array.from(assigned, (userId) => ({ cardId, userId, assignedAt: createdAt })));

      labelAssignmentRows.push({ cardId, labelId: labelRows[cardIndex % labelRows.length]!.id!, assignedAt: createdAt });
      fieldValueRows.push(
        { cardId, fieldId: fieldRows[0]!.id!, valueOptionIds: [optionRows[cardIndex % optionRows.length]!.id!], updatedAt: now },
        { cardId, fieldId: fieldRows[1]!.id!, valueNumber: String((cardIndex % 8) + 1), updatedAt: now },
      );
    }

    await insertChunks(cardRows, (chunk) => tx.insert(cards).values(chunk));
    await insertChunks(assigneeRows, (chunk) => tx.insert(cardAssignees).values(chunk));
    await insertChunks(labelAssignmentRows, (chunk) => tx.insert(cardLabelAssignments).values(chunk));
    await insertChunks(fieldValueRows, (chunk) => tx.insert(cardCustomFieldValues).values(chunk));
    cardTotal += cardRows.length;
  }

  return { workspaces: extraWorkspaces, boards: boardTotal, cards: cardTotal };
}

assertLocalOnly();
try {
  const startedAt = performance.now();
  const secondary = await db.transaction(replaceFixture);
  console.log("local web performance fixture ready");
  console.log(`login: ${PERF_EMAIL} / ${PERF_PASSWORD}`);
  console.log(`workspace: ${PERF_WORKSPACE_ID}`);
  console.log(`primary board: ${PERF_BOARD_ID}`);
  console.log(`shape: ${BOARD_COUNT} boards, ${LIST_COUNT} lists, ${CARD_COUNT} cards, ${EXPECTED_COVER_COUNT} covers, ${RICH_CARDS_PER_LIST * LIST_COUNT} rich card details, ${MEMBER_SEEDS.length} members`);
  console.log(`cross-workspace: ${secondary.workspaces} extra workspaces, ${secondary.boards} extra boards, ${secondary.cards} extra cards`);
  console.log(`elapsed: ${Math.round(performance.now() - startedAt)}ms`);
} finally {
  await pool.end();
}
