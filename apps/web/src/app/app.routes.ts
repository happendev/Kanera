import { inject } from "@angular/core";
import type { Routes, UrlMatcher, UrlSegment } from "@angular/router";
import { authGuard, publicAuthGuard, resetPasswordGuard } from "./core/auth/auth.guard";
import { onboardingGuard, portfolioGuard, standaloneBoardSettingsGuard, workspaceGuard, workspaceSettingsGuard } from "./core/auth/workspace.guard";
import { unsavedWorkCanDeactivateGuard } from "./core/browser/unsaved-work.service";
import { importNavigationCanActivateGuard, importNavigationCanDeactivateGuard } from "./features/import/import-navigation-guard.service";
import { ToastService } from "./shared/toast.service";

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

/** Settings tabs in display order; both the workspace and standalone-board settings pages mount them. */
const WORKSPACE_SETTINGS_TABS = ["general", "boards", "lists", "fields", "templates", "automations", "labels", "members", "guests", "integrations", "api"] as const;

/**
 * Every tab is a leaf child so the settings page can read the active tab from the URL; the import
 * guard keeps a running import from being abandoned by a tab change.
 */
function settingsTabRoutes(tabs: readonly string[]): Routes {
  return tabs.map((path) => ({ path, canActivate: [importNavigationCanActivateGuard], children: [] }));
}

