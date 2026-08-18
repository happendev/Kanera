import { ChangeDetectionStrategy, Component, type OnInit, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import type { AdminOrgListItem } from "@kanera/shared/dto";
import { ApiClient } from "../../core/api/api.client";
import { isSubscribedPlan, organisationPlanLabel } from "../../shared/plan-access";
import { TableControlsComponent, TablePagerComponent } from "../../shared/table-controls.component";

interface OrgListResponse {
  items: AdminOrgListItem[];
  total: number;
  page: number;
  pageSize: number;
}

@Component({
  selector: "a-orgs-page",
  standalone: true,
  imports: [RouterLink, TableControlsComponent, TablePagerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="page-head">
      <h1>Organisations</h1>
    </header>
    <a-table-controls [query]="query()" placeholder="Search organisations…" [page]="page()" [pageSize]="pageSize()" [total]="total()" [loading]="loading()" (queryChange)="onSearch($event)" (pageChange)="go($event)" (pageSizeChange)="resize($event)" />

    @if (loading()) {
      <p class="muted">Loading…</p>
    } @else {
      <table class="data">
        <thead>
          <tr>
            <th><button class="sort" (click)="orderBy('name')">Name {{ arrow('name') }}</button></th><th><button class="sort" (click)="orderBy('plan')">Plan {{ arrow('plan') }}</button></th><th><button class="sort" (click)="orderBy('billingStatus')">Billing {{ arrow('billingStatus') }}</button></th><th>Seats</th><th><button class="sort" (click)="orderBy('memberCount')">People {{ arrow('memberCount') }}</button></th><th><button class="sort" (click)="orderBy('createdAt')">Created {{ arrow('createdAt') }}</button></th><th><button class="sort" (click)="orderBy('status')">Status {{ arrow('status') }}</button></th>
          </tr>
        </thead>
        <tbody>
          @for (org of items(); track org.id) {
            <tr [routerLink]="['/orgs', org.id]" class="row">
              <td>{{ org.name }}</td>
              <td><span class="badge" [class.badge-pro]="planLabel(org) === 'Pro'" [class.badge-trial]="planLabel(org) === 'Trial'">{{ planLabel(org) }}</span></td>
              <td>
                <span>{{ org.billingStatus }}</span>
                @if (billingIntervalLabel(org); as interval) {
                  <span class="billing-interval">{{ interval }}</span>
                }
                @if (billingTiming(org); as timing) {
                  <span class="billing-timing">{{ timing }}</span>
                }
              </td>
              <td>
                @if (isSubscribed(org)) {
                  <strong>{{ org.usedSeatCount }} / {{ org.seatLimit }}</strong>
                  <span class="cell-detail">used / purchased</span>
                } @else if (org.billingStatus === "trialing") {
                  <strong>{{ org.usedSeatCount }}</strong>
                  <span class="cell-detail">needed at checkout</span>
                } @else {
                  <span class="muted">Not billed</span>
                }
              </td>
              <td>
                <strong>{{ org.memberCount }}</strong> member{{ org.memberCount === 1 ? "" : "s" }}
                <span class="cell-detail">{{ org.paidGuestCount }} {{ guestSeatLabel(org, org.paidGuestCount) }} · {{ org.freeGuestCount }} free guest{{ org.freeGuestCount === 1 ? "" : "s" }}</span>
              </td>
              <td class="muted">{{ formatDateTime(org.createdAt) }}</td>
              <td>
                @if (org.deletedAt) {
                  <span class="badge badge-danger">deleted</span>
                } @else if (org.suspendedAt) {
                  <span class="badge badge-danger">suspended</span>
                } @else {
                  <span class="badge">active</span>
                }
              </td>
            </tr>
          } @empty {
            <tr><td colspan="7" class="muted">No organisations found.</td></tr>
          }
        </tbody>
      </table>
      <a-table-pager [page]="page()" [pageSize]="pageSize()" [total]="total()" [loading]="loading()" (pageChange)="go($event)" (pageSizeChange)="resize($event)" />

    }
  `,
  styles: [
    `
      .page-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 18px;
        gap: 16px;
      }
      h1 {
        font-size: 20px;
        margin: 0;
      }
      .row {
        cursor: pointer;
      }
      .billing-timing {
        display: block;
        margin-top: 3px;
        font-size: 12px;
        white-space: nowrap;
      }
      .billing-interval {
        color: var(--text-muted);
        font-size: 11px;
        margin-left: 6px;
      }
      .cell-detail {
        color: var(--text-muted);
        display: block;
        font-size: 11px;
        margin-top: 3px;
        white-space: nowrap;
      }
      .badge-pro { background: color-mix(in srgb, var(--success) 14%, var(--surface)); border-color: color-mix(in srgb, var(--success) 45%, var(--border)); color: var(--success); }
      .badge-trial { background: color-mix(in srgb, var(--warning) 14%, var(--surface)); border-color: color-mix(in srgb, var(--warning) 45%, var(--border)); color: var(--warning); }
      .sort { border: 0; background: none; padding: 0; font: inherit; font-weight: inherit; color: inherit; cursor: pointer; }
    `,
  ],
})
export class OrgsPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly pageSize = signal(25);

  readonly items = signal<AdminOrgListItem[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly query = signal("");
  readonly loading = signal(true);
  readonly sort = signal("createdAt"); readonly direction = signal<"asc" | "desc">("desc");

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  readonly formatDateTime = (value: string): string => new Date(value).toLocaleString();

  isSubscribed(org: AdminOrgListItem): boolean {
    return isSubscribedPlan(org.plan, org.billingStatus);
  }

  planLabel(org: AdminOrgListItem): "Free" | "Trial" | "Pro" {
    return organisationPlanLabel(org.plan, org.billingStatus);
  }

  guestSeatLabel(org: AdminOrgListItem, count: number): string {
    const kind = this.isSubscribed(org) ? "paid guest" : org.billingStatus === "trialing" ? "trial guest" : "seat guest";
    return count === 1 ? kind : `${kind}s`;
  }

  billingTiming(org: AdminOrgListItem): string | null {
    if (!org.currentPeriodEnd) return org.cancelAtPeriodEnd ? "Expiry date not synced" : null;
    const end = new Date(org.currentPeriodEnd);
    const remainingMs = end.getTime() - Date.now();
    const absolute = end.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

    // The same Stripe period boundary means renewal for a continuing subscription and expiry when
    // cancellation is scheduled, so never describe every period end as a payment date.
    if (remainingMs <= 0) {
      if (org.billingStatus === "trialing") return `Trial ended ${absolute}`;
      return org.cancelAtPeriodEnd ? `Expired ${absolute}` : `Period ended ${absolute}`;
    }
    const days = Math.ceil(remainingMs / 86_400_000);
    const remaining = days === 1 ? "1 day" : `${days} days`;
    if (org.billingStatus === "trialing") return `Trial ends: ${remaining} · ${absolute}`;
    if (org.cancelAtPeriodEnd) return `Seats expire: ${remaining} · ${absolute}`;
    return this.isSubscribed(org) ? `Renews: ${remaining} · ${absolute}` : `Ends: ${remaining} · ${absolute}`;
  }

  billingIntervalLabel(org: AdminOrgListItem): string | null {
    if (org.billingInterval === "monthly") return "Monthly";
    if (org.billingInterval === "annual") return "Annual";
    return null;
  }

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  onSearch(value: string): void {
    this.query.set(value);
    // Debounce so each keystroke does not fire a request.
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.page.set(1);
      void this.load();
    }, 250);
  }

  go(page: number): void {
    this.page.set(page);
    void this.load();
  }
  resize(size: number): void { this.pageSize.set(size); this.page.set(1); void this.load(); }
  orderBy(sort: string): void { if (this.sort() === sort) this.direction.update((d) => d === "asc" ? "desc" : "asc"); else { this.sort.set(sort); this.direction.set("asc"); } this.page.set(1); void this.load(); }
  arrow(sort: string): string { return this.sort() === sort ? (this.direction() === "asc" ? "↑" : "↓") : ""; }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const params = new URLSearchParams({ page: String(this.page()), pageSize: String(this.pageSize()), sort: this.sort(), direction: this.direction() });
      const q = this.query().trim();
      if (q) params.set("q", q);
      const res = await this.api.get<OrgListResponse>(`/admin/orgs?${params.toString()}`);
      this.items.set(res.items);
      this.total.set(res.total);
    } finally {
      this.loading.set(false);
    }
  }
}
