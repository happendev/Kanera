import { ChangeDetectionStrategy, Component, type OnInit, inject, input, signal } from "@angular/core";
import { Router } from "@angular/router";
import type { AdminOrgDetail, AdminOrgPersonListItem, AdminSupportSessionListItem, AdminSupportSessionResponse } from "@kanera/shared/dto";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { AdminAuthService } from "../../core/auth/admin-auth.service";
import { ConfirmService } from "../../shared/confirm.service";
import { TableControlsComponent, TablePagerComponent } from "../../shared/table-controls.component";
import { ToastService } from "../../shared/toast.service";

const PLANS = ["free", "paid"] as const;
const BILLING_STATUSES = ["none", "trialing", "active", "past_due", "canceled"] as const;

@Component({
  selector: "a-org-detail-page",
  standalone: true,
  imports: [TableControlsComponent, TablePagerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (org(); as o) {
      <header class="page-head">
        <div>
          <a class="muted back" (click)="back()"><i class="ti ti-arrow-left"></i> Organisations</a>
          <h1>{{ o.name }}</h1>
        </div>
        <div class="actions">
          @if (auth.isSuperadmin() && !o.deletedAt && !o.suspendedAt) {
            <button class="btn" type="button" (click)="toggleSupport()"><i class="ti ti-login-2"></i> Enter workspace</button>
          }
          @if (o.suspendedAt) {
            <button class="btn" type="button" (click)="setSuspended(false)">Reactivate</button>
          } @else {
            <button class="btn btn-danger" type="button" (click)="setSuspended(true)">Suspend</button>
          }
          @if (auth.isSuperadmin() && !o.deletedAt) {
            <button class="btn btn-danger" type="button" (click)="softDelete()">Delete</button>
          }
        </div>
      </header>

      @if (o.deletedAt) {
        <p class="badge badge-danger">This organisation is soft-deleted.</p>
      }

      @if (supportOpen()) {
        <div class="card support-start">
          <h2>Start support session</h2>
          <p class="muted">Enter {{ o.name }} as its owner to help set things up. The session is short-lived, audited, and can be revoked below.</p>
          <label><span class="muted">Reason (min 5 characters)</span>
            <input class="input" [value]="supportReason()" (input)="supportReason.set($any($event.target).value)" placeholder="e.g. help configure custom fields" />
          </label>
          <div class="row">
            <button class="btn btn-primary" type="button" [disabled]="supportBusy() || supportReason().trim().length < 5" (click)="startSupport()">Start &amp; open</button>
            <button class="btn" type="button" (click)="toggleSupport()">Cancel</button>
          </div>
        </div>
      }

      <div class="cols">
        <div class="card">
          <h2>Usage</h2>
          <dl>
            <dt class="muted">Members</dt><dd>{{ o.usage.memberCount }}</dd>
            <dt class="muted">Guests</dt><dd>{{ o.usage.guestCount }}</dd>
            <dt class="muted">Workspaces</dt><dd>{{ o.usage.workspaceCount }}</dd>
            <dt class="muted">Boards</dt><dd>{{ o.usage.boardCount }}</dd>
            <dt class="muted">Cards</dt><dd>{{ o.usage.cardCount }}</dd>
            <dt class="muted">Storage used</dt><dd>{{ mb(o.usage.storageUsedBytes) }}</dd>
            <dt class="muted">Storage quota</dt><dd>{{ o.usage.storageQuotaBytes === null ? "unlimited" : mb(o.usage.storageQuotaBytes) }}</dd>
            <dt class="muted">Effective access</dt>
            <dd>{{ o.deploymentMode === "self_hosted" ? "unlimited (self-hosted)" : o.entitlements.tier }}</dd>
          </dl>
        </div>

        <div class="card">
          <h2>Plan &amp; billing</h2>
          <label><span class="muted">Plan</span>
            <select class="select" [value]="plan()" (input)="plan.set($any($event.target).value)">
              @for (p of plans; track p) { <option [value]="p" [selected]="p === plan()">{{ p }}</option> }
            </select>
          </label>
          <label><span class="muted">Billing status</span>
            <select class="select" [value]="billingStatus()" (input)="billingStatus.set($any($event.target).value)">
              @for (s of billingStatuses; track s) { <option [value]="s" [selected]="s === billingStatus()">{{ s }}</option> }
            </select>
          </label>
          <label><span class="muted">Storage quota (MB, blank = unlimited)</span>
            <input class="input" type="number" [value]="quotaMb()" (input)="quotaMb.set($any($event.target).value)" />
          </label>
          <button class="btn btn-primary" type="button" (click)="savePlan()">Save plan</button>
        </div>

        <div class="card">
          <h2>Settings</h2>
          <label><span class="muted">Name</span>
            <input class="input" [value]="name()" (input)="name.set($any($event.target).value)" />
          </label>
          <button class="btn btn-primary" type="button" (click)="saveSettings()">Save settings</button>
        </div>
      </div>

      <div class="card people-card">
        <h2>Users and guests</h2>
        <a-table-controls [query]="peopleQuery()" placeholder="Search users and guests…" [page]="peoplePage()" [pageSize]="peoplePageSize()" [total]="peopleTotal()" [loading]="peopleLoading()" (queryChange)="searchPeople($event)" (pageChange)="goPeople($event)" (pageSizeChange)="resizePeople($event)" />
        <table class="data">
          <thead><tr>@for(c of peopleColumns;track c.key){<th><button class="sort" (click)="orderPeople(c.key)">{{c.label}} {{peopleArrow(c.key)}}</button></th>}</tr></thead>
          <tbody>
            @for (person of people(); track person.id) {
              <tr class="person-row" role="link" tabindex="0" (click)="openUser(person.id)" (keydown.enter)="openUser(person.id)" (keydown.space)="openUser(person.id); $event.preventDefault()">
                <td>{{ person.displayName }}</td>
                <td class="muted">{{ person.email }}</td>
                <td><span class="badge">{{ person.kind }}</span></td>
                <td class="muted">{{ person.kind === "guest" ? person.boardCount + " board" + (person.boardCount === 1 ? "" : "s") : person.role }}</td>
                <td class="muted">{{ person.lastOnlineAt ? formatDate(person.lastOnlineAt) : "Never" }}</td>
              </tr>
            } @empty {
              <tr><td colspan="5" class="muted">No users or guests found.</td></tr>
            }
          </tbody>
        </table>
        <a-table-pager [page]="peoplePage()" [pageSize]="peoplePageSize()" [total]="peopleTotal()" [loading]="peopleLoading()" (pageChange)="goPeople($event)" (pageSizeChange)="resizePeople($event)" />
      </div>

      <div class="card support-card">
        <h2>Support sessions</h2>
        @if (supportSessions().length) {
          <table class="data">
            <thead><tr><th>Admin</th><th>Acting as</th><th>Reason</th><th>Started</th><th>Status</th><th></th></tr></thead>
            <tbody>
              @for (s of supportSessions(); track s.id) {
                <tr>
                  <td class="muted">{{ s.adminEmail }}</td>
                  <td class="muted">{{ s.targetUserEmail }}</td>
                  <td>{{ s.reason }}</td>
                  <td class="muted">{{ formatDate(s.createdAt) }}</td>
                  <td>
                    @if (s.active) { <span class="badge badge-danger">active</span> }
                    @else if (s.endedAt) { <span class="badge">ended</span> }
                    @else { <span class="badge">expired</span> }
                  </td>
                  <td>
                    @if (s.active && auth.isSuperadmin()) {
                      <button class="btn" type="button" (click)="revokeSupport(s.id)">Revoke</button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <p class="muted">No support sessions.</p>
        }
      </div>
    } @else if (loading()) {
      <p class="muted">Loading…</p>
    } @else {
      <p class="badge badge-danger">Organisation not found.</p>
    }
  `,
  styles: [
    `
      .page-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 18px; gap: 16px; }
      .back { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer; }
      h1 { font-size: 20px; margin: 4px 0 0; }
      h2 { font-size: 14px; margin: 0 0 12px; }
      .actions { display: flex; gap: 8px; }
      .cols { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; align-items: start; }
      .card label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; margin-bottom: 12px; }
      dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 0; font-size: 13px; }
      dd { margin: 0; text-align: right; }
      .people-card { margin-top: 14px; overflow-x: auto; }
      .support-start { margin-top: 14px; margin-bottom:14px; }
      .support-start .row { display: flex; gap: 8px; }
      .support-card { margin-top: 14px; overflow-x: auto; }
      .person-row { cursor: pointer; }
      .person-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
      .sort { border:0;background:none;padding:0;font:inherit;font-weight:inherit;color:inherit;cursor:pointer; }
    `,
  ],
})
export class OrgDetailPage implements OnInit {
  readonly clientId = input.required<string>();

  private readonly api = inject(ApiClient);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);
  private readonly confirm = inject(ConfirmService);
  readonly auth = inject(AdminAuthService);

  readonly plans = PLANS;
  readonly billingStatuses = BILLING_STATUSES;

  readonly org = signal<AdminOrgDetail | null>(null);
  readonly loading = signal(true);

  readonly plan = signal<string>("free");
  readonly billingStatus = signal<string>("none");
  readonly quotaMb = signal<string>("");
  readonly name = signal<string>("");
  readonly peopleColumns = [{ key: "displayName", label: "Name" }, { key: "email", label: "Email" }, { key: "kind", label: "Type" }, { key: "access", label: "Role / access" }, { key: "lastOnlineAt", label: "Last online" }];
  readonly people = signal<AdminOrgPersonListItem[]>([]); readonly peopleTotal = signal(0); readonly peoplePage = signal(1); readonly peoplePageSize = signal(25); readonly peopleQuery = signal(""); readonly peopleSort = signal("displayName"); readonly peopleDirection = signal<"asc" | "desc">("asc"); readonly peopleLoading = signal(false); private peopleTimer: ReturnType<typeof setTimeout> | null = null;

  // Support-session UI state: the inline "start" panel and the audit list for this org.
  readonly supportOpen = signal(false);
  readonly supportReason = signal("");
  readonly supportBusy = signal(false);
  readonly supportSessions = signal<AdminSupportSessionListItem[]>([]);

  async ngOnInit(): Promise<void> {
    await Promise.all([this.load(), this.loadPeople(), this.loadSupportSessions()]);
  }
  searchPeople(v: string) { this.peopleQuery.set(v); if (this.peopleTimer) clearTimeout(this.peopleTimer); this.peopleTimer = setTimeout(() => { this.peoplePage.set(1); void this.loadPeople() }, 250) }
  goPeople(p: number) { this.peoplePage.set(p); void this.loadPeople() } resizePeople(s: number) { this.peoplePageSize.set(s); this.peoplePage.set(1); void this.loadPeople() } orderPeople(s: string) { if (this.peopleSort() === s) this.peopleDirection.update(d => d === "asc" ? "desc" : "asc"); else { this.peopleSort.set(s); this.peopleDirection.set("asc") } this.peoplePage.set(1); void this.loadPeople() } peopleArrow(s: string) { return this.peopleSort() === s ? (this.peopleDirection() === "asc" ? "↑" : "↓") : "" }
  private async loadPeople(): Promise<void> { this.peopleLoading.set(true); try { const p = new URLSearchParams({ page: String(this.peoplePage()), pageSize: String(this.peoplePageSize()), sort: this.peopleSort(), direction: this.peopleDirection() }); if (this.peopleQuery().trim()) p.set("q", this.peopleQuery().trim()); const r = await this.api.get<{ items: AdminOrgPersonListItem[]; total: number }>(`/admin/orgs/${this.clientId()}/people?${p}`); this.people.set(r.items); this.peopleTotal.set(r.total) } finally { this.peopleLoading.set(false) } }

  mb(bytes: number): string {
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
  }

  formatDate(value: string): string {
    return new Date(value).toLocaleString();
  }

  back(): void {
    void this.router.navigate(["/orgs"]);
  }

  openUser(userId: string): void {
    void this.router.navigate(["/users", userId]);
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const o = await this.api.get<AdminOrgDetail>(`/admin/orgs/${this.clientId()}`);
      this.org.set(o);
      this.plan.set(o.plan);
      this.billingStatus.set(o.billingStatus);
      this.quotaMb.set(o.storageQuotaBytes === null ? "" : String(Math.round(o.storageQuotaBytes / 1_048_576)));
      this.name.set(o.name);
    } catch {
      this.org.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  private async run(action: () => Promise<unknown>, ok: string): Promise<void> {
    try {
      await action();
      this.toasts.success(ok);
      await this.load();
    } catch (err) {
      this.toasts.error(err instanceof ApiError ? err.serverMessage : "Action failed");
    }
  }

  async setSuspended(suspend: boolean): Promise<void> {
    if (suspend && !await this.confirm.open({ title: "Suspend organisation?", message: `All members of ${this.org()?.name ?? "this organisation"} will be unable to sign in.`, confirmLabel: "Suspend" })) return;
    void this.run(
      () => this.api.post(`/admin/orgs/${this.clientId()}/${suspend ? "suspend" : "reactivate"}`),
      suspend ? "Organisation suspended" : "Organisation reactivated",
    );
  }

  savePlan(): void {
    const quota = this.quotaMb().trim();
    void this.run(
      () =>
        this.api.patch(`/admin/orgs/${this.clientId()}/plan`, {
          plan: this.plan(),
          billingStatus: this.billingStatus(),
          storageQuotaBytes: quota === "" ? null : Math.round(Number(quota) * 1_048_576),
        }),
      "Plan updated",
    );
  }

  saveSettings(): void {
    void this.run(() => this.api.patch(`/admin/orgs/${this.clientId()}/settings`, { name: this.name().trim() }), "Settings updated");
  }

  async softDelete(): Promise<void> {
    if (!await this.confirm.open({ title: "Delete organisation?", message: "Members will be unable to sign in. This is recoverable.", confirmLabel: "Delete" })) return;
    void this.run(async () => {
      await this.api.delete(`/admin/orgs/${this.clientId()}`);
      await this.router.navigate(["/orgs"]);
    }, "Organisation deleted");
  }

  toggleSupport(): void {
    this.supportOpen.update((v) => !v);
  }

  // Mint a support session for this org and open the enter link in a new tab. The link carries the token
  // in its URL fragment, so opening it hands the credential to the web app without it touching the server.
  async startSupport(): Promise<void> {
    if (this.supportReason().trim().length < 5) return;
    this.supportBusy.set(true);
    try {
      const res = await this.api.post<AdminSupportSessionResponse>(`/admin/orgs/${this.clientId()}/support-session`, { reason: this.supportReason().trim() });
      window.open(res.url, "_blank", "noopener");
      this.toasts.success(`Support session started — acting as ${res.actingAsEmail}`);
      this.supportOpen.set(false);
      this.supportReason.set("");
      await this.loadSupportSessions();
    } catch (err) {
      this.toasts.error(err instanceof ApiError ? err.serverMessage : "Could not start support session");
    } finally {
      this.supportBusy.set(false);
    }
  }

  async revokeSupport(id: string): Promise<void> {
    if (!await this.confirm.open({ title: "Revoke support session?", message: "The active token stops working immediately.", confirmLabel: "Revoke", danger: true })) return;
    try {
      await this.api.post(`/admin/support-sessions/${id}/end`);
      this.toasts.success("Support session revoked");
      await this.loadSupportSessions();
    } catch (err) {
      this.toasts.error(err instanceof ApiError ? err.serverMessage : "Could not revoke session");
    }
  }

  private async loadSupportSessions(): Promise<void> {
    try {
      const r = await this.api.get<{ items: AdminSupportSessionListItem[] }>(`/admin/support-sessions?clientId=${this.clientId()}&status=all&pageSize=25`);
      this.supportSessions.set(r.items);
    } catch {
      // Non-fatal: the audit list is supplementary to the rest of the org detail view.
    }
  }
}
