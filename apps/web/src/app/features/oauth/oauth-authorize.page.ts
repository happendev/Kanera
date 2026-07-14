import { DOCUMENT } from "@angular/common";
import { ChangeDetectionStrategy, Component, inject, input, signal } from "@angular/core";
import type { OnInit } from "@angular/core";
import { ApiClient } from "../../core/api/api.client";

interface ConsentContext {
  clientName: string;
  scopes: string[];
  redirectUri: string;
}

@Component({
  selector: "k-oauth-authorize",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="consent-card">
      <i class="ti ti-plug-connected consent-icon"></i>
      <h1>Connect {{ context()?.clientName || "AI agent" }}</h1>
      @if (loading()) {
        <p>Checking this connection…</p>
      } @else if (error(); as message) {
        <p class="error">{{ message }}</p>
      } @else {
        <p>This agent will act as you in Kanera. It will be able to:</p>
        <ul>
          <li><i class="ti ti-eye"></i> Read boards, cards, notes, comments, and activity you can access</li>
          @if (canWrite()) {
            <li><i class="ti ti-edit"></i> Create and update board content wherever you are an editor</li>
            <li><i class="ti ti-settings"></i> Create and administer workspaces wherever you are an administrator</li>
          }
          <li><i class="ti ti-lock"></i> Stay limited to your current Kanera permissions</li>
        </ul>
        <p class="muted">You can revoke this connection from Settings → AI agents.</p>
        <div class="actions">
          <button type="button" class="ghost" (click)="cancel()" [disabled]="busy()">Cancel</button>
          <button type="button" (click)="approve()" [disabled]="busy()">{{ busy() ? "Connecting…" : "Allow access" }}</button>
        </div>
      }
    </main>
  `,
  styles: [`
    :host { min-height: 100vh; display: grid; place-items: center; background: var(--background); padding: 1rem; }
    .consent-card { width: min(480px, 100%); border: 1px solid var(--border); border-radius: 12px; padding: 2rem; background: var(--card); box-shadow: 0 12px 40px rgb(0 0 0 / .08); }
    .consent-icon { font-size: 2rem; }
    h1 { margin: .75rem 0; font-size: 1.35rem; }
    p, li { color: var(--muted-foreground); line-height: 1.5; }
    ul { display: grid; gap: .65rem; padding: 0; list-style: none; }
    li { display: flex; gap: .55rem; align-items: flex-start; }
    .muted { font-size: .82rem; }
    .error { color: var(--destructive, #dc2626); }
    .actions { display: flex; justify-content: flex-end; gap: .5rem; margin-top: 1.5rem; }
    button { border: 1px solid var(--border); border-radius: 8px; padding: .55rem .9rem; cursor: pointer; }
    button:not(.ghost) { background: var(--primary); color: var(--primary-foreground); }
    button:disabled { opacity: .6; cursor: default; }
  `],
})
export class OauthAuthorizePage implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly document = inject(DOCUMENT);

  readonly response_type = input.required<string>();
  readonly client_id = input.required<string>();
  readonly redirect_uri = input.required<string>();
  readonly code_challenge = input.required<string>();
  readonly code_challenge_method = input.required<string>();
  readonly state = input<string>();
  readonly scope = input("kanera:read kanera:write offline_access");
  readonly resource = input<string>();
  readonly context = signal<ConsentContext | null>(null);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly canWrite = () => this.context()?.scopes.includes("kanera:write") ?? false;

  async ngOnInit() {
    try {
      this.context.set(await this.api.get<ConsentContext>(`/oauth/authorize/context?${this.params().toString()}`));
    } catch {
      this.error.set("This connection request is invalid, expired, or no longer registered.");
    } finally {
      this.loading.set(false);
    }
  }

  async approve() {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const result = await this.api.post<{ redirectUrl: string }>("/oauth/authorize/consent", Object.fromEntries(this.params()));
      this.document.location.assign(result.redirectUrl);
    } catch {
      this.error.set("Kanera could not authorize this agent. Check your plan and try again.");
      this.busy.set(false);
    }
  }

  cancel() {
    // Redirect only to the URI the server confirmed is registered for this client (returned in the
    // consent context), never the raw redirect_uri query input — otherwise a crafted link could turn
    // the Cancel button into an open redirect to an arbitrary origin.
    const registered = this.context()?.redirectUri;
    if (!registered) return;
    const redirect = new URL(registered);
    redirect.searchParams.set("error", "access_denied");
    if (this.state()) redirect.searchParams.set("state", this.state()!);
    this.document.location.assign(redirect.toString());
  }

  private params() {
    const params = new URLSearchParams({
      response_type: this.response_type(), client_id: this.client_id(), redirect_uri: this.redirect_uri(),
      code_challenge: this.code_challenge(), code_challenge_method: this.code_challenge_method(), scope: this.scope(),
    });
    if (this.state()) params.set("state", this.state()!);
    if (this.resource()) params.set("resource", this.resource()!);
    return params;
  }
}
