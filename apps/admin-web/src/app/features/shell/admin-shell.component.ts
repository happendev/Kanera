import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { AdminAuthService } from "../../core/auth/admin-auth.service";

interface NavItem {
  label: string;
  icon: string;
  path: string;
  superadminOnly?: boolean;
}

@Component({
  selector: "a-admin-shell",
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <i class="ti ti-shield-lock"></i>
          <span>Kanera Admin</span>
        </div>
        <nav>
          @for (item of nav; track item.path) {
            @if (!item.superadminOnly || auth.isSuperadmin()) {
            <a [routerLink]="item.path" routerLinkActive="active">
              <i class="ti" [class]="'ti ' + item.icon"></i>
              <span>{{ item.label }}</span>
            </a>
            }
          }
        </nav>
        <div class="account">
          <div class="who">
            <div class="name">{{ auth.user()?.displayName }}</div>
            <div class="muted role">{{ auth.user()?.role }}</div>
          </div>
          <button class="btn btn-sm" type="button" (click)="logout()" title="Sign out">
            <i class="ti ti-logout"></i>
          </button>
        </div>
      </aside>
      <main class="content">
        <router-outlet />
      </main>
    </div>
  `,
  styles: [
    `
      .shell {
        display: grid;
        grid-template-columns: 232px 1fr;
        min-height: 100vh;
      }
      .sidebar {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 16px 12px;
        border-right: 1px solid var(--border);
        background: var(--surface);
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 8px 14px;
        font-weight: 600;
      }
      .brand i {
        color: var(--accent);
        font-size: 20px;
      }
      nav {
        display: flex;
        flex-direction: column;
        gap: 2px;
        flex: 1;
      }
      nav a {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
        border-radius: var(--radius);
        color: var(--text-muted);
        font-size: 13px;
        font-weight: 500;
      }
      nav a:hover {
        background: var(--surface-hover);
        color: var(--text);
      }
      nav a.active {
        background: var(--surface-2);
        color: var(--text);
      }
      .account {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 8px 4px;
        border-top: 1px solid var(--border);
      }
      .who {
        flex: 1;
        min-width: 0;
      }
      .name {
        font-size: 13px;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .role {
        font-size: 11px;
        text-transform: capitalize;
      }
      .content {
        padding: 24px 28px;
        overflow-x: auto;
      }
    `,
  ],
})
export class AdminShellComponent {
  readonly auth = inject(AdminAuthService);
  private readonly router = inject(Router);

  readonly nav: NavItem[] = [
    { label: "Dashboard", icon: "ti-dashboard", path: "/dashboard" },
    { label: "Organisations", icon: "ti-building", path: "/orgs" },
    { label: "Users", icon: "ti-users", path: "/users" },
    { label: "Administrators", icon: "ti-user-shield", path: "/admins", superadminOnly: true },
    { label: "Ops & Queues", icon: "ti-server-cog", path: "/ops" },
  ];

  async logout(): Promise<void> {
    await this.auth.logout();
    await this.router.navigate(["/login"]);
  }
}
