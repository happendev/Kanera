import { Injectable, inject, signal } from "@angular/core";
import type { PendingBoardInvitationSummary } from "@kanera/shared/dto";
import { ApiClient, ApiError } from "../api/api.client";
import type { GuestHomeGroup, HomeResponse } from "../offline/offline-cache.service";

export type GuestOrganisationSummary = {
  clientId: string;
  orgName: string;
  firstBoardId: string;
};

@Injectable({ providedIn: "root" })
export class PendingInvitationsService {
  private readonly api = inject(ApiClient);
  private readonly pendingState = signal<PendingBoardInvitationSummary[]>([]);
  private readonly guestOrgState = signal<GuestOrganisationSummary[]>([]);

  readonly pending = this.pendingState.asReadonly();
  readonly guestOrgs = this.guestOrgState.asReadonly();

  setFromHome(response: Pick<HomeResponse, "guestGroups" | "pendingBoardInvitations">): void {
    // Pending bearer-token state is deliberately network-only; callers pass [] when restoring the
    // shell from IndexedDB. Guest board links themselves are safe to derive from the cached shell.
    this.pendingState.set(response.pendingBoardInvitations ?? []);
    this.guestOrgState.set(guestOrganisations(response.guestGroups ?? []));
  }

  async accept(id: string): Promise<string> {
    try {
      const result = await this.api.post<{ boardId: string }>(`/board-invitations/${id}/accept`, {});
      this.pendingState.update((invitations) => invitations.filter((invitation) => invitation.id !== id));
      return result.boardId;
    } catch (error: unknown) {
      // A 404/409 means the invitation is gone (revoked, expired, or accepted elsewhere) — prune
      // the dead row so the list never keeps an Accept button the server will refuse again.
      if (describeAcceptInvitationError(error).invitationGone) {
        this.pendingState.update((invitations) => invitations.filter((invitation) => invitation.id !== id));
      }
      throw error;
    }
  }
}

// Shared by every surface that accepts a board invitation (home pending panel, invite page) so the
// same failure never reads differently across them. ApiError.message is the literal "api <status>";
// the human-readable server message lives in error.body.message.
export function describeAcceptInvitationError(error: unknown): { message: string; invitationGone: boolean } {
  if (error instanceof ApiError) {
    const body = error.body as { code?: string; message?: string } | undefined;
    if (body?.code === "SEAT_LIMIT_REACHED") {
      return { message: "This organisation has no available seats. Ask an admin to purchase more seats, then try again.", invitationGone: false };
    }
    const invitationGone = error.status === 404 || error.status === 409;
    if (invitationGone) {
      return { message: body?.message ?? "This invitation is no longer available — it may have been revoked or already accepted.", invitationGone };
    }
    if (body?.message) return { message: body.message, invitationGone: false };
  }
  return { message: "Could not accept the invitation.", invitationGone: false };
}

function guestOrganisations(groups: GuestHomeGroup[]): GuestOrganisationSummary[] {
  const organisations = new Map<string, GuestOrganisationSummary>();
  for (const group of groups) {
    const firstBoard = group.boards[0];
    if (!firstBoard || organisations.has(group.workspace.clientId)) continue;
    organisations.set(group.workspace.clientId, {
      clientId: group.workspace.clientId,
      orgName: group.clientName,
      firstBoardId: firstBoard.id,
    });
  }
  return [...organisations.values()].sort((a, b) => a.orgName.localeCompare(b.orgName));
}
