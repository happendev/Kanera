import { inject } from "@angular/core";
import type { CanActivateFn } from "@angular/router";
import { Router } from "@angular/router";
import { ApiClient } from "../api/api.client";
import { AuthService } from "./auth.service";

// Gates the main app shell. Users without a workspace enter onboarding unless
// they still have guest board access, which gives them useful app content.
export const workspaceGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const api = inject(ApiClient);
  await auth.hydrate();
  const user = auth.user();
  if (!user) return router.createUrlTree(["/login"]);
  if (!user.hasWorkspace && auth.isOrgAdmin()) {
    const home = await api.get<{
      groups?: { workspace: { kind?: "standard" | "board" }; boards: unknown[] }[];
      guestGroups?: { boards: unknown[] }[];
    }>("/home/boards").catch(() => null);
    const hasGuestBoards = home?.guestGroups?.some((group) => group.boards.length > 0) ?? false;
    const hasStandaloneBoards = home?.groups?.some((group) => group.workspace.kind === "board" && group.boards.length > 0) ?? false;
    if (!hasGuestBoards && !hasStandaloneBoards) return router.createUrlTree(["/onboarding"]);
  }
  return true;
};

// Gates onboarding to organisation admins who can create or add workspaces.
// Plan-limited accounts that have already reached their board cap return home.
export const onboardingGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const api = inject(ApiClient);
  await auth.hydrate();
  const user = auth.user();
  if (!user) return router.createUrlTree(["/login"]);
  if (!auth.isOrgAdmin()) return router.createUrlTree(["/"]);
  const maxBoards = auth.maxBoards();
  if (maxBoards !== null && user.hasWorkspace) {
    const home = await api.get<{ groups: { boards: unknown[] }[] }>("/home/boards").catch(() => null);
    const boardCount = home?.groups.reduce((sum, group) => sum + group.boards.length, 0) ?? 0;
    if (boardCount >= maxBoards) return router.createUrlTree(["/"]);
  }
  return true;
};

// Workspace settings are available to org admins globally, or to users who are
// owner/admin members of the specific workspace in the route.
export const workspaceSettingsGuard: CanActivateFn = async (route) => {
  const api = inject(ApiClient);
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.hydrate();
  const user = auth.user();
  if (!user) return router.createUrlTree(["/login"]);
  if (auth.isOrgAdmin()) return true;

  const workspaceId = route.paramMap.get("workspaceId");
  if (!workspaceId) return router.createUrlTree(["/"]);

  try {
    const workspace = await api.get<{ role: string }>(`/workspaces/${workspaceId}`);
    // Only workspace admins can reach workspace settings; plain members have no settings access.
    if (workspace.role === "admin") return true;
  } catch {
    return router.createUrlTree(["/"]);
  }

  return router.createUrlTree(["/"]);
};

// Standalone settings use a board-facing URL, then resolve the hidden workspace that owns all of
// the board's settings. Cross-organisation guests cannot pass the workspace-admin check.
export const standaloneBoardSettingsGuard: CanActivateFn = async (route) => {
  const api = inject(ApiClient);
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.hydrate();
  if (!auth.user()) return router.createUrlTree(["/login"]);
  if (auth.isOrgAdmin()) return true;

  const boardId = route.paramMap.get("boardId");
  if (!boardId) return router.createUrlTree(["/"]);
  try {
    const board = await api.get<{ workspaceId: string }>(`/boards/${boardId}`);
    const workspace = await api.get<{ role: string }>(`/workspaces/${board.workspaceId}`);
    if (workspace.role === "admin") return true;
  } catch {
    return router.createUrlTree(["/"]);
  }
  return router.createUrlTree(["/"]);
};
