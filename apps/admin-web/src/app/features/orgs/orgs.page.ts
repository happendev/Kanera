import { ChangeDetectionStrategy, Component, type OnInit, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import type { AdminOrgListItem } from "@kanera/shared/dto";
import { ApiClient } from "../../core/api/api.client";
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
            <th><button class="sort" (click)="orderBy('name')">Name {{ arrow('name') }}</button></th><th><button class="sort" (click)="orderBy('plan')">Plan {{ arrow('plan') }}</button></th><th><button class="sort" (click)="orderBy('billingStatus')">Billing {{ arrow('billingStatus') }}</button></th><th><button class="sort" (click)="orderBy('memberCount')">Members {{ arrow('memberCount') }}</button></th><th><button class="sort" (click)="orderBy('createdAt')">Created {{ arrow('createdAt') }}</button></th><th><button class="sort" (click)="orderBy('status')">Status {{ arrow('status') }}</button></th>
          </tr>
        </thead>
        <tbody>
          @for (org of items(); track org.id) {
            <tr [routerLink]="['/orgs', org.id]" class="row">
              <td>{{ org.name }}</td>
              <td><span class="badge">{{ org.plan }}</span></td>
              <td class="muted">{{ org.billingStatus }}</td>
              <td>{{ org.memberCount }}</td>
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
            <tr><td colspan="6" class="muted">No organisations found.</td></tr>
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
