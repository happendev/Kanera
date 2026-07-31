import { ChangeDetectionStrategy, Component, inject, input, signal } from "@angular/core";
import type { OnInit } from "@angular/core";
import { ApiClient } from "../../core/api/api.client";

interface DeviceContext {
  clientName: string;
  scopes: string[];
  userCode: string;
  expiresAt: string;
}

@Component({
  selector: "k-oauth-device",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="device-card">
      <i class="ti ti-device-desktop-code device-icon"></i>
      @if (completed(); as result) {
        <h1>{{ result === "approved" ? "Device connected" : "Request denied" }}</h1>
        <p>
          {{ result === "approved"
            ? "You can return to your terminal. The client will finish connecting automatically."
            : "The device was not given access to your Kanera account." }}
        </p>
      } @else if (context(); as request) {
        <h1>Connect {{ request.clientName }}</h1>
        <p>Confirm that the code shown in your terminal matches:</p>
        <div class="code">{{ request.userCode }}</div>
        <p>This client will act as you in Kanera. It will be able to:</p>
        <ul>
          <li><i class="ti ti-eye"></i> Read work you can access</li>
          @if (request.scopes.includes("kanera:write")) {
            <li><i class="ti ti-edit"></i> Create and update work wherever you have permission</li>
          }
          <li><i class="ti ti-lock"></i> Stay limited to your current Kanera permissions</li>
        </ul>
        <p class="muted">Only approve this request if you started it. You can revoke it later from Settings → AI agents.</p>
        @if (error(); as message) { <p class="error">{{ message }}</p> }
        <div class="actions">
          <button type="button" class="ghost" (click)="decide('deny')" [disabled]="busy()">Deny</button>
          <button type="button" (click)="decide('approve')" [disabled]="busy()">{{ busy() ? "Connecting…" : "Allow access" }}</button>
        </div>
      } @else {
        <h1>Connect a device</h1>
        <p>Enter the code shown by your CLI or headless client.</p>
        <form (submit)="lookup($event)">
          <input
            type="text"
            aria-label="Device code"
            autocomplete="one-time-code"
            autocapitalize="characters"
            placeholder="ABCD-2345"
            [value]="enteredCode()"
            (input)="enteredCode.set($any($event.target).value)"
            [disabled]="loading()"
          />
          <button type="submit" [disabled]="loading() || !enteredCode().trim()">{{ loading() ? "Checking…" : "Continue" }}</button>
        </form>
        @if (error(); as message) { <p class="error">{{ message }}</p> }
      }
    </main>
  `,
  styles: [`
    :host { min-height: 100vh; display: grid; place-items: center; background: var(--background); padding: 1rem; }
    .device-card { width: min(480px, 100%); border: 1px solid var(--border); border-radius: 12px; padding: 2rem; background: var(--card); box-shadow: 0 12px 40px rgb(0 0 0 / .08); }
    .device-icon { font-size: 2rem; }
    h1 { margin: .75rem 0; font-size: 1.35rem; }
    p, li { color: var(--muted-foreground); line-height: 1.5; }
    .code { margin: 1rem 0; border: 1px solid var(--border); border-radius: 8px; padding: .8rem; text-align: center; font: 600 1.25rem/1.2 monospace; letter-spacing: .12em; }
    ul { display: grid; gap: .65rem; padding: 0; list-style: none; }
    li { display: flex; gap: .55rem; align-items: flex-start; }
    form { display: flex; gap: .5rem; margin-top: 1.25rem; }
    input { min-width: 0; flex: 1; border: 1px solid var(--border); border-radius: 8px; padding: .6rem .75rem; background: var(--background); color: var(--foreground); text-transform: uppercase; }
    .muted { font-size: .82rem; }
    .error { color: var(--destructive, #dc2626); }
    .actions { display: flex; justify-content: flex-end; gap: .5rem; margin-top: 1.5rem; }
    button { border: 1px solid var(--border); border-radius: 8px; padding: .55rem .9rem; cursor: pointer; background: var(--primary); color: var(--primary-foreground); }
    button.ghost { background: transparent; color: var(--foreground); }
    button:disabled { opacity: .6; cursor: default; }
  `],
})
export class OauthDevicePage implements OnInit {
  private readonly api = inject(ApiClient);

  readonly user_code = input("");
  readonly enteredCode = signal("");
  readonly context = signal<DeviceContext | null>(null);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly completed = signal<"approved" | "denied" | null>(null);

  async ngOnInit() {
    const initial = this.user_code().trim();
    if (!initial) return;
    this.enteredCode.set(initial);
    await this.loadContext(initial);
  }

  async lookup(event: Event) {
    event.preventDefault();
    await this.loadContext(this.enteredCode());
  }

  async decide(decision: "approve" | "deny") {
    const request = this.context();
    if (!request || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.post("/oauth/device/consent", { user_code: request.userCode, decision });
      this.completed.set(decision === "approve" ? "approved" : "denied");
      this.context.set(null);
    } catch {
      this.error.set("This request is invalid, expired, or has already been completed.");
      this.busy.set(false);
    }
  }

  private async loadContext(code: string) {
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set(null);
    this.context.set(null);
    try {
      const params = new URLSearchParams({ user_code: code });
      this.context.set(await this.api.get<DeviceContext>(`/oauth/device/context?${params.toString()}`));
    } catch {
      this.error.set("That device code is invalid or expired. Check the code and try again.");
    } finally {
      this.loading.set(false);
    }
  }
}
