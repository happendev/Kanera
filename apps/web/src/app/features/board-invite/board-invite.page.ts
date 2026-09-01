import { ChangeDetectionStrategy, Component, inject, input, signal } from "@angular/core";
import type { OnInit } from "@angular/core";
import { Router } from "@angular/router";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { describeAcceptInvitationError } from "../../core/board-invitations/pending-invitations.service";
import { LogoComponent } from "../../shared/logo.component";

interface InviteDetails {
  id: string;
  boardId: string;
  boardName: string;
  workspaceName: string;
  clientName: string;
  role: string;
  expiresAt: string | null;
  boards?: { boardId: string; boardName: string; workspaceName: string; role: string }[];
}

@Component({
  selector: "k-board-invite",
  standalone: true,
  imports: [LogoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./board-invite.page.html",
  styleUrl: "./board-invite.page.scss",
})
export class BoardInvitePage implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  // Bound from query params via withComponentInputBinding().
  readonly token = input<string | undefined>(undefined);

  readonly invite = signal<InviteDetails | null>(null);
  readonly state = signal<"loading" | "ready" | "invalid" | "accepted">("loading");
  readonly busy = signal(false);
  readonly errorMessage = signal<string | null>(null);

  readonly isLoggedIn = this.auth.isAuthenticated;

  async ngOnInit() {
    // A refresh cookie can restore a session on a cold invite load. Hydrate before choosing between
    // the Accept button and signup/login links so authenticated recipients never lose the token.
    await this.auth.hydrate();
    const token = this.token();
    if (!token) {
      this.state.set("invalid");
      return;
    }
    try {
      const details = await this.api.get<InviteDetails>(`/board-invitations/lookup?token=${encodeURIComponent(token)}`);
      this.invite.set(details);
      this.state.set("ready");
    } catch {
      this.state.set("invalid");
    }
  }

  async accept() {
    const invite = this.invite();
    if (!invite) return;
    this.busy.set(true);
    this.errorMessage.set(null);
    try {
      await this.api.post<{ boardId: string }>(`/board-invitations/${invite.id}/accept`, {});
      this.state.set("accepted");
      await this.router.navigate(["/b", invite.boardId]);
    } catch (err: unknown) {
      this.errorMessage.set(describeAcceptInvitationError(err).message);
    } finally {
      this.busy.set(false);
    }
  }

  signupUrl(): string {
    const token = this.token();
    return token ? `/signup?boardInviteToken=${encodeURIComponent(token)}` : "/signup";
  }

  loginUrl(): string {
    const token = this.token();
    const redirect = token ? `/board-invite?token=${encodeURIComponent(token)}` : "/";
    return `/login?returnUrl=${encodeURIComponent(redirect)}`;
  }

  roleLabel(role: string): string {
    return role.charAt(0).toUpperCase() + role.slice(1);
  }

  boardSummary(invite: InviteDetails): string {
    const boards = invite.boards ?? [{ boardId: invite.boardId, boardName: invite.boardName, workspaceName: invite.workspaceName, role: invite.role }];
    return boards.map((board) => board.boardName).join(", ");
  }
}
