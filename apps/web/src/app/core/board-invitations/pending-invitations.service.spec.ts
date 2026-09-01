import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/api.client";
import { describeAcceptInvitationError, PendingInvitationsService } from "./pending-invitations.service";

describe("PendingInvitationsService", () => {
  const post = vi.fn(async () => ({ boardId: "board-1" }));

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [{ provide: ApiClient, useValue: { post } }],
    });
  });

  it("stores pending invitations and groups guest boards by organisation", () => {
    const service = TestBed.inject(PendingInvitationsService);
    service.setFromHome({
      pendingBoardInvitations: [{
        id: "invite-1",
        orgName: "Acme",
        invitedByName: "Alex",
        expiresAt: null,
        boards: [{ boardId: "board-1", boardName: "Delivery", workspaceName: "Product", role: "editor", assignedItemsOnly: false }],
      }],
      guestGroups: [{
        workspace: { id: "workspace-1", clientId: "client-1" } as never,
        clientName: "Acme",
        boardGroups: [],
        boards: [{ id: "board-1" } as never],
      }],
    });

    expect(service.pending()).toHaveLength(1);
    expect(service.guestOrgs()).toEqual([{ clientId: "client-1", orgName: "Acme", firstBoardId: "board-1" }]);
  });

  it("accepts and removes a pending invitation", async () => {
    const service = TestBed.inject(PendingInvitationsService);
    service.setFromHome({
      pendingBoardInvitations: [{ id: "invite-1", orgName: "Acme", invitedByName: "Alex", expiresAt: null, boards: [] }],
      guestGroups: [],
    });

    await expect(service.accept("invite-1")).resolves.toBe("board-1");
    expect(post).toHaveBeenCalledWith("/board-invitations/invite-1/accept", {});
    expect(service.pending()).toEqual([]);
  });

  it("prunes a dead invitation when the server refuses it as gone", async () => {
    post.mockRejectedValueOnce(new ApiError(409, { code: "CONFLICT", message: "invitation already accepted" }) as never);
    const service = TestBed.inject(PendingInvitationsService);
    service.setFromHome({
      pendingBoardInvitations: [{ id: "invite-1", orgName: "Acme", invitedByName: "Alex", expiresAt: null, boards: [] }],
      guestGroups: [],
    });

    await expect(service.accept("invite-1")).rejects.toBeInstanceOf(ApiError);
    expect(service.pending()).toEqual([]);
  });

  it("maps accept failures to the server's human message, never the raw status line", () => {
    expect(describeAcceptInvitationError(new ApiError(409, { code: "CONFLICT", message: "invitation already accepted" })))
      .toEqual({ message: "invitation already accepted", invitationGone: true });
    expect(describeAcceptInvitationError(new ApiError(402, { code: "SEAT_LIMIT_REACHED", message: "seat limit reached" })).message)
      .toContain("no available seats");
    expect(describeAcceptInvitationError(new Error("boom")))
      .toEqual({ message: "Could not accept the invitation.", invitationGone: false });
  });
});
