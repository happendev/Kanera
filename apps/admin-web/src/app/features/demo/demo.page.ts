import { ChangeDetectionStrategy, Component, type OnInit, computed, inject, signal } from "@angular/core";
import type { AdminDemoResetBody, AdminDemoResetResponse, AdminDemoStatus } from "@kanera/shared/dto";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { ConfirmService } from "../../shared/confirm.service";
import { ToastService } from "../../shared/toast.service";

@Component({
  selector: "a-demo-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="page-head">
      <div>
        <h1>Demo data</h1>
        <p class="muted">Create or restore the complete paid demo environment from Kanera's seed data.</p>
      </div>
    </header>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>{{ status()?.exists ? "Reset demo environment" : "Create demo environment" }}</h2>
          <p class="muted">
            The reset permanently deletes both reserved demo organisations, every database record they
            own, and their complete image/file storage namespaces before recreating the seed.
          </p>
          <label class="password-field">
            <span>Demo password</span>
            <input
              class="input"
              type="password"
              autocomplete="new-password"
              minlength="8"
              maxlength="200"
              placeholder="At least 8 characters"
              [value]="password()"
              (input)="password.set($any($event.target).value)"
            />
            <small class="muted">Used by every seeded login. It remains the same on future resets when you enter the same value.</small>
          </label>
        </div>
        <button class="btn btn-danger" type="button" [disabled]="loading() || resetting() || !passwordValid()" (click)="reset()">
          @if (resetting()) {
            <i class="ti ti-loader-2 spin"></i>
            Resetting…
          } @else {
            <i class="ti ti-refresh"></i>
            {{ status()?.exists ? "Reset demo data" : "Create demo data" }}
          }
        </button>
      </div>

      @if (loading()) {
        <p class="muted loading">Checking demo status…</p>
      } @else if (status(); as current) {
        <div class="status-grid">
          <div><span class="label">Status</span><strong>{{ current.exists ? "Ready" : "Not created" }}</strong></div>
          <div><span class="label">Primary login</span><strong>{{ current.primaryEmail }}</strong></div>
          <div><span class="label">Users</span><strong>{{ current.userCount }}</strong></div>
          <div><span class="label">Access</span><strong>Paid / full</strong></div>
        </div>
        @if (current.organisations.length) {
          <div class="orgs">
            @for (organisation of current.organisations; track organisation.id) {
              <span class="badge">{{ organisation.name }} · {{ organisation.plan }} / {{ organisation.billingStatus }}</span>
            }
          </div>
        }
      }
    </section>

    @if (result(); as created) {
      <section class="panel credentials">
        <div class="panel-head">
          <div>
            <h2>New demo credentials</h2>
            <p class="muted">These credentials use the password you set for this reset.</p>
          </div>
          <button class="btn" type="button" (click)="copyCredentials(created)">
            <i class="ti ti-copy"></i>
            Copy all
          </button>
        </div>
        <div class="primary">
          <span class="label">Recommended login</span>
          <code>{{ created.primaryEmail }}</code>
        </div>
        <div class="primary">
          <span class="label">Shared strong password</span>
          <code>{{ created.password }}</code>
        </div>
        <details>
          <summary>All {{ created.loginEmails.length }} login emails</summary>
          <ul>
            @for (email of created.loginEmails; track email) {
              <li><code>{{ email }}</code></li>
            }
          </ul>
        </details>
        <p class="muted counts">
          Created {{ created.summary.workspaces }} workspaces, {{ created.summary.boards }} boards,
          {{ created.summary.cards }} cards, and {{ created.summary.attachments }} attachments.
        </p>
      </section>
    }
  `,
  styles: [`
    .page-head { margin-bottom: 18px; }
    h1 { margin: 0 0 4px; font-size: 20px; }
    h2 { margin: 0 0 6px; font-size: 15px; }
    p { margin: 0; line-height: 1.5; }
    .panel { max-width: 900px; margin-bottom: 16px; padding: 20px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
    .panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
    .panel-head > div { max-width: 640px; }
    .panel-head .btn { flex: none; }
    .password-field { display: grid; gap: 6px; max-width: 420px; margin-top: 16px; color: var(--text); font-size: 13px; font-weight: 500; }
    .password-field small { font-size: 12px; font-weight: 400; }
    .loading { margin-top: 20px; }
    .status-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 20px; }
    .status-grid > div, .primary { display: flex; flex-direction: column; gap: 5px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); }
    .label { color: var(--text-muted); font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: .04em; }
    strong, code { font-size: 13px; }
    .orgs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
    .badge { padding: 4px 8px; border: 1px solid var(--border); border-radius: 999px; color: var(--text-muted); font-size: 12px; }
    .credentials { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
    .primary { margin-top: 12px; }
    code { overflow-wrap: anywhere; color: var(--text); }
    details { margin-top: 14px; }
    summary { cursor: pointer; color: var(--text-muted); font-size: 13px; }
    ul { columns: 2; margin: 10px 0 0; padding-left: 22px; }
    li { margin: 5px 0; }
    .counts { margin-top: 14px; }
    .spin { animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (max-width: 800px) {
      .panel-head { flex-direction: column; }
      .status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      ul { columns: 1; }
    }
  `],
})
export class DemoPage implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly confirm = inject(ConfirmService);
  private readonly toasts = inject(ToastService);

  readonly loading = signal(true);
  readonly resetting = signal(false);
  readonly status = signal<AdminDemoStatus | null>(null);
  readonly result = signal<AdminDemoResetResponse | null>(null);
  readonly password = signal("");
  readonly passwordValid = computed(() => this.password().length >= 8 && this.password().length <= 200);

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async reset(): Promise<void> {
    const accepted = await this.confirm.open({
      title: this.status()?.exists ? "Reset all demo data?" : "Create demo data?",
      message: "This permanently hard-deletes the reserved demo accounts and all of their stored files before recreating them. Existing demo sessions will stop working.",
      confirmLabel: this.status()?.exists ? "Reset demo" : "Create demo",
      danger: true,
    });
    if (!accepted) return;

    this.resetting.set(true);
    this.result.set(null);
    try {
      const body: AdminDemoResetBody = { password: this.password() };
      const created = await this.api.post<AdminDemoResetResponse>("/admin/demo/reset", body);
      this.result.set(created);
      this.toasts.success("Demo data is ready");
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof ApiError ? error.serverMessage : "Demo reset failed");
    } finally {
      this.resetting.set(false);
    }
  }

  async copyCredentials(created: AdminDemoResetResponse): Promise<void> {
    const text = [
      `Primary login: ${created.primaryEmail}`,
      `Password: ${created.password}`,
      "",
      "All login emails:",
      ...created.loginEmails,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      this.toasts.success("Credentials copied");
    } catch {
      this.toasts.error("Could not copy credentials");
    }
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.status.set(await this.api.get<AdminDemoStatus>("/admin/demo"));
    } catch (error) {
      this.toasts.error(error instanceof ApiError ? error.serverMessage : "Could not load demo status");
    } finally {
      this.loading.set(false);
    }
  }
}
