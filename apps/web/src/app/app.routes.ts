import type { Routes, UrlMatcher, UrlSegment } from "@angular/router";
import { authGuard, publicAuthGuard, resetPasswordGuard } from "./core/auth/auth.guard";
import { onboardingGuard, standaloneBoardSettingsGuard, workspaceGuard, workspaceSettingsGuard } from "./core/auth/workspace.guard";
import { unsavedWorkCanDeactivateGuard } from "./core/browser/unsaved-work.service";
import { importNavigationCanActivateGuard, importNavigationCanDeactivateGuard } from "./features/import/import-navigation-guard.service";

/**
 * Keep the same route/component instance while a card drawer opens and closes. A pair of separate
 * route definitions would recreate route-scoped Board/Global Work state on every card click; the
 * matcher gives both the collection and card-detail paths one reusable route configuration.
 */
function collectionWithOptionalCard(base: string): UrlMatcher {
  return (segments) => {
    if (segments[0]?.path !== base) return null;
    if (segments.length === 1) return { consumed: segments };
    if (segments.length === 3 && segments[1]?.path === "c") {
      return { consumed: segments, posParams: { cardId: segments[2]! } };
    }
    return null;
  };
}

const boardWithOptionalCard: UrlMatcher = (segments) => {
  if (segments[0]?.path !== "b" || !segments[1]) return null;
  if (segments.length === 2) {
    const posParams: Record<string, UrlSegment> = { boardId: segments[1] };
    return { consumed: segments, posParams };
  }
  if (segments.length === 4 && segments[2]?.path === "c" && segments[3]) {
    const posParams: Record<string, UrlSegment> = { boardId: segments[1], cardId: segments[3] };
    return { consumed: segments, posParams };
  }
  return null;
};

