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
    const home = await api.get<{ guestGroups?: { boards: unknown[] }[] }>("/home/boards").catch(() => null);
    const hasGuestBoards = home?.guestGroups?.some((group) => group.boards.length > 0) ?? false;
    if (!hasGuestBoards) return router.createUrlTree(["/onboarding"]);
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
    const workspaces = await api.get<{ id: string; role: string }[]>("/workspaces");
    const workspace = workspaces.find((w) => w.id === workspaceId);
    if (workspace?.role === "owner" || workspace?.role === "admin") return true;
  } catch {
    return router.createUrlTree(["/"]);
  }

  return router.createUrlTree(["/"]);
};
