import "../../test/setup.integration.js";
import { activityEvents, boards, cardGitHubPulls, cards, githubAppInstallations, lists } from "@kanera/shared/schema";
import type { CardGitHubPullsResponse } from "@kanera/shared/dto";
import { and, asc, eq, like } from "drizzle-orm";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, test } from "node:test";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { buildIntegrationServer } from "../../test/integration.js";
import { signupOwner } from "../../test/api-fixtures.js";

/**
 * Failure modes these cover. E2E has no GitHub to deliver signed webhooks, so the receiver is
 * exercised here:
 * - an unsigned or forged delivery moves a card's pull request state;
 * - a pull request from a fork of a public repository links itself to the organisation's cards;
 * - a card key resolves in another organisation that happens to use the same prefix;
 * - GitHub's redeliveries and out-of-order deliveries duplicate activity or roll a merged pull
 *   request back to open;
 * - an uninstall or repository change on GitHub leaves the organisation's binding stale.
 */

const SECRET = "github-webhook-test-secret";
const originalEnv = {
  appId: env.GITHUB_APP_ID,
  appSlug: env.GITHUB_APP_SLUG,
  privateKey: env.GITHUB_APP_PRIVATE_KEY,
  webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
};

afterEach(() => {
  env.GITHUB_APP_ID = originalEnv.appId;
  env.GITHUB_APP_SLUG = originalEnv.appSlug;
  env.GITHUB_APP_PRIVATE_KEY = originalEnv.privateKey;
  env.GITHUB_APP_WEBHOOK_SECRET = originalEnv.webhookSecret;
});

function configureApp() {
  // Only the webhook secret is read on this path; the App credentials just mark it env-configured.
  env.GITHUB_APP_ID = "1";
  env.GITHUB_APP_SLUG = "kanera-test";
  env.GITHUB_APP_PRIVATE_KEY = "unused";
  env.GITHUB_APP_WEBHOOK_SECRET = SECRET;
}

type App = Awaited<ReturnType<typeof buildIntegrationServer>>;

async function seedOrg(app: App, name: string, installationId: string) {
  const owner = await signupOwner(app, { orgName: `Org ${name}`, email: `owner-${name}@example.com`, displayName: "Owner" });
  const created = await app.inject({ method: "POST", url: "/workspaces", headers: owner.auth, payload: { name: "Delivery" } });
  assert.equal(created.statusCode, 201, created.body);
  const workspaceId = created.json<{ id: string }>().id;
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspaceId)).orderBy(asc(lists.position)).limit(1);
  const [board] = await db.insert(boards).values({ workspaceId, name: "Main", position: "1000.0000000000" }).returning();
  assert.ok(list && board);
  const [card] = await db.insert(cards)
    .values({ listId: list.id, boardId: board.id, title: "Fix login", position: "1000.0000000000", createdById: owner.user.id })
    .returning();
  assert.ok(card);
  await db.insert(githubAppInstallations).values({
    clientId: owner.user.clientId,
    installationId,
    accountLogin: `acme-${name}`,
    accountType: "Organization",
    repositorySelection: "selected",
    repositories: [{ owner: `acme-${name}`, name: "api", fullName: `acme-${name}/api`, private: true }],
  });
  return { owner, card, repo: `acme-${name}/api` };
}

function pullPayload(opts: {
  installationId: string;
  repo: string;
  headRef: string;
  title?: string;
  body?: string | null;
  state?: "open" | "closed";
  draft?: boolean;
  mergedAt?: string | null;
  updatedAt: string;
  headRepo?: string | null;
}) {
  return {
    action: "opened",
    installation: { id: Number(opts.installationId) },
    repository: { full_name: opts.repo },
    pull_request: {
      number: 12,
      title: opts.title ?? "Fix login redirect",
      body: opts.body ?? null,
      html_url: `https://github.com/${opts.repo}/pull/12`,
      state: opts.state ?? "open",
      draft: opts.draft ?? false,
      merged_at: opts.mergedAt ?? null,
      updated_at: opts.updatedAt,
      additions: 10,
      deletions: 2,
      head: { ref: opts.headRef, repo: opts.headRepo === undefined ? { full_name: opts.repo } : opts.headRepo === null ? null : { full_name: opts.headRepo } },
      base: { repo: { full_name: opts.repo } },
    },
  };
}

function deliver(app: App, event: string, payload: unknown, secret = SECRET) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return app.inject({
    method: "POST",
    url: "/integrations/github/webhook",
    headers: { "content-type": "application/json", "x-github-event": event, "x-hub-signature-256": signature },
    payload: body,
  });
}

async function pullActivity(cardId: string) {
  return db.select({ action: activityEvents.action, payload: activityEvents.payload }).from(activityEvents)
    .where(and(eq(activityEvents.entityId, cardId), like(activityEvents.action, "githubPull:%")))
    .orderBy(asc(activityEvents.createdAt));
}

