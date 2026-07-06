import { DOCUMENT } from "@angular/common";
import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import type { OnInit } from "@angular/core";
import { Router } from "@angular/router";
import { environment } from "../../../environments/environment";
import { AuthService, type AuthUser } from "../../core/auth/auth.service";

// Consumption surface for a support-session token minted from the management portal (a superadmin runs
// POST /admin/orgs/:clientId/support-session). Normally the portal opens this page with the token in the
// URL fragment; this manual form is the paste fallback. The page loads the target org's /me with the
// token and installs an in-memory support session. There is no way to *start* a session from the tenant
// app — this only consumes a token an operator already obtained from the portal.
@Component({
  selector: "k-support-enter",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="support-enter">
      <h1>Enter support session</h1>
      <p>Paste the support-session token generated for you in the management portal. It acts as the target org's owner and expires on its own.</p>
      <form (submit)="submit($event)">
        <textarea
          [value]="token()"
          (input)="token.set($any($event.target).value)"
          rows="5"
          placeholder="Support session token"
          autocomplete="off"
          spellcheck="false"
        ></textarea>
        @if (error(); as message) {
        <p class="support-enter__error">{{ message }}</p>
        }
        <button type="submit" [disabled]="busy() || !token().trim()">
          {{ busy() ? "Entering…" : "Enter session" }}
        </button>
      </form>
    </div>
  `,
  styles: [
    `
    .support-enter {
      max-width: 560px;
      margin: 4rem auto;
      padding: 0 1rem;
    }
    .support-enter h1 {
      font-size: 1.25rem;
      margin-bottom: 0.5rem;
    }
    .support-enter p {
      color: var(--muted-foreground, #6b7280);
      font-size: 0.875rem;
      margin-bottom: 1rem;
    }
    .support-enter textarea {
      width: 100%;
      font-family: monospace;
      font-size: 0.8125rem;
      padding: 0.5rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 8px;
      resize: vertical;
    }
    .support-enter__error {
      color: #dc2626;
      margin: 0.5rem 0;
    }
    .support-enter button {
      margin-top: 0.75rem;
      padding: 0.5rem 1rem;
      border-radius: 8px;
      border: 1px solid var(--border, #e5e7eb);
      cursor: pointer;
    }
    .support-enter button:disabled {
      opacity: 0.6;
      cursor: default;
    }
    `,
  ],
})
export class SupportEnterPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);

  readonly token = signal("");
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  ngOnInit(): void {
    // The API returns the token in a fragment so it never reaches the web server or referrer header.
    // Consume it into component state, then remove it from browser history before the operator enters.
    const params = new URLSearchParams(this.document.location.hash.slice(1));
    const token = params.get("token");
    if (!token) return;

    this.token.set(token);
    this.document.defaultView?.history.replaceState(null, "", `${this.document.location.pathname}${this.document.location.search}`);
  }

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    const token = this.token().trim();
    if (!token || this.busy()) return;

    this.error.set(null);
    this.busy.set(true);
    try {
      const sessionId = supportSessionIdFromToken(token);
      if (!sessionId) {
        this.error.set("That token is not a support-session token.");
        return;
      }

      let res: Response;
      try {
        res = await fetch(`${environment.apiUrl}/me`, { headers: { Authorization: `Bearer ${token}` } });
      } catch {
        this.error.set("Unable to reach the server.");
        return;
      }
      if (!res.ok) {
        this.error.set("The token is invalid or has expired.");
        return;
      }

      const user = (await res.json()) as AuthUser;
      this.auth.enterSupportSession(token, user, { sessionId, orgName: user.orgName });
      await this.router.navigateByUrl("/");
    } finally {
      this.busy.set(false);
    }
  }
}

// Decode the JWT payload (no verification — the server verifies on every request) to recover the
// support session id so the banner's "End session" can close the audit row. Returns null for any
// token that is not a support-session token.
function supportSessionIdFromToken(token: string): string | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(json) as { authKind?: string; support?: { sessionId?: string } };
    if (payload.authKind !== "support") return null;
    return payload.support?.sessionId ?? null;
  } catch {
    return null;
  }
}