export const routes: Routes = [
  {
    path: "login",
    title: $localize`:Browser tab title — sign-in page:Login`,
    canActivate: [publicAuthGuard],
    loadComponent: () => import("./features/auth/login.page").then((m) => m.LoginPage),
  },
  {
    path: "signup",
    title: $localize`:Browser tab title:Sign Up`,
    canActivate: [publicAuthGuard],
    loadComponent: () => import("./features/auth/signup.page").then((m) => m.SignupPage),
  },
  {
    path: "forgot-password",
    title: $localize`:Browser tab title:Forgot Password`,
    loadComponent: () => import("./features/auth/forgot-password.page").then((m) => m.ForgotPasswordPage),
  },
  {
    path: "reset-password",
    title: $localize`:Browser tab title:Reset Password`,
    canActivate: [resetPasswordGuard],
    loadComponent: () => import("./features/auth/reset-password.page").then((m) => m.ResetPasswordPage),
  },
  {
    // Reached from lifecycle emails; deliberately unguarded so it works signed in or out.
    path: "email/unsubscribe",
    title: $localize`:Browser tab title — email unsubscribe page:Unsubscribe`,
    loadComponent: () => import("./features/email-unsubscribe/email-unsubscribe.page").then((m) => m.EmailUnsubscribePage),
  },
  {
    path: "board-invite",
    title: $localize`:Browser tab title:Board Invitation`,
    loadComponent: () => import("./features/board-invite/board-invite.page").then((m) => m.BoardInvitePage),
  },
  {
    path: "invite",
    title: $localize`:Browser tab title:Organisation Invitation`,
    loadComponent: () => import("./features/invite/invite.page").then((m) => m.InvitePage),
  },
  {
    // Consumes a support-session token minted by the superadmin-gated API endpoint. Intentionally
    // unguarded so an operator can enter a session regardless of their own login state.
    path: "support/enter",
    title: $localize`:Browser tab title:Support Session`,
    loadComponent: () => import("./features/support/support-enter.page").then((m) => m.SupportEnterPage),
  },
  {
    path: "trello-auth-callback",
    title: $localize`:Browser tab title:Trello Connection`,
    loadComponent: () => import("./features/import/trello-auth-callback.page").then((m) => m.TrelloAuthCallbackPage),
  },
  {
    path: "oauth/authorize",
    title: $localize`:Browser tab title:Connect AI agent`,
    canActivate: [authGuard],
    loadComponent: () => import("./features/oauth/oauth-authorize.page").then((m) => m.OauthAuthorizePage),
  },
  {
    path: "oauth/device",
    title: $localize`:Browser tab title:Connect a device`,
    canActivate: [authGuard],
    loadComponent: () => import("./features/oauth/oauth-device.page").then((m) => m.OauthDevicePage),
  },
  {
    path: "onboarding",
    title: $localize`:Browser tab title — onboarding:Onboarding`,
    canActivate: [authGuard, onboardingGuard],
    loadComponent: () => import("./features/onboarding/onboarding.page").then((m) => m.OnboardingPage),
  },
  {
    // The popped-out scratchpad, deliberately outside the shell: a tab that is nothing but the notepad.
    // `authGuard` alone, without `workspaceGuard` — a scratchpad is private to the user and has no
    // workspace to resolve, so gating it on one would only redirect this tab into onboarding.
    path: "scratchpad",
    title: $localize`:Browser tab title — scratchpad:Scratchpad`,
    canActivate: [authGuard],
    loadComponent: () => import("./features/scratchpad/scratchpad.page").then((m) => m.ScratchpadPage),
  },
  {
    path: "",
    canActivate: [authGuard, workspaceGuard],
    loadComponent: () => import("./features/shell/app-shell.component").then((m) => m.AppShellComponent),
    children: [
      {
        path: "",
        title: $localize`:Browser tab title — home page:Home`,
        loadComponent: () => import("./features/home/home.page").then((m) => m.HomePage),
      },
      {
        matcher: collectionWithOptionalCard("my-cards"),
        title: $localize`:Browser tab title:My Cards`,
        data: { lens: "my", routePattern: "/my-cards", cardRoutePattern: "/my-cards/c/:cardId" },
        canDeactivate: [unsavedWorkCanDeactivateGuard],
        loadComponent: () => import("./features/global-work/global-work.page").then((m) => m.GlobalWorkPage),
      },
      {
        matcher: collectionWithOptionalCard("team-cards"),
        title: $localize`:Browser tab title:Team Cards`,
        data: { lens: "team", routePattern: "/team-cards", cardRoutePattern: "/team-cards/c/:cardId" },
        canDeactivate: [unsavedWorkCanDeactivateGuard],
        loadComponent: () => import("./features/global-work/global-work.page").then((m) => m.GlobalWorkPage),
      },
      {
        matcher: collectionWithOptionalCard("portfolio"),
        title: $localize`:Browser tab title — portfolio page:Portfolio`,
        data: { lens: "portfolio", routePattern: "/portfolio", cardRoutePattern: "/portfolio/c/:cardId" },
        canActivate: [portfolioGuard],
        canDeactivate: [unsavedWorkCanDeactivateGuard],
        loadComponent: () => import("./features/global-work/global-work.page").then((m) => m.GlobalWorkPage),
      },
      {
        path: "w/:workspaceId/settings",
        title: $localize`:Browser tab title:Workspace Settings`,
        canActivate: [workspaceSettingsGuard],
        canDeactivate: [importNavigationCanDeactivateGuard, unsavedWorkCanDeactivateGuard],
        loadComponent: () =>
          import("./features/workspace-settings/workspace-settings.page").then((m) => m.WorkspaceSettingsPage),
        children: [
          { path: "", pathMatch: "full", redirectTo: "general" },
          ...settingsTabRoutes(WORKSPACE_SETTINGS_TABS),
          { path: "import", children: [] },
        ],
      },
      {
        path: "b/:boardId/settings",
        title: $localize`:Browser tab title:Board Settings`,
        data: { standalone: true },
        canActivate: [standaloneBoardSettingsGuard],
        canDeactivate: [importNavigationCanDeactivateGuard, unsavedWorkCanDeactivateGuard],
        loadComponent: () =>
          import("./features/workspace-settings/workspace-settings.page").then((m) => m.WorkspaceSettingsPage),
        children: [
          { path: "", pathMatch: "full", redirectTo: "general" },
          // Standalone boards have no board list or member roster of their own.
          { path: "boards", pathMatch: "full", redirectTo: "general" },
          { path: "members", pathMatch: "full", redirectTo: "general" },
          ...settingsTabRoutes(WORKSPACE_SETTINGS_TABS.filter((tab) => tab !== "boards" && tab !== "members")),
          { path: "import", children: [] },
        ],
      },
      {
        path: "settings",
        title: $localize`:Browser tab title — account settings:Settings`,
        // Settings autosave, so this only prompts for the few explicit-Save forms and drafts still awaiting a blur.
        canDeactivate: [unsavedWorkCanDeactivateGuard],
        loadComponent: () =>
          import("./features/account-settings/account-settings.page").then((m) => m.AccountSettingsPage),
        children: [
          { path: "", pathMatch: "full", redirectTo: "profile" },
          { path: "profile", children: [] },
          { path: "account-security", children: [] },
          { path: "preferences", children: [] },
          { path: "notifications", children: [] },
          { path: "api-keys", children: [] },
          { path: "users", children: [] },
          { path: "org", children: [] },
          { path: "security", children: [] },
          { path: "integrations", children: [] },
          { path: "storage", children: [] },
          { path: "account", pathMatch: "full", redirectTo: "account-plan" },
          { path: "account-plan", children: [] },
        ],
      },
      {
        path: "w/:workspaceId/notes",
        title: $localize`:Browser tab title — notes page:Notes`,
        canDeactivate: [unsavedWorkCanDeactivateGuard],
        loadComponent: () =>
          import("./features/notes/workspace-notes.page").then((m) => m.WorkspaceNotesPage),
      },
      {
        path: "share-target",
        title: $localize`:Browser tab title:Create card`,
        loadComponent: () =>
          import("./features/share-target/share-target.page").then((m) => m.ShareTargetPage),
      },
      {
        path: "o/:organisationKey/c/:cardKey",
        title: $localize`:Browser tab title — a card page:Card`,
        loadComponent: () => import("./features/board/card-key-redirect.page").then((m) => m.CardKeyRedirectPage),
      },
      {
        matcher: boardWithOptionalCard,
        title: $localize`:Browser tab title — a board page:Board`,
        data: { routePattern: "/b/:boardId", cardRoutePattern: "/b/:boardId/c/:cardId" },
        canDeactivate: [unsavedWorkCanDeactivateGuard],
        loadComponent: () => import("./features/board/board.page").then((m) => m.BoardPage),
      },
    ],
  },
  {
    // Hand-shortened or stale links (e.g. `/c/DEV-12` without its `/o/<orgKey>` prefix) land here.
    // Say so instead of silently dropping the user on the home page as if the link had worked.
    path: "**",
    redirectTo: () => {
      inject(ToastService).error($localize`That link doesn't point to anything in Kanera.`, "link-off");
      return "";
    },
  },
];
