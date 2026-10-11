import { ChangeDetectionStrategy, Component, inject, input, signal } from "@angular/core";
import type { OnInit } from "@angular/core";
import { Router } from "@angular/router";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { isMfaEnrollmentRequired, MFA_ENROLLMENT_HANDOFF_KEY, type MfaEnrollmentRequiredResponse } from "../../core/auth/auth-response";
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
  readonly state = signal<"loading" | "ready" | "invalid">("loading");
  readonly busy = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly isLoggedIn = this.auth.isAuthenticated;

  async ngOnInit() {
    // Invite links are opened cold (email, chat), so the refresh cookie is the only session state at
    // this point. Hydrate before choosing between the Join button and the signup/login links, as the
    // board-invite page does, so a signed-in recipient is not shown "Create account".
    await this.auth.hydrate();
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
      const session = await this.api.post<{ accessToken: string; user: AuthUser } | MfaEnrollmentRequiredResponse>("/invites/accept", { token });
      if (isMfaEnrollmentRequired(session)) {
        // Membership was granted and the active organisation already moved, but the new organisation
        // mandates MFA so no session for it was issued. The previous organisation's in-memory token is
        // dropped (a refresh would now be refused anyway) and the login page completes enrollment.
        this.auth.clearSession();
        await this.router.navigateByUrl("/login", { replaceUrl: true, state: { [MFA_ENROLLMENT_HANDOFF_KEY]: session.challengeToken } });
        return;
      }
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
