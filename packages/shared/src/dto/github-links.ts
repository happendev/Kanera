import { z } from "zod";
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
