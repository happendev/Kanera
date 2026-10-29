import { cardKeysInPullRequest } from "@kanera/shared/card-links";
import type { dto } from "@kanera/shared";
import {
  ACTIVITY_ACTION,
  cardGitHubPulls,
  cards,
  clients,
  githubApp,
  githubAppInstallations,
  type ActivityEvent,
  type CardGitHubPullState,
  type GitHubInstalledRepository,
} from "@kanera/shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "../db.js";
import { env } from "../env.js";
import { emitActivityFeedItem, recordActivity } from "./activity.js";
import { resolveCardKey } from "./card-keys.js";
import { githubAppConfigured } from "./github-app.js";
import { decryptSecret } from "./secrets.js";

/**
 * The secret GitHub signs webhooks with. It belongs to whichever App the deployment uses: env
 * credentials win over the manifest bootstrap row (as in `loadDeploymentCredentials`), so a stale
 * bootstrap row never authenticates deliveries for an env-configured App.
 */
export async function githubWebhookSecret(): Promise<string | null> {
  if (githubAppConfigured()) return env.GITHUB_APP_WEBHOOK_SECRET ?? null;
  const [row] = await db.select({ encrypted: githubApp.encryptedWebhookSecret }).from(githubApp).limit(1);
  return row?.encrypted ? decryptSecret(row.encrypted) : null;
}