void test("a signed pull request links the card it names, ignores redeliveries and never rolls back", async () => {
  configureApp();
  const app = await buildIntegrationServer();
  try {
    const { owner, card, repo } = await seedOrg(app, "link", "9101");
    const branch = `${card.key.toLowerCase()}-fix-login`;

    const forged = await deliver(app, "pull_request", pullPayload({ installationId: "9101", repo, headRef: branch, updatedAt: "2026-10-27T10:00:00Z" }), "wrong-secret");
    assert.equal(forged.statusCode, 401);
    assert.equal((await pullActivity(card.id)).length, 0);

    const opened = pullPayload({ installationId: "9101", repo, headRef: branch, updatedAt: "2026-10-27T10:00:00Z" });
    assert.equal((await deliver(app, "pull_request", opened)).statusCode, 202);
    assert.equal((await deliver(app, "pull_request", opened)).statusCode, 202);
    assert.deepEqual((await pullActivity(card.id)).map((row) => row.action), ["githubPull:linked"]);

    const merged = pullPayload({ installationId: "9101", repo, headRef: branch, state: "closed", mergedAt: "2026-10-27T11:00:00Z", updatedAt: "2026-10-27T11:00:00Z" });
    assert.equal((await deliver(app, "pull_request", merged)).statusCode, 202);
    // GitHub delivered an older snapshot late: it must not reopen the merged pull request.
    assert.equal((await deliver(app, "pull_request", opened)).statusCode, 202);

    const activity = await pullActivity(card.id);
    assert.deepEqual(activity.map((row) => row.action), ["githubPull:linked", "githubPull:stateChanged"]);
    assert.equal((activity[1]!.payload as { state: string; fromState: string }).state, "merged");
    assert.equal((activity[1]!.payload as { fromState: string }).fromState, "open");

    const listed = await app.inject({ method: "GET", url: `/cards/${card.id}/github-pulls`, headers: owner.auth });
    assert.equal(listed.statusCode, 200, listed.body);
    const { pulls } = listed.json<CardGitHubPullsResponse>();
    assert.equal(pulls.length, 1);
    assert.equal(pulls[0]!.state, "merged");
    assert.equal(pulls[0]!.number, 12);
  } finally {
    await app.close();
  }
});

void test("fork pull requests and other organisations' keys never link a card", async () => {
  configureApp();
  const app = await buildIntegrationServer();
  try {
    const mine = await seedOrg(app, "fork-mine", "9201");
    const theirs = await seedOrg(app, "fork-theirs", "9202");

    const fromFork = pullPayload({ installationId: "9201", repo: mine.repo, headRef: "patch-1", title: `Fixes ${mine.card.key}`, headRepo: "stranger/api", updatedAt: "2026-10-27T10:00:00Z" });
    assert.equal((await deliver(app, "pull_request", fromFork)).statusCode, 202);
    const fromDeletedFork = pullPayload({ installationId: "9201", repo: mine.repo, headRef: "patch-2", title: `Fixes ${mine.card.key}`, headRepo: null, updatedAt: "2026-10-27T10:00:00Z" });
    assert.equal((await deliver(app, "pull_request", fromDeletedFork)).statusCode, 202);
    assert.equal((await db.select().from(cardGitHubPulls).where(eq(cardGitHubPulls.cardId, mine.card.id))).length, 0);

    // Both organisations' first workspace is "Delivery", but prefixes are per organisation: the
    // key from org A's pull request resolves only in org A.
    const ownRepo = pullPayload({ installationId: "9201", repo: mine.repo, headRef: "main-work", title: `Fixes ${theirs.card.key}`, updatedAt: "2026-10-27T10:00:00Z" });
    assert.equal((await deliver(app, "pull_request", ownRepo)).statusCode, 202);
    const linked = await db.select({ cardId: cardGitHubPulls.cardId, clientId: cardGitHubPulls.clientId }).from(cardGitHubPulls);
    assert.ok(linked.every((row) => row.cardId !== theirs.card.id));
    assert.ok(linked.every((row) => row.clientId !== theirs.owner.user.clientId));

    const forbidden = await app.inject({ method: "GET", url: `/cards/${mine.card.id}/github-pulls`, headers: theirs.owner.auth });
    assert.notEqual(forbidden.statusCode, 200);
  } finally {
    await app.close();
  }
});

void test("installation webhooks keep the organisation's binding current", async () => {
  configureApp();
  const app = await buildIntegrationServer();
  try {
    const { owner } = await seedOrg(app, "install", "9301");
    const changed = await deliver(app, "installation_repositories", {
      action: "added",
      installation: { id: 9301, repository_selection: "selected" },
      repositories_added: [{ full_name: "acme-install/web", name: "web", private: false }],
      repositories_removed: [{ full_name: "acme-install/api", name: "api", private: true }],
    });
    assert.equal(changed.statusCode, 202);
    const [row] = await db.select().from(githubAppInstallations).where(eq(githubAppInstallations.clientId, owner.user.clientId));
    assert.deepEqual(row?.repositories.map((repo) => repo.fullName), ["acme-install/web"]);

    assert.equal((await deliver(app, "installation", { action: "deleted", installation: { id: 9301 } })).statusCode, 202);
    assert.equal((await db.select().from(githubAppInstallations).where(eq(githubAppInstallations.clientId, owner.user.clientId))).length, 0);
  } finally {
    await app.close();
  }
});

void test("webhooks are refused while no secret is configured", async () => {
  configureApp();
  env.GITHUB_APP_WEBHOOK_SECRET = undefined;
  const app = await buildIntegrationServer();
  try {
    const response = await deliver(app, "ping", { zen: "Keep it logically awesome." });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
  }
});
