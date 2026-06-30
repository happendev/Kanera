import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Title } from "@angular/platform-browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsService } from "../notifications/notifications.service";
import { AppTitleService } from "./app-title.service";

describe("AppTitleService", () => {
  const title = { setTitle: vi.fn() };
  const notifications = { unreadCount: signal(0) };

  beforeEach(() => {
    title.setTitle.mockReset();
    notifications.unreadCount.set(0);

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        AppTitleService,
        { provide: Title, useValue: title },
        { provide: NotificationsService, useValue: notifications },
      ],
    });
  });

  it("composes the base page title", () => {
    const service = TestBed.inject(AppTitleService);

    service.set("Workspace", "Settings");
    TestBed.tick();

    expect(title.setTitle).toHaveBeenLastCalledWith("Workspace · Settings · Kanera");
  });

  it("prefixes the title with the unread notification count", () => {
    const service = TestBed.inject(AppTitleService);

    service.set("Workspace", "Settings");
    TestBed.tick();
    notifications.unreadCount.set(3);
    TestBed.tick();

    expect(title.setTitle).toHaveBeenLastCalledWith("(3) Workspace · Settings · Kanera");
  });

  it("removes the unread prefix when all notifications are read", () => {
    const service = TestBed.inject(AppTitleService);

    service.set("Board");
    TestBed.tick();
    notifications.unreadCount.set(2);
    TestBed.tick();
    notifications.unreadCount.set(0);
    TestBed.tick();

    expect(title.setTitle).toHaveBeenLastCalledWith("Board · Kanera");
  });
});
