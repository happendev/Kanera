import { ChangeDetectionStrategy, Component, type OnInit, inject, input, signal } from "@angular/core";
import { Router } from "@angular/router";
import type { AdminUserDetail } from "@kanera/shared/dto";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { AdminAuthService } from "../../core/auth/admin-auth.service";
import { ToastService } from "../../shared/toast.service";
import { ConfirmService } from "../../shared/confirm.service";

const ROLES = ["owner", "admin", "member"] as const;

@Component({
  selector: "a-user-detail-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (user(); as u) {
      <header class="page-head">
        <div>
          <a class="muted back" (click)="back()"><i class="ti ti-arrow-left"></i> Users</a>
          <h1>{{ u.displayName }}</h1>
          <p class="muted">{{ u.email }} · {{ u.orgName }}</p>
        </div>
        <div class="actions">
          @if (u.suspendedAt) {
            <button class="btn" type="button" (click)="run('unsuspend', 'User unsuspended')">Unsuspend</button>
          } @else {
            <button class="btn btn-danger" type="button" (click)="suspend()">Suspend</button>
          }
          @if (auth.isSuperadmin() && !u.deletedAt) {
            <button class="btn btn-danger" type="button" (click)="softDelete()">Delete</button>
          }
        </div>
      </header>

      @if (u.deletedAt) {
        <p class="badge badge-danger">This user is soft-deleted.</p>
      }

      <div class="cols">
        <div class="card">
          <h2>Account</h2>
          <label><span class="muted">Org role</span>
            <select class="select" [value]="role()" (input)="role.set($any($event.target).value)">
              @for (r of roles; track r) { <option [value]="r" [selected]="r === role()">{{ r }}</option> }
            </select>
          </label>
          <button class="btn btn-primary" type="button" (click)="saveRole()">Save role</button>

          <div class="divider"></div>

          <button class="btn" type="button" (click)="run('reset-password', 'Password reset email sent')">
            <i class="ti ti-mail"></i> Send password reset
          </button>
          <button class="btn" type="button" (click)="run('force-reverify', 'Email verification cleared')">
            <i class="ti ti-mail-off"></i> Force email re-verify
          </button>
        </div>

        <div class="card">
          <h2>Workspace memberships</h2>
          @if (u.memberships.length) {
            <ul>
              @for (m of u.memberships; track m.workspaceId) {
                <li><span>{{ m.workspaceName }}</span> <span class="badge">{{ m.role }}</span></li>
              }
            </ul>
          } @else {
            <p class="muted">No workspace memberships.</p>
          }
        </div>
      </div>

      <div class="card guest-access">
        <h2>Guest board access</h2>
        @if (u.guestBoardAccess.length) {
          <table class="data">
            <thead><tr><th>Organisation</th><th>Workspace</th><th>Board</th><th>Role</th><th>Added</th></tr></thead>
            <tbody>
              @for (access of u.guestBoardAccess; track access.boardId) {
                <tr>
                  <td>{{ access.orgName }}</td>
                  <td>{{ access.workspaceName }}</td>
                  <td>{{ access.boardName }}</td>
                  <td><span class="badge">{{ access.role }}</span></td>
                  <td class="muted">{{ formatDate(access.addedAt) }}</td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <p class="muted">No guest board access.</p>
        }
      </div>
    } @else if (loading()) {
      <p class="muted">Loading…</p>
    } @else {
      <p class="badge badge-danger">User not found.</p>
    }
  `,
  styles: [
    `
      .page-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 18px; gap: 16px; }
      .back { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer; }
      h1 { font-size: 20px; margin: 4px 0 0; }
      h2 { font-size: 14px; margin: 0 0 12px; }
      p { margin: 4px 0 0; font-size: 13px; }
      .actions { display: flex; gap: 8px; }
      .cols { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; align-items: start; }
      .card label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; margin-bottom: 12px; }
      .card .btn { width: 100%; margin-bottom: 8px; }
      .divider { height: 1px; background: var(--border); margin: 14px 0; }
      ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
      li { display: flex; align-items: center; justify-content: space-between; }
      .guest-access { margin-top: 14px; overflow-x: auto; }
    `,
  ],
})
export class UserDetailPage implements OnInit {
  readonly userId = input.required<string>();

  private readonly api = inject(ApiClient);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);
  private readonly confirm = inject(ConfirmService);
  readonly auth = inject(AdminAuthService);

  readonly roles = ROLES;
  readonly user = signal<AdminUserDetail | null>(null);
  readonly loading = signal(true);
  readonly role = signal<string>("member");

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  back(): void {
    void this.router.navigate(["/users"]);
  }

  formatDate(value: string): string {
    return new Date(value).toLocaleString();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const u = await this.api.get<AdminUserDetail>(`/admin/users/${this.userId()}`);
      this.user.set(u);
      this.role.set(u.role);
    } catch {
      this.user.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  private async execute(action: () => Promise<unknown>, ok: string): Promise<void> {
    try {
      await action();
      this.toasts.success(ok);
      await this.load();
    } catch (err) {
      this.toasts.error(err instanceof ApiError ? err.serverMessage : "Action failed");
    }
  }

  // POST endpoints that take no body: suspend | unsuspend | reset-password | force-reverify.
  run(endpoint: string, ok: string): void {
    void this.execute(() => this.api.post(`/admin/users/${this.userId()}/${endpoint}`), ok);
  }

  saveRole(): void {
    void this.execute(() => this.api.patch(`/admin/users/${this.userId()}/role`, { role: this.role() }), "Role updated");
  }

  async suspend(): Promise<void> {
    const name = this.user()?.displayName ?? "this user";
    if (!await this.confirm.open({ title: `Suspend ${name}?`, message: "They will be unable to sign in until unsuspended.", confirmLabel: "Suspend" })) return;
    this.run("suspend", "User suspended");
  }

  async softDelete(): Promise<void> {
    if (!await this.confirm.open({ title: "Delete user?", message: "They will be unable to sign in. This is recoverable.", confirmLabel: "Delete" })) return;
    void this.execute(async () => {
      await this.api.delete(`/admin/users/${this.userId()}`);
      await this.router.navigate(["/users"]);
    }, "User deleted");
  }
}
