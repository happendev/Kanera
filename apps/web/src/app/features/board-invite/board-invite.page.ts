import { ChangeDetectionStrategy, Component, inject, input, signal } from "@angular/core";
import type { OnInit } from "@angular/core";
import { Router } from "@angular/router";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
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
  readonly state = signal<"loading" | "ready" | "invalid" | "accepted" | "error">("loading");
  readonly busy = signal(false);
  readonly errorMessage = signal<string | null>(null);

  readonly isLoggedIn = this.auth.isAuthenticated;

  async ngOnInit() {
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
      if (err instanceof ApiError && (err.body as { code?: string } | undefined)?.code === "SEAT_LIMIT_REACHED") {
        this.errorMessage.set("This organisation has no available seats. Ask an admin to purchase more seats, then try again.");
      } else {
        this.errorMessage.set((err as { message?: string })?.message ?? "Could not accept the invitation.");
      }
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
