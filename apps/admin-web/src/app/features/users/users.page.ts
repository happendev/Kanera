import { ChangeDetectionStrategy, Component, type OnInit, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import type { AdminUserListItem } from "@kanera/shared/dto";
import { ApiClient } from "../../core/api/api.client";
import { DataTableComponent, type DataTableColumn } from "../../shared/data-table.component";

interface UserListResponse {
  items: AdminUserListItem[];
  total: number;
  page: number;
  pageSize: number;
}

@Component({
  selector: "a-users-page",
  standalone: true,
  imports: [RouterLink, DataTableComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="page-head">
      <h1>Users</h1>
    </header>

    <a-data-table [columns]="columns" [query]="query()" placeholder="Search name, email or organisation…" [sort]="sort()" [direction]="direction()" [page]="page()" [pageSize]="pageSize()" [total]="total()" [loading]="loading()" (queryChange)="onSearch($event)" (sortChange)="orderBy($event)" (pageChange)="go($event)" (pageSizeChange)="resize($event)">
          @for (u of items(); track u.id) {
            <tr [routerLink]="['/users', u.id]" class="row">
              <td>{{ u.displayName }}</td>
              <td class="muted">{{ u.email }}</td>
              <td>{{ u.orgName }}</td>
              <td><span class="badge">{{ u.role }}</span></td>
              <td class="muted">{{ formatDateTime(u.createdAt) }}</td>
              <td class="muted">{{ u.lastOnlineAt ? formatDateTime(u.lastOnlineAt) : "Never" }}</td>
              <td>
                @if (u.deletedAt) {
                  <span class="badge badge-danger">deleted</span>
                } @else if (u.suspendedAt) {
                  <span class="badge badge-danger">suspended</span>
                } @else {
                  <span class="badge">active</span>
                }
              </td>
            </tr>
          } @empty {
            <tr><td colspan="7" class="muted">No users found.</td></tr>
          }
    </a-data-table>
  `,
  styles: [
    `
      .page-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; gap: 16px; }
      h1 { font-size: 20px; margin: 0; }
      .row { cursor: pointer; }
    `,
  ],
})
export class UsersPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly columns: readonly DataTableColumn[]=[{key:"displayName",label:"Name"},{key:"email",label:"Email"},{key:"orgName",label:"Organisation"},{key:"role",label:"Role"},{key:"createdAt",label:"Created"},{key:"lastOnlineAt",label:"Last online"},{key:"status",label:"Status"}];
  readonly pageSize = signal(25);

  readonly items = signal<AdminUserListItem[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly query = signal("");
  readonly loading = signal(true);
  readonly sort = signal("createdAt");
  readonly direction = signal<"asc" | "desc">("desc");


  readonly formatDateTime = (value: string): string => new Date(value).toLocaleString();

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  onSearch(value: string): void {
    this.query.set(value);
    this.page.set(1); void this.load();
  }

  go(page: number): void {
    this.page.set(page);
    void this.load();
  }
  resize(size: number): void { this.pageSize.set(size); this.page.set(1); void this.load(); }
  orderBy(sort: string): void { if (this.sort() === sort) this.direction.update((d) => d === "asc" ? "desc" : "asc"); else { this.sort.set(sort); this.direction.set("asc"); } this.page.set(1); void this.load(); }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const params = new URLSearchParams({ page: String(this.page()), pageSize: String(this.pageSize()), sort: this.sort(), direction: this.direction() });
      const q = this.query().trim();
      if (q) params.set("q", q);
      const res = await this.api.get<UserListResponse>(`/admin/users?${params.toString()}`);
      this.items.set(res.items);
      this.total.set(res.total);
    } finally {
      this.loading.set(false);
    }
  }
}
