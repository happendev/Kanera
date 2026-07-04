import { ChangeDetectionStrategy, Component, type OnInit, inject, signal } from "@angular/core";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { ToastService } from "../../shared/toast.service";
import { TableControlsComponent, TablePagerComponent } from "../../shared/table-controls.component";

type QueueKey = "email-queue" | "webhook-deliveries" | "event-outbox";
type Row = Record<string, unknown>;

interface QueueTab {
  key: QueueKey;
  label: string;
  // Columns to render for this queue's rows (field name + header).
  columns: { field: string; header: string }[];
}

const TABS: QueueTab[] = [
  {
    key: "email-queue",
    label: "Email queue",
    columns: [
      { field: "toEmail", header: "To" },
      { field: "type", header: "Type" },
      { field: "status", header: "Status" },
      { field: "retries", header: "Retries" },
      { field: "lastError", header: "Last error" },
    ],
  },
  {
    key: "webhook-deliveries",
    label: "Webhook deliveries",
    columns: [
      { field: "eventType", header: "Event" },
      { field: "status", header: "Status" },
      { field: "attempts", header: "Attempts" },
      { field: "responseStatus", header: "Response" },
      { field: "lastError", header: "Last error" },
    ],
  },
  {
    key: "event-outbox",
    label: "Event outbox",
    columns: [
      { field: "eventType", header: "Event" },
      { field: "scope", header: "Scope" },
      { field: "realtimeDispatched", header: "Realtime" },
      { field: "webhooksEnqueued", header: "Webhooks" },
      { field: "attempts", header: "Attempts" },
    ],
  },
];

@Component({
  selector: "a-ops-page",
  standalone: true,
  imports: [TableControlsComponent, TablePagerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="page-head">
      <h1>Ops &amp; Queues</h1>
    </header>

    <div class="tabs">
      @for (t of tabs; track t.key) {
        <button class="tab" [class.active]="active().key === t.key" type="button" (click)="select(t)">{{ t.label }}</button>
      }
    </div>
    <a-table-controls [query]="query()" placeholder="Search this queue…" [page]="page()" [pageSize]="pageSize()" [total]="total()" [loading]="loading()" (queryChange)="search($event)" (pageChange)="go($event)" (pageSizeChange)="resize($event)" />

    @if (loading()) {
      <p class="muted">Loading…</p>
    } @else {
      <table class="data">
        <thead>
          <tr>
            @for (c of active().columns; track c.field) { <th><button class="sort" (click)="orderBy(sortKey(c.field))">{{ c.header }} {{ arrow(sortKey(c.field)) }}</button></th> }
            <th></th>
          </tr>
        </thead>
        <tbody>
          @for (row of rows(); track $any(row)['id']) {
            <tr>
              @for (c of active().columns; track c.field) {
                <td class="cell">{{ display($any(row)[c.field]) }}</td>
              }
              <td class="row-actions">
                <button class="btn btn-sm" type="button" (click)="act($any(row)['id'] + '', 'retry')">Retry</button>
                <button class="btn btn-sm btn-danger" type="button" (click)="act($any(row)['id'] + '', 'cancel')">Cancel</button>
              </td>
            </tr>
          } @empty {
            <tr><td [attr.colspan]="active().columns.length + 1" class="muted">No rows.</td></tr>
          }
        </tbody>
      </table>
      <a-table-pager [page]="page()" [pageSize]="pageSize()" [total]="total()" [loading]="loading()" (pageChange)="go($event)" (pageSizeChange)="resize($event)" />
    }
  `,
  styles: [
    `
      .page-head { margin-bottom: 18px; }
      h1 { font-size: 20px; margin: 0; }
      .tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--border); }
      .tab { background: none; border: none; padding: 8px 12px; color: var(--text-muted); font-size: 13px; font-weight: 500; cursor: pointer; border-bottom: 2px solid transparent; }
      .tab.active { color: var(--text); border-bottom-color: var(--accent); }
      .cell { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .row-actions { display: flex; gap: 6px; justify-content: flex-end; }
      .sort { border:0;background:none;padding:0;font:inherit;font-weight:inherit;color:inherit;cursor:pointer; }
    `,
  ],
})
export class OpsPage implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly toasts = inject(ToastService);

  readonly tabs = TABS;
  readonly active = signal<QueueTab>(TABS[0]!);
  readonly rows = signal<Row[]>([]);
  readonly loading = signal(true);
  readonly total=signal(0); readonly page=signal(1); readonly pageSize=signal(25); readonly query=signal(""); readonly sort=signal("createdAt"); readonly direction=signal<"asc"|"desc">("desc"); private timer:ReturnType<typeof setTimeout>|null=null;

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  select(tab: QueueTab): void {
    this.active.set(tab);
    this.page.set(1); this.query.set(""); this.sort.set("createdAt"); this.direction.set("desc");
    void this.load();
  }
  search(v:string){this.query.set(v);if(this.timer)clearTimeout(this.timer);this.timer=setTimeout(()=>{this.page.set(1);void this.load()},250)} go(p:number){this.page.set(p);void this.load()} resize(s:number){this.pageSize.set(s);this.page.set(1);void this.load()}
  sortKey(field:string):string { if(field==="status"||field==="realtimeDispatched"||field==="webhooksEnqueued")return "status";if(field==="retries"||field==="attempts")return "attempts";if(field==="lastError")return "lastError";return "primary"; }
  orderBy(s:string){if(this.sort()===s)this.direction.update(d=>d==="asc"?"desc":"asc");else{this.sort.set(s);this.direction.set("asc")}this.page.set(1);void this.load()} arrow(s:string){return this.sort()===s?(this.direction()==="asc"?"↑":"↓"):""}

  display(value: unknown): string {
    if (value === null || value === undefined) return "—";
    if (typeof value === "boolean") return value ? "yes" : "no";
    if (typeof value === "object") return JSON.stringify(value);
    // Remaining runtime types are primitives (string/number); safe to interpolate.
    return `${value as string | number}`;
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const p=new URLSearchParams({page:String(this.page()),pageSize:String(this.pageSize()),sort:this.sort(),direction:this.direction()});if(this.query().trim())p.set("q",this.query().trim());
      const res = await this.api.get<{ items: Row[]; total:number }>(`/admin/ops/${this.active().key}?${p}`);
      this.rows.set(res.items);
      this.total.set(res.total);
    } finally {
      this.loading.set(false);
    }
  }

  act(id: string, action: "retry" | "cancel"): void {
    void (async () => {
      try {
        await this.api.post(`/admin/ops/${this.active().key}/${id}/${action}`);
        this.toasts.success(action === "retry" ? "Requeued" : "Cancelled");
        await this.load();
      } catch (err) {
        this.toasts.error(err instanceof ApiError ? err.serverMessage : "Action failed");
      }
    })();
  }
}
