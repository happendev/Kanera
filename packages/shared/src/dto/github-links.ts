import { z } from "zod";
import type { CardGitHubPull } from "../schema/card-github-pull.js";
import type { GitHubAppInstallation } from "../schema/github-app-installation.js";

export const resolveGitHubLinksBody = z.object({
  workspaceId: z.uuid().optional(),
  urls: z.array(z.string().min(1).max(2048)).max(50),
});
export type ResolveGitHubLinksBody = z.infer<typeof resolveGitHubLinksBody>;

export type ResolvedGitHubLink =
  | {
      kind: "repo";
      owner: string;
      repo: string;
      fullName: string;
      title: string;
      description: string | null;
      private: boolean;
      href: string;
    }
  | {
      kind: "pull";
      owner: string;
      repo: string;
      fullName: string;
      number: number;
      title: string;
      state: "open" | "closed" | "merged" | "draft";
      changedFiles: number | null;
      additions: number | null;
      deletions: number | null;
      href: string;
    }
  | {
      kind: "issue";
      owner: string;
      repo: string;
      fullName: string;
      number: number;
      title: string;
      state: "open" | "closed";
      href: string;
    }
  | {
      kind: "release";
      owner: string;
      repo: string;
      fullName: string;
      tagName: string;
      title: string;
      state: "released" | "prerelease" | "draft";
      publishedAt: string | null;
      href: string;
    }
  | {
      kind: "commit";
      owner: string;
      repo: string;
      fullName: string;
      sha: string;
      shortSha: string;
      title: string;
      changedFiles: number | null;
      additions: number | null;
      deletions: number | null;
      href: string;
    };

export interface ResolveGitHubLinksResponse {
  links: Record<string, ResolvedGitHubLink>;
}

export const completeGitHubInstallationBody = z.object({
  installationId: z.string().trim().min(1).max(64).regex(/^\d+$/),
  // OAuth code GitHub appends to the post-install redirect when the App requests user
  // authorization during installation. Required whenever the deployment can verify it.
  code: z.string().trim().min(1).max(256).optional(),
});
export type CompleteGitHubInstallationBody = z.infer<typeof completeGitHubInstallationBody>;

export const createGitHubManifestBody = z.object({
  accountLogin: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/),
});
export type CreateGitHubManifestBody = z.infer<typeof createGitHubManifestBody>;

export interface GitHubManifestResponse {
  actionUrl: string;
  manifest: string;
  state: string;
}

export const completeGitHubManifestBody = z.object({
  code: z.string().trim().min(1).max(128),
  state: z.string().trim().min(1).max(256).optional(),
});
export type CompleteGitHubManifestBody = z.infer<typeof completeGitHubManifestBody>;

export type GitHubAppInstallationRow = Pick<
  GitHubAppInstallation,
  "id" | "clientId" | "accountLogin" | "accountType" | "repositorySelection" | "repositories" | "createdAt" | "updatedAt"
>;

export interface GitHubAppConfigResponse {
  configured: boolean;
  installUrl: string | null;
  appSlug: string | null;
  /** Where the deployment credentials come from: env vars, the manifest bootstrap, or not configured. */
  source: "env" | "manifest" | null;
  /** True when credentials exist but this organisation has not installed the app yet. */
  pendingInstallation?: boolean;
}

/** A pull request linked to a card, as card detail shows it. */
export type CardGitHubPullRow = Pick<
  CardGitHubPull,
  "id" | "repoFullName" | "number" | "title" | "url" | "headRef" | "state" | "additions" | "deletions" | "githubUpdatedAt"
>;

export interface CardGitHubPullsResponse {
  pulls: CardGitHubPullRow[];
}

const githubWebhookRepository = z.object({ full_name: z.string().min(1).max(200) });

/**
 * The parts of GitHub's `pull_request` webhook payload Kanera reads. Other fields pass through
 * unvalidated so GitHub can add to the payload without breaking delivery.
 */
export const githubPullRequestWebhook = z.object({
  action: z.string(),
  installation: z.object({ id: z.number().int() }),
  repository: githubWebhookRepository,
  pull_request: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable().optional(),
    html_url: z.url(),
    state: z.enum(["open", "closed"]),
    draft: z.boolean().optional(),
    merged_at: z.string().nullable().optional(),
    updated_at: z.iso.datetime({ offset: true }),
    additions: z.number().int().nullable().optional(),
    deletions: z.number().int().nullable().optional(),
    // `head.repo` is null when the fork a pull request came from has been deleted.
    head: z.object({ ref: z.string(), repo: githubWebhookRepository.nullable() }),
    base: z.object({ repo: githubWebhookRepository }),
  }),
});
export type GitHubPullRequestWebhook = z.infer<typeof githubPullRequestWebhook>;

const githubWebhookInstalledRepository = z.object({
  full_name: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  private: z.boolean(),
});

/** GitHub's `installation` and `installation_repositories` webhooks, which keep a binding current. */
export const githubInstallationWebhook = z.object({
  action: z.string(),
  installation: z.object({ id: z.number().int(), repository_selection: z.string().optional() }),
  repositories_added: z.array(githubWebhookInstalledRepository).optional(),
  repositories_removed: z.array(githubWebhookInstalledRepository).optional(),
});
export type GitHubInstallationWebhook = z.infer<typeof githubInstallationWebhook>;