export const routes: Routes = [
  {
    path: "login",
    title: "Login",
    canActivate: [publicAuthGuard],
    loadComponent: () => import("./features/auth/login.page").then((m) => m.LoginPage),
  },
  {
    path: "signup",
    title: "Sign Up",
    canActivate: [publicAuthGuard],
    loadComponent: () => import("./features/auth/signup.page").then((m) => m.SignupPage),
  },
  {
    path: "forgot-password",
    title: "Forgot Password",
    loadComponent: () => import("./features/auth/forgot-password.page").then((m) => m.ForgotPasswordPage),
  },
  {
    path: "reset-password",
    title: "Reset Password",
    canActivate: [resetPasswordGuard],
    loadComponent: () => import("./features/auth/reset-password.page").then((m) => m.ResetPasswordPage),
  },
  {
    path: "board-invite",
    title: "Board Invitation",
    loadComponent: () => import("./features/board-invite/board-invite.page").then((m) => m.BoardInvitePage),
  },
  {
    // Consumes a support-session token minted by the superadmin-gated API endpoint. Intentionally
    // unguarded so an operator can enter a session regardless of their own login state.
    path: "support/enter",
    title: "Support Session",
    loadComponent: () => import("./features/support/support-enter.page").then((m) => m.SupportEnterPage),
  },
  {
    path: "trello-auth-callback",
    title: "Trello Connection",
    loadComponent: () => import("./features/import/trello-auth-callback.page").then((m) => m.TrelloAuthCallbackPage),
  },
  {
    path: "oauth/authorize",
    title: "Connect AI agent",
    canActivate: [authGuard],
    loadComponent: () => import("./features/oauth/oauth-authorize.page").then((m) => m.OauthAuthorizePage),
  },
  {
    path: "oauth/device",
    title: "Connect a device",
    canActivate: [authGuard],
    loadComponent: () => import("./features/oauth/oauth-device.page").then((m) => m.OauthDevicePage),
  },
  {
    path: "onboarding",
    title: "Onboarding",
    canActivate: [authGuard, onboardingGuard],
    loadComponent: () => import("./features/onboarding/onboarding.page").then((m) => m.OnboardingPage),
  },
  {
    path: "",
    canActivate: [authGuard, workspaceGuard],
    loadComponent: () => import("./features/shell/app-shell.component").then((m) => m.AppShellComponent),
    children: [
      {
        path: "",
        title: "Home",
        loadComponent: () => import("./features/home/home.page").then((m) => m.HomePage),
      },
      {
        matcher: collectionWithOptionalCard("my-cards"),
        title: "My Cards",
        data: { lens: "my", routePattern: "/my-cards", cardRoutePattern: "/my-cards/c/:cardId" },
        canDeactivate: [unsavedWorkCanDeactivateGuard],
        loadComponent: () => import("./features/global-work/global-work.page").then((m) => m.GlobalWorkPage),
      },
      {
        matcher: collectionWithOptionalCard("team-cards"),
        title: "Team Cards",
        data: { lens: "team", routePattern: "/team-cards", cardRoutePattern: "/team-cards/c/:cardId" },
        canDeactivate: [unsavedWorkCanDeactivateGuard],
        loadComponent: () => import("./features/global-work/global-work.page").then((m) => m.GlobalWorkPage),
      },
      {
        matcher: collectionWithOptionalCard("portfolio"),
        title: "Portfolio",
        data: { lens: "portfolio", routePattern: "/portfolio", cardRoutePattern: "/portfolio/c/:cardId" },
        canDeactivate: [unsavedWorkCanDeactivateGuard],
        loadComponent: () => import("./features/global-work/global-work.page").then((m) => m.GlobalWorkPage),
      },
      {
        path: "w/:workspaceId/settings",
        title: "Workspace Settings",
        canActivate: [workspaceSettingsGuard],
        canDeactivate: [importNavigationCanDeactivateGuard],
        loadComponent: () =>
          import("./features/workspace-settings/workspace-settings.page").then((m) => m.WorkspaceSettingsPage),
        children: [
          { path: "", pathMatch: "full", redirectTo: "general" },
          { path: "general", canActivate: [importNavigationCanActivateGuard], children: [] },
          { path: "boards", canActivate: [importNavigationCanActivateGuard], children: [] },
          { path: "lists", canActivate: [importNavigationCanActivateGuard], children: [] },
          { path: "fields", canActivate: [importNavigationCanActivateGuard], children: [] },
          { path: "templates", canActivate: [importNavigationCanActivateGuard], children: [] },
          { path: "automations", canActivate: [importNavigationCanActivateGuard], children: [] },
          { path: "labels", canActivate: [importNavigationCanActivateGuard], children: [] },
          { path: "members", canActivate: [importNavigationCanActivateGuard], children: [] },
          { path: "guests", canActivate: [importNavigationCanActivateGuard], children: [] },
          { path: "integrations", canActivate: [importNavigationCanActivateGuard], children: [] },
          { path: "api", canActivate: [importNavigationCanActivateGuard], children: [] },
          { path: "import", children: [] },
        ],
      },
      {
        path: "b/:boardId/settings",
        title: "Board Settings",
        data: { standalone: true },
        canActivate: [standaloneBoardSettingsGuard],
        canDeactivate: [importNavigationCanDeactivateGuard],
        loadComponent: () =>
          import("./features/workspace-settings/workspace-settings.page").then((m) => m.WorkspaceSettingsPage),
        children: [
          { path: "", pathMatch: "full", redirectTo: "general" },
          { path: "boards", pathMatch: "full", redirectTo: "general" },
          { path: "members", pathMatch: "full", redirectTo: "general" },
          { path: "general", canActivate: [importNavigationCanActivateGuard], children: [] },
          { path: "lists", canActivate: [importNavigationCanActivateGuard], children: [] },
          { path: "fields", canActivate: [importNavigationCanActivateGuard], children: [] },
          { path: "templates", canActivate: [importNavigationCanActivateGuard], children: [] },
          { path: "automations", canActivate: [importNavigationCanActivateGuard], children: [] },
          { path: "labels", canActivate: [importNavigationCanActivateGuard], children: [] },
          { path: "guests", canActivate: [importNavigationCanActivateGuard], children: [] },
          { path: "integrations", canActivate: [importNavigationCanActivateGuard], children: [] },
          { path: "api", canActivate: [importNavigationCanActivateGuard], children: [] },
          { path: "import", children: [] },
        ],
      },
      {
        path: "settings",
        title: "Settings",
        loadComponent: () =>
          import("./features/account-settings/account-settings.page").then((m) => m.AccountSettingsPage),
        children: [
          { path: "", pathMatch: "full", redirectTo: "profile" },
          { path: "profile", children: [] },
          { path: "notifications", children: [] },
          { path: "api-keys", children: [] },
          { path: "users", children: [] },
          { path: "org", children: [] },
          { path: "account", pathMatch: "full", redirectTo: "account-plan" },
          { path: "account-plan", children: [] },
        ],
      },
      {
        path: "w/:workspaceId/notes",
        title: "Notes",
        canDeactivate: [unsavedWorkCanDeactivateGuard],
        loadComponent: () =>
          import("./features/notes/workspace-notes.page").then((m) => m.WorkspaceNotesPage),
      },
      {
        path: "share-target",
        title: "Create card",
        loadComponent: () =>
          import("./features/share-target/share-target.page").then((m) => m.ShareTargetPage),
      },
      {
        path: "o/:organisationKey/c/:cardKey",
        title: "Card",
        loadComponent: () => import("./features/board/card-key-redirect.page").then((m) => m.CardKeyRedirectPage),
      },
      {
        matcher: boardWithOptionalCard,
        title: "Board",
        data: { routePattern: "/b/:boardId", cardRoutePattern: "/b/:boardId/c/:cardId" },
        canDeactivate: [unsavedWorkCanDeactivateGuard],
        loadComponent: () => import("./features/board/board.page").then((m) => m.BoardPage),
      },
    ],
  },
  { path: "**", redirectTo: "" },
];
