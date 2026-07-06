import type { Routes } from "@angular/router";
import { adminAuthGuard } from "./core/auth/admin-auth.guard";
import { superadminGuard } from "./core/auth/superadmin.guard";

export const routes: Routes = [
  { path: "accept-invite", loadComponent: () => import("./features/accept-invite/accept-invite.page").then((m) => m.AcceptInvitePage) },
  {
    path: "login",
    loadComponent: () => import("./features/login/login.page").then((m) => m.LoginPage),
  },
  {
    path: "",
    canActivate: [adminAuthGuard],
    loadComponent: () => import("./features/shell/admin-shell.component").then((m) => m.AdminShellComponent),
    children: [
      { path: "", pathMatch: "full", redirectTo: "dashboard" },
      {
        path: "admins", canActivate: [superadminGuard],
        loadComponent: () => import("./features/admins/admins.page").then((m) => m.AdminsPage),
      },
      {
        path: "dashboard",
        loadComponent: () => import("./features/dashboard/dashboard.page").then((m) => m.DashboardPage),
      },
      {
        path: "orgs",
        loadComponent: () => import("./features/orgs/orgs.page").then((m) => m.OrgsPage),
      },
      {
        path: "orgs/:clientId",
        loadComponent: () => import("./features/orgs/org-detail.page").then((m) => m.OrgDetailPage),
      },
      {
        path: "users",
        loadComponent: () => import("./features/users/users.page").then((m) => m.UsersPage),
      },
      {
        path: "users/:userId",
        loadComponent: () => import("./features/users/user-detail.page").then((m) => m.UserDetailPage),
      },
      {
        path: "ops",
        loadComponent: () => import("./features/ops/ops.page").then((m) => m.OpsPage),
      },
    ],
  },
  { path: "**", redirectTo: "" },
];
