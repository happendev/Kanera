import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { AuthService } from "../../core/auth/auth.service";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { PresenceService } from "../../core/realtime/presence.service";
import { WatcherPopoverComponent } from "./watcher-popover.component";
import { describe, expect, it, vi } from "vitest";

describe("WatcherPopoverComponent", () => {
  function setup(options: { watchers?: { userId: string; displayName: string; avatarUrl: string | null }[]; showToggle?: boolean; watching?: boolean } = {}) {
    const cardWatchers = signal<Record<string, { userId: string; displayName: string; avatarUrl: string | null }[]>>({
      "card-1": options.watchers ?? [],
    });
    const notifications = {
      cardWatchers,
      boardWatchers: signal({}),
      isWatchingCard: vi.fn(() => options.watching ?? false),
      isWatchingBoard: vi.fn(() => false),
      loadCardWatchers: vi.fn(() => Promise.resolve(cardWatchers()["card-1"])),
      loadBoardWatchers: vi.fn(() => Promise.resolve([])),
      toggleCardWatch: vi.fn(() => Promise.resolve()),
      toggleBoardWatch: vi.fn(() => Promise.resolve()),
    };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: AuthService, useValue: { user: signal({ id: "user-1" }) } },
        { provide: NotificationsService, useValue: notifications },
        {
          provide: PresenceService,
          useValue: {
            isOnline: vi.fn(() => false),
            lastOnlineAt: vi.fn(() => null),
            watchWorkspace: vi.fn(() => vi.fn()),
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(WatcherPopoverComponent);
    fixture.componentRef.setInput("kind", "card");
    fixture.componentRef.setInput("entityId", "card-1");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    if (options.showToggle !== undefined) fixture.componentRef.setInput("showToggle", options.showToggle);
    fixture.detectChanges();
    return { fixture, notifications };
  }

  it("renders watcher rows and toggles card watching from the action", async () => {
    const { fixture, notifications } = setup({
      watchers: [
        { userId: "user-1", displayName: "Me User", avatarUrl: null },
        { userId: "user-2", displayName: "Ada", avatarUrl: null },
      ],
      watching: true,
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain("Me");
    expect(fixture.nativeElement.textContent).toContain("Ada");
    expect(fixture.nativeElement.textContent).toContain("Stop watching card");

    fixture.nativeElement.querySelector(".wp-toggle").click();
    await fixture.whenStable();

    expect(notifications.toggleCardWatch).toHaveBeenCalledWith("card-1");
  });

  it("renders an empty state and can hide the toggle", async () => {
    const { fixture } = setup({ showToggle: false });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector(".wp-toggle")).toBeNull();
    expect(fixture.nativeElement.textContent).toContain("No watchers");
  });

  it("emits dismissed on Escape", () => {
    const { fixture } = setup();
    const dismissed = vi.fn();
    fixture.componentInstance.dismissed.subscribe(dismissed);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(dismissed).toHaveBeenCalled();
  });
});
