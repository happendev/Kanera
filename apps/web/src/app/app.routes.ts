import type { Routes } from "@angular/router";
import { authGuard, publicAuthGuard, resetPasswordGuard } from "./core/auth/auth.guard";
import { onboardingGuard, workspaceGuard, workspaceSettingsGuard } from "./core/auth/workspace.guard";
import { importNavigationCanActivateGuard, importNavigationCanDeactivateGuard } from "./features/import/import-navigation-guard.service";

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
        path: "w/:workspaceId/u/:userId",
        title: "My Cards",
        data: { mode: "me" },
        loadComponent: () => import("./features/assigned-work/assigned-work.page").then((m) => m.AssignedWorkPage),
      },
      {
        path: "w/:workspaceId/team",
        title: "Team Cards",
        data: { mode: "team" },
        loadComponent: () => import("./features/assigned-work/assigned-work.page").then((m) => m.AssignedWorkPage),
      },
      {
        path: "b/:boardId",
        title: "Board",
        loadComponent: () => import("./features/board/board.page").then((m) => m.BoardPage),
      },
      {
        path: "b/:boardId/c/:cardId",
        title: "Board",
        loadComponent: () => import("./features/board/board.page").then((m) => m.BoardPage),
      },
    ],
  },
  { path: "**", redirectTo: "" },
];
