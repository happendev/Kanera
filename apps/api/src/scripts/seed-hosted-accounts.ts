import {
  automations,
  boardMembers,
  boards,
  cards,
  clientGuestSeats,
  clients,
  lists,
  users,
  workspaceMembers,
  workspaces,
  type ClientBillingStatus,
  type ClientPlan,
  type ClientRole,
  type WorkspaceRole,
} from "@kanera/shared/schema";
import { asc, eq } from "drizzle-orm";
import { hashPassword } from "../auth/password.js";
import { db, pool } from "../db.js";
import { env } from "../env.js";
import { convertClientPlan } from "../lib/plan-conversion.js";

const SHARED_PASSWORD = "Abc12345";
const DAY_MS = 86_400_000;

type AccountUserSeed = {
  email: string;
  displayName: string;
  role: ClientRole;
  workspaceRole?: WorkspaceRole;
};

type OrgSeed = {
  name: string;
  plan: ClientPlan;
  billingStatus: ClientBillingStatus;
  currentPeriodEnd?: Date | null;
  seatLimit?: number;
  users: AccountUserSeed[];
  workspaces: Array<{ name: string; boardCount: number; automationCount?: number }>;
  cancelAfterSeed?: boolean;
};

function position(index: number): string {
  return `${(index + 1) * 1000}.0000000000`;
}

async function assertBlankDatabase(): Promise<void> {
  const existingClients = await db.$count(clients);
  if (existingClients > 0) {
    throw new Error("Hosted account seed expects a blank migrated database. Reset the DB before seeding.");
  }
}

async function createOrg(seed: OrgSeed, passwordHash: string): Promise<void> {
  const client = await db.transaction(async (tx) => {
    // Paid seed capacity mirrors the seeded users; trials are unlimited until checkout.
    const seatLimit = seed.plan === "paid"
      ? (seed.seatLimit ?? Math.max(1, seed.users.length))
      : (seed.seatLimit ?? seed.users.length);
    const [clientRow] = await tx
      .insert(clients)
      .values({
        name: seed.name,
        storageConfig: { kind: "local" },
        pushEnabled: true,
        plan: seed.plan,
        billingStatus: seed.billingStatus,
        currentPeriodEnd: seed.currentPeriodEnd ?? null,
        seatLimit,
      })
      .returning();

    const userRows = [];
    for (const [index, userSeed] of seed.users.entries()) {
      const [user] = await tx
        .insert(users)
        .values({
          clientId: clientRow!.id,
          clientRole: userSeed.role,
          email: userSeed.email,
          passwordHash,
          displayName: userSeed.displayName,
          timezone: "UTC",
          createdAt: new Date(Date.UTC(2026, 0, index + 1)),
        })
        .returning();
      userRows.push({ ...user!, workspaceRole: userSeed.workspaceRole ?? (userSeed.role === "member" ? "member" : "admin") });
    }

    const owner = userRows.find((user) => user.clientRole === "owner") ?? userRows[0];
    if (!owner) throw new Error(`Org ${seed.name} needs at least one user`);

    for (const [workspaceIndex, workspaceSeed] of seed.workspaces.entries()) {
      const [workspace] = await tx
        .insert(workspaces)
        .values({
          clientId: clientRow!.id,
          name: workspaceSeed.name,
          icon: workspaceIndex === 0 ? "layout-kanban" : "folder",
          accentColor: workspaceIndex === 0 ? "#2563eb" : "#64748b",
          createdAt: new Date(Date.UTC(2026, 1, workspaceIndex + 1)),
        })
        .returning();

      await tx.insert(workspaceMembers).values(
        userRows.map((user) => ({
          workspaceId: workspace!.id,
          userId: user.id,
          role: user.workspaceRole,
        })),
      );

      const [todoList] = await tx
        .insert(lists)
        .values({ workspaceId: workspace!.id, name: "To do", position: position(0), icon: "circle", color: "#64748b" })
        .returning();
      await tx.insert(lists).values({ workspaceId: workspace!.id, name: "Done", position: position(1), icon: "circle-check", color: "#16a34a" });

      for (let boardIndex = 0; boardIndex < workspaceSeed.boardCount; boardIndex++) {
        const [board] = await tx
          .insert(boards)
          .values({
            workspaceId: workspace!.id,
            name: `${workspaceSeed.name} Board ${boardIndex + 1}`,
            position: position(boardIndex),
            createdAt: new Date(Date.UTC(2026, 2, boardIndex + 1)),
          })
          .returning();

        await tx.insert(cards).values({
          listId: todoList!.id,
          boardId: board!.id,
          title: `Account fixture card ${boardIndex + 1}`,
          description: "Seeded for hosted plan and Account settings testing.",
          position: position(0),
          createdById: owner.id,
        });

        // Give every workspace member board access under the row-based model: admins are pinned
        // editors on every board; plain members get an editor row so they can open the board.
        await tx.insert(boardMembers).values(
          userRows.map((user) => ({
            boardId: board!.id,
            userId: user.id,
            role: "editor" as const,
            pinned: user.workspaceRole === "admin",
          })),
        );
      }

      for (let automationIndex = 0; automationIndex < (workspaceSeed.automationCount ?? 0); automationIndex++) {
        await tx.insert(automations).values({
          workspaceId: workspace!.id,
          enabled: true,
          position: position(automationIndex),
          triggerType: "card_enters_list",
          triggerListId: todoList!.id,
        });
      }
    }

    return clientRow!;
  });

  if (seed.cancelAfterSeed) {
    // Use the production conversion path so this fixture shows real downgrade artifacts: archived
    // workspaces/boards, disabled automations, and suspended members beyond the free caps.
    await convertClientPlan(client.id, { plan: "free", billingStatus: "canceled" });
  }
}

