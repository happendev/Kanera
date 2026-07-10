import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Router } from "@angular/router";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { ShareTargetPage } from "./share-target.page";

describe("ShareTargetPage", () => {
  async function render() {
    const get = vi.fn((path: string) => {
      if (path === "/home/boards") {
        return Promise.resolve({
          groups: [
            {
              workspace: {
                id: "workspace-1",
                clientId: "client-1",
                name: "Marketing",
                icon: null,
                accentColor: null,
                completedCardsActiveDays: 35,
                createdAt: new Date("2026-06-01T00:00:00.000Z"),
                updatedAt: new Date("2026-06-01T00:00:00.000Z"),
                archivedAt: null,
                role: "member",
              },
              boardGroups: [],
              boards: [
                {
                  id: "board-1",
                  workspaceId: "workspace-1",
                  groupId: null,
                  name: "Campaigns",
                  icon: null,
                  iconColor: null,
                  backgroundGradient: null,
                  position: "1000.0000000000",
                  myCards: 0,
                  myOverdue: 0,
                },
              ],
              members: [],
            },
          ],
          guestGroups: [],
          dueSoon: [],
          overdueChecklistItems: 0,
        });
      }
      if (path === "/workspaces/workspace-1") {
        return Promise.resolve({
          lists: [
            {
              id: "list-1",
              workspaceId: "workspace-1",
              name: "Inbox",
              position: "1000.0000000000",
              archivedAt: null,
              createdAt: new Date("2026-06-01T00:00:00.000Z"),
              updatedAt: new Date("2026-06-01T00:00:00.000Z"),
            },
          ],
        });
      }
      return Promise.reject(new Error(`unexpected get ${path}`));
    });
    const createCard = vi.fn((_path: string, _body: unknown) => Promise.resolve({ id: "card-1", boardId: "board-1" }));
    const watchCreatedCardLocally = vi.fn();
    const navigate = vi.fn(() => Promise.resolve(true));

    await TestBed.configureTestingModule({
      imports: [ShareTargetPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { get, createCard } },
        { provide: NotificationsService, useValue: { watchCreatedCardLocally } },
        { provide: Router, useValue: { navigate } },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(ShareTargetPage);
    fixture.componentRef.setInput("title", "Shared headline");
    fixture.componentRef.setInput("text", "Read this brief");
    fixture.componentRef.setInput("url", "https://example.com/brief");
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() => expect(fixture.componentInstance.canSave()).toBe(true));
    fixture.detectChanges();

    return { component: fixture.componentInstance, fixture, get, createCard, watchCreatedCardLocally, navigate };
  }

  it("creates a card from shared title, text, and url", async () => {
    const { component, createCard, watchCreatedCardLocally, navigate } = await render();

    expect(component.cardTitle()).toBe("Shared headline");
    expect(component.description()).toBe("Read this brief\n\nhttps://example.com/brief");
    expect(component.selectedBoardId()).toBe("board-1");
    expect(component.selectedListId()).toBe("list-1");

    await component.save();

    expect(createCard).toHaveBeenCalledTimes(1);
    const [createPath, rawCreateBody] = createCard.mock.calls[0]!;
    const createBody = rawCreateBody as {
      title: string;
      description: string;
      clientToken: string;
    };
    expect(createPath).toBe("/boards/board-1/lists/list-1/cards");
    expect(createBody).toMatchObject({
      title: "Shared headline",
      description: "Read this brief\n\nhttps://example.com/brief",
    });
    expect(createBody.clientToken).toMatch(/^[0-9a-f-]{36}$/i);
    expect(watchCreatedCardLocally).toHaveBeenCalledWith("card-1");
    expect(navigate).toHaveBeenCalledWith(["/b", "board-1"], { queryParams: { cardId: "card-1" } });
  });
});
