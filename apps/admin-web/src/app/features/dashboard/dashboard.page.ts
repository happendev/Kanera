import { ChangeDetectionStrategy, Component, type ElementRef, type OnDestroy, type OnInit, effect, inject, signal, viewChild } from "@angular/core";
import { Chart, type ChartConfiguration, registerables } from "chart.js";
import { ApiClient } from "../../core/api/api.client";

interface OpsHealth {
  emailQueue: Record<string, number>;
  webhookDeliveries: Record<string, number>;
  eventOutbox: { pending: number; dispatched: number; total: number };
  orgs: { total: number; suspended: number; deleted: number };
  users: { total: number; suspended: number; deleted: number };
  storageUsedBytes: number;
  trends: { date: string; activeUsers: number; registrations: number; cards: number; boards: number; automationEffectful: number; automationNoop: number; automationFailed: number }[];
}

type TrendDays = 30 | 60 | 90;

Chart.register(...registerables);

@Component({
  selector: "a-dashboard-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="page-head">
      <h1>Dashboard</h1>
      <label class="period-picker">
        <span class="muted small">Period</span>
        <select [value]="trendDays()" (input)="changeTrendDays(+$any($event.target).value)">
          <option value="30" [selected]="trendDays() === 30">30 days</option>
          <option value="60" [selected]="trendDays() === 60">60 days</option>
          <option value="90" [selected]="trendDays() === 90">90 days</option>
        </select>
      </label>
    </header>

    @if (loading()) {
      <p class="muted">Loading…</p>
    } @else if (health(); as h) {
      <div class="grid">
        <div class="card">
          <div class="stat-label">Organisations</div>
          <div class="stat">{{ h.orgs.total }}</div>
          <div class="muted small">{{ h.orgs.suspended }} suspended · {{ h.orgs.deleted }} deleted</div>
        </div>
        <div class="card">
          <div class="stat-label">Users</div>
          <div class="stat">{{ h.users.total }}</div>
          <div class="muted small">{{ h.users.suspended }} suspended · {{ h.users.deleted }} deleted</div>
        </div>
        <div class="card">
          <div class="stat-label">Storage used</div>
          <div class="stat">{{ formatBytes(h.storageUsedBytes) }}</div>
          <div class="muted small">Across all organisations</div>
        </div>
        <div class="card">
          <div class="stat-label">Email queue (failed)</div>
          <div class="stat">{{ h.emailQueue["error"] }}</div>
          <div class="muted small">{{ h.emailQueue["queued"] }} queued</div>
        </div>
        <div class="card">
          <div class="stat-label">Webhooks (failed)</div>
          <div class="stat">{{ h.webhookDeliveries["failed"] }}</div>
          <div class="muted small">{{ h.webhookDeliveries["queued"] }} queued</div>
        </div>
        <div class="card">
          <div class="stat-label">Event outbox (pending)</div>
          <div class="stat">{{ h.eventOutbox.pending }}</div>
          <div class="muted small">{{ h.eventOutbox.total }} total</div>
        </div>
      </div>
      <div class="trend-grid">
        <section class="card trends">
          <div class="chart-head">
            <div>
              <h2>Users</h2>
              <p class="muted small">Active users and registrations</p>
            </div>
          </div>
          <div class="chart-wrap"><canvas #usersChart></canvas></div>
        </section>
        <section class="card trends">
          <div class="chart-head">
            <div>
              <h2>Work created</h2>
              <p class="muted small">Boards and cards</p>
            </div>
          </div>
          <div class="chart-wrap"><canvas #workChart></canvas></div>
        </section>
        <section class="card trends">
          <div class="chart-head"><div><h2>Automation runs</h2><p class="muted small">Effectful, no-op, and failed runs</p></div></div>
          <div class="chart-wrap"><canvas #automationChart></canvas></div>
        </section>
      </div>
    } @else {
      <p class="badge badge-danger">Failed to load health</p>
    }
  `,
  styles: [
    `
      .page-head {
        align-items: center;
        display: flex;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 18px;
      }
      h1 {
        font-size: 20px;
        margin: 0;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: 14px;
      }
      .stat-label {
        font-size: 12px;
        color: var(--text-muted);
      }
      .stat {
        font-size: 30px;
        font-weight: 600;
        margin: 6px 0 2px;
      }
      .small {
        font-size: 11px;
      }
      .trends {
        min-width: 0;
      }
      .trend-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 14px;
        margin-top: 14px;
      }
      .chart-head h2 {
        font-size: 15px;
        margin: 0 0 3px;
      }
      .chart-head {
        align-items: center;
        display: flex;
        justify-content: space-between;
        gap: 16px;
      }
      .period-picker {
        align-items: center;
        display: flex;
        gap: 8px;
      }
      .period-picker select {
        min-width: 105px;
      }
      .chart-head p {
        margin: 0;
      }
      .chart-wrap {
        height: 340px;
        margin-top: 18px;
        position: relative;
      }
    `,
  ],
})
export class DashboardPage implements OnInit, OnDestroy {
  private readonly api = inject(ApiClient);
  private readonly usersCanvas = viewChild<ElementRef<HTMLCanvasElement>>("usersChart");
  private readonly workCanvas = viewChild<ElementRef<HTMLCanvasElement>>("workChart");
  private readonly automationCanvas = viewChild<ElementRef<HTMLCanvasElement>>("automationChart");
  private usersChart: Chart | null = null;
  private workChart: Chart | null = null;
  private automationChart: Chart | null = null;
  readonly health = signal<OpsHealth | null>(null);
  readonly loading = signal(true);
  readonly trendDays = signal<TrendDays>(30);

  constructor() {
    effect(() => {
      const usersCanvas = this.usersCanvas();
      const workCanvas = this.workCanvas();
      const automationCanvas = this.automationCanvas();
      const health = this.health();
      if (!usersCanvas || !workCanvas || !automationCanvas || !health) return;
      this.renderCharts(usersCanvas.nativeElement, workCanvas.nativeElement, automationCanvas.nativeElement, health.trends);
    });
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** unit;
    return `${value.toLocaleString(undefined, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
  }

  async ngOnInit(): Promise<void> {
    await this.loadHealth();
  }

  async changeTrendDays(days: number): Promise<void> {
    if (days !== 30 && days !== 60 && days !== 90) return;
    this.trendDays.set(days);
    await this.loadHealth();
  }

  private async loadHealth(): Promise<void> {
    try {
      this.health.set(await this.api.get<OpsHealth>(`/admin/ops/health?days=${this.trendDays()}`));
    } finally {
      this.loading.set(false);
    }
  }

  ngOnDestroy(): void {
    this.usersChart?.destroy();
    this.workChart?.destroy();
    this.automationChart?.destroy();
  }

  private renderCharts(usersCanvas: HTMLCanvasElement, workCanvas: HTMLCanvasElement, automationCanvas: HTMLCanvasElement, trends: OpsHealth["trends"]): void {
    this.usersChart?.destroy();
    this.workChart?.destroy();
    this.automationChart?.destroy();
    const labels = trends.map((row) => new Date(`${row.date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    const options: ChartConfiguration<"line">["options"] = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      plugins: { legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 8 } } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, x: { grid: { display: false } } },
    };
    this.usersChart = new Chart(usersCanvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "Active users", data: trends.map((row) => row.activeUsers), borderColor: "#2563eb", backgroundColor: "#2563eb", tension: 0.3 },
          { label: "Registrations", data: trends.map((row) => row.registrations), borderColor: "#16a34a", backgroundColor: "#16a34a", tension: 0.3 },
        ],
      },
      options,
    });
    this.workChart = new Chart(workCanvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "Cards", data: trends.map((row) => row.cards), borderColor: "#9333ea", backgroundColor: "#9333ea", tension: 0.3 },
          { label: "Boards", data: trends.map((row) => row.boards), borderColor: "#ea580c", backgroundColor: "#ea580c", tension: 0.3 },
        ],
      },
      options,
    });
    this.automationChart = new Chart(automationCanvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "Effectful", data: trends.map((row) => row.automationEffectful), borderColor: "#16a34a", backgroundColor: "#16a34a", tension: 0.3 },
          { label: "No-op", data: trends.map((row) => row.automationNoop), borderColor: "#64748b", backgroundColor: "#64748b", tension: 0.3 },
          { label: "Failed", data: trends.map((row) => row.automationFailed), borderColor: "#dc2626", backgroundColor: "#dc2626", tension: 0.3 },
        ],
      },
      options,
    });
  }
}
