import { ChangeDetectionStrategy, Component, inject, input, signal } from "@angular/core";
import type { OnInit } from "@angular/core";
import { Router } from "@angular/router";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { AuthService, authenticatedLandingPath, type AuthUser } from "../../core/auth/auth.service";
import { SocketService } from "../../core/realtime/socket.service";
import { LogoComponent } from "../../shared/logo.component";

interface InviteDetails {
  orgName: string;
  orgRole: "owner" | "admin" | "member";
  expiresAt: string | null;
  workspaces: { workspaceId: string; workspaceName: string; role: "admin" | "member" }[];
}

@Component({
  selector: "k-org-invite",
  standalone: true,
  imports: [LogoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./invite.page.html",
  styleUrl: "../board-invite/board-invite.page.scss",
})
export class InvitePage implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly sockets = inject(SocketService);

  readonly token = input<string | undefined>(undefined);
  readonly invite = signal<InviteDetails | null>(null);
  readonly state = signal<"loading" | "ready" | "invalid" | "error">("loading");
  readonly busy = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly isLoggedIn = this.auth.isAuthenticated;

  async ngOnInit() {
    const token = this.token();
    if (!token) return this.state.set("invalid");
    try {
      this.invite.set(await this.api.get<InviteDetails>(`/invites/lookup?token=${encodeURIComponent(token)}`));
      this.state.set("ready");
    } catch {
      this.state.set("invalid");
    }
  }

  async accept() {
    const token = this.token();
    if (!token) return;
    this.busy.set(true);
    this.errorMessage.set(null);
    // Acceptance switches the active organisation and the server evicts existing sockets. Mark the
    // disconnect as intentional before the request so the eviction cannot race a stale /me refresh
    // against the replacement session returned below.
    this.sockets.pauseForOrganisationSwitch();
    try {
      const session = await this.api.post<{ accessToken: string; user: AuthUser }>("/invites/accept", { token });
      this.auth.setSession(session.accessToken, session.user);
      await this.router.navigateByUrl(authenticatedLandingPath(session.user), { replaceUrl: true });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) this.errorMessage.set("You already belong to this organisation.");
      else if (error instanceof ApiError && (error.body as { code?: string } | null)?.code === "SEAT_LIMIT_REACHED") {
        this.errorMessage.set("This organisation has no available seats. Ask an admin to purchase more, then try again.");
      } else this.errorMessage.set("Could not accept the invitation.");
    } finally {
      this.sockets.resumeAfterOrganisationSwitch();
      this.busy.set(false);
    }
  }

  signupUrl(): string {
    return this.token() ? `/signup?invite=${encodeURIComponent(this.token()!)}` : "/signup";
  }

  loginUrl(): string {
    const redirect = this.token() ? `/invite?token=${encodeURIComponent(this.token()!)}` : "/";
    return `/login?returnUrl=${encodeURIComponent(redirect)}`;
  }
}