/** Checks GitHub's `X-Hub-Signature-256` header against the raw request body. */
export function verifyGitHubSignature(secret: string, rawBody: string, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function pullState(pull: dto.GitHubPullRequestWebhook["pull_request"]): CardGitHubPullState {
  if (pull.merged_at) return "merged";
  if (pull.state === "closed") return "closed";
  return pull.draft ? "draft" : "open";
}

type LinkedCard = { cardId: string; boardId: string; workspaceId: string };

/**
 * Records a `pull_request` delivery against every card it names and every card it is already
 * linked to. Returns how many cards changed.
 *
 * Safe to repeat: GitHub redelivers and may deliver out of order. A link's activity row is written
 * only when the link is created or its state actually changes, and a snapshot older than the
 * stored one is ignored. Deliveries for one pull request are serialized by an advisory lock so two
 * concurrent first deliveries cannot both record "linked".
 */
export async function applyGitHubPullRequestWebhook(payload: dto.GitHubPullRequestWebhook): Promise<number> {
  const pull = payload.pull_request;
  // Anyone can open a pull request from a fork against a public repository, so a fork's branch,
  // title or body must not be able to touch the organisation's cards.
  if (pull.head.repo?.full_name !== pull.base.repo.full_name) return 0;

  const [installation] = await db
    .select({ clientId: githubAppInstallations.clientId, routeKey: clients.routeKey })
    .from(githubAppInstallations)
    .innerJoin(clients, eq(clients.id, githubAppInstallations.clientId))
    .where(eq(githubAppInstallations.installationId, String(payload.installation.id)))
    .limit(1);
  if (!installation) return 0;

  const repoFullName = pull.base.repo.full_name;
  const state = pullState(pull);
  const githubUpdatedAt = new Date(pull.updated_at);
  const snapshot = {
    title: pull.title.slice(0, 500),
    url: pull.html_url,
    headRef: pull.head.ref.slice(0, 255),
    state,
    additions: pull.additions ?? null,
    deletions: pull.deletions ?? null,
    githubUpdatedAt,
  };
  const activityPayload = { repoFullName, number: pull.number, title: snapshot.title, url: snapshot.url, state };

  const recorded = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`github-pull:${installation.clientId}:${repoFullName}#${pull.number}`}))`);

    const existing = await tx
      .select({ link: cardGitHubPulls, boardId: cards.boardId, workspaceId: cards.workspaceId })
      .from(cardGitHubPulls)
      .innerJoin(cards, eq(cards.id, cardGitHubPulls.cardId))
      .where(and(
        eq(cardGitHubPulls.clientId, installation.clientId),
        eq(cardGitHubPulls.repoFullName, repoFullName),
        eq(cardGitHubPulls.number, pull.number),
      ));
    const existingCardIds = new Set(existing.map((row) => row.link.cardId));

    const named = new Map<string, LinkedCard>();
    for (const key of cardKeysInPullRequest({ headRef: pull.head.ref, title: pull.title, body: pull.body ?? null })) {
      const card = await resolveCardKey(tx, installation.routeKey, key);
      if (card && !existingCardIds.has(card.id)) named.set(card.id, { cardId: card.id, boardId: card.boardId, workspaceId: card.workspaceId });
    }

    const activities: { boardId: string; cardId: string; activity: ActivityEvent }[] = [];
    for (const card of named.values()) {
      await tx.insert(cardGitHubPulls).values({ clientId: installation.clientId, cardId: card.cardId, repoFullName, number: pull.number, ...snapshot });
      const activity = await recordActivity(tx, {
        boardId: card.boardId,
        workspaceId: card.workspaceId,
        actorId: null,
        actorKind: "system",
        entityType: "card",
        entityId: card.cardId,
        action: ACTIVITY_ACTION.GITHUB_PULL_LINKED,
        payload: activityPayload,
      });
      activities.push({ boardId: card.boardId, cardId: card.cardId, activity });
    }

    const current = existing.filter((row) => row.link.githubUpdatedAt <= githubUpdatedAt);
    if (current.length) {
      await tx.update(cardGitHubPulls)
        .set({ ...snapshot, updatedAt: new Date() })
        .where(inArray(cardGitHubPulls.id, current.map((row) => row.link.id)));
    }
    for (const row of current) {
      if (row.link.state === state) continue;
      const activity = await recordActivity(tx, {
        boardId: row.boardId,
        workspaceId: row.workspaceId,
        actorId: null,
        actorKind: "system",
        entityType: "card",
        entityId: row.link.cardId,
        action: ACTIVITY_ACTION.GITHUB_PULL_STATE_CHANGED,
        payload: { ...activityPayload, fromState: row.link.state },
      });
      activities.push({ boardId: row.boardId, cardId: row.link.cardId, activity });
    }
    return activities;
  });

  // Pull request activity is shown in the card feed but notifies nobody: until automations act
  // on it, a merge is news only to people already looking at the card.
  for (const { boardId, cardId, activity } of recorded) {
    await emitActivityFeedItem(boardId, cardId, activity, { notify: false });
  }
  return recorded.length;
}

function installedRepository(repo: { full_name: string; name: string; private: boolean }): GitHubInstalledRepository {
  return { owner: repo.full_name.split("/")[0] ?? "", name: repo.name, fullName: repo.full_name, private: repo.private };
}

/**
 * Keeps an organisation's installation row current: an uninstall unbinds it, and repository
 * changes refresh the snapshot that decides which private links Kanera may resolve.
 */
export async function applyGitHubInstallationWebhook(event: string, payload: dto.GitHubInstallationWebhook): Promise<void> {
  const installationId = String(payload.installation.id);
  if (event === "installation" && payload.action === "deleted") {
    await db.delete(githubAppInstallations).where(eq(githubAppInstallations.installationId, installationId));
    return;
  }
  if (event !== "installation_repositories") return;

  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId))
      .for("update")
      .limit(1);
    if (!row) return;
    const removed = new Set((payload.repositories_removed ?? []).map((repo) => repo.full_name.toLowerCase()));
    const kept = row.repositories.filter((repo) => !removed.has(repo.fullName.toLowerCase()));
    const keptNames = new Set(kept.map((repo) => repo.fullName.toLowerCase()));
    const added = (payload.repositories_added ?? [])
      .filter((repo) => !keptNames.has(repo.full_name.toLowerCase()))
      .map(installedRepository);
    await tx.update(githubAppInstallations).set({
      repositories: [...kept, ...added],
      repositorySelection: payload.installation.repository_selection ?? row.repositorySelection,
      updatedAt: new Date(),
    }).where(eq(githubAppInstallations.id, row.id));
  });
}