async function seedPaidExternalGuestFixture(): Promise<void> {
  const [guest] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, "guest-two-boards@external.test"))
    .limit(1);
  const [proOwner] = await db
    .select({ id: users.id, clientId: users.clientId })
    .from(users)
    .where(eq(users.email, "pro-owner@kanera.test"))
    .limit(1);
  if (!guest || !proOwner) {
    throw new Error("Paid external guest fixture requires the Pro owner and external guest accounts.");
  }

  const proBoards = await db
    .select({ id: boards.id })
    .from(boards)
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(eq(workspaces.clientId, proOwner.clientId))
    .orderBy(asc(boards.position))
    .limit(2);
  if (proBoards.length < 2) throw new Error("Paid external guest fixture requires at least two Pro boards.");

  // Keep the user's own org intact while making them a cross-org board guest in the host org.
  await db
    .insert(boardMembers)
    .values(proBoards.map((board) => ({ boardId: board.id, userId: guest.id, role: "editor" as const })))
    .onConflictDoNothing();
  await db
    .insert(clientGuestSeats)
    .values({ clientId: proOwner.clientId, userId: guest.id, createdById: proOwner.id })
    .onConflictDoNothing();
}

function buildSeeds(): OrgSeed[] {
  const trialEndsAt = new Date(Date.now() + env.HOSTED_TRIAL_DAYS * DAY_MS);
  return [
    {
      name: "Trial Account Testing",
      plan: "paid",
      billingStatus: "trialing",
      currentPeriodEnd: trialEndsAt,
      users: [{ email: "trial-owner@kanera.test", displayName: "Trial Owner", role: "owner" }],
      workspaces: [{ name: "Trial Workspace", boardCount: 2, automationCount: 1 }],
    },
    {
      name: "Pro Account Testing",
      plan: "paid",
      billingStatus: "active",
      seatLimit: 4,
      users: [
        { email: "pro-owner@kanera.test", displayName: "Pro Owner", role: "owner" },
        { email: "pro-admin@kanera.test", displayName: "Pro Admin", role: "admin", workspaceRole: "admin" },
        { email: "pro-member@kanera.test", displayName: "Pro Member", role: "member" },
      ],
      workspaces: [{ name: "Pro Workspace", boardCount: 5, automationCount: 2 }],
    },
    {
      name: "External Guest Testing",
      plan: "paid",
      billingStatus: "active",
      users: [{ email: "guest-two-boards@external.test", displayName: "Two Board Guest", role: "owner" }],
      workspaces: [{ name: "Guest Private Workspace", boardCount: 1 }],
    },
    {
      name: "Free Account Testing",
      plan: "free",
      billingStatus: "none",
      users: [
        { email: "free-owner@kanera.test", displayName: "Free Owner", role: "owner" },
        ...Array.from({ length: Math.max(0, env.HOSTED_FREE_MAX_ORG_MEMBERS - 1) }, (_, index) => ({
          email: `free-member-${index + 1}@kanera.test`,
          displayName: `Free Member ${index + 1}`,
          role: "member" as const,
        })),
      ],
      workspaces: [{ name: "Free Workspace", boardCount: env.HOSTED_FREE_MAX_BOARDS, automationCount: env.HOSTED_FREE_MAX_ENABLED_AUTOMATIONS }],
    },
    {
      name: "Canceled Over Limit Testing",
      plan: "paid",
      billingStatus: "active",
      users: [
        { email: "canceled-owner@kanera.test", displayName: "Canceled Owner", role: "owner" },
        ...Array.from({ length: env.HOSTED_FREE_MAX_ORG_MEMBERS + 2 }, (_, index) => ({
          email: `canceled-member-${index + 1}@kanera.test`,
          displayName: `Canceled Member ${index + 1}`,
          role: "member" as const,
        })),
      ],
      workspaces: [
        { name: "Kept Workspace", boardCount: env.HOSTED_FREE_MAX_BOARDS + 2, automationCount: env.HOSTED_FREE_MAX_ENABLED_AUTOMATIONS + 2 },
        { name: "Archived Workspace", boardCount: 2, automationCount: 1 },
      ],
      cancelAfterSeed: true,
    },
  ];
}

async function main(): Promise<void> {
  if (env.KANERA_DEPLOYMENT_MODE !== "hosted") {
    throw new Error("Run this seed with KANERA_DEPLOYMENT_MODE=hosted.");
  }

  await assertBlankDatabase();
  const passwordHash = await hashPassword(SHARED_PASSWORD);
  for (const seed of buildSeeds()) {
    await createOrg(seed, passwordHash);
  }
  await seedPaidExternalGuestFixture();

  console.log("hosted account seed complete");
  console.log(`shared password: ${SHARED_PASSWORD}`);
  console.log("owners:");
  console.log("  trial-owner@kanera.test  - trialing");
  console.log("  pro-owner@kanera.test    - active Pro");
  console.log("  pro-admin@kanera.test    - Pro admin, cannot cancel");
  console.log("  guest-two-boards@external.test - external guest already on 2 Pro boards using one paid seat");
  console.log("  free-owner@kanera.test   - free at member/board caps");
  console.log("  canceled-owner@kanera.test - canceled with downgrade artifacts");
  console.log("guest seat test:");
  console.log("  add guest-two-boards@external.test to Pro Workspace Board 3 to verify that the existing paid seat is reused");
}

try {
  await main();
} finally {
  await pool.end();
}
