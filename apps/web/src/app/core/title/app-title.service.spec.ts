import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Title } from "@angular/platform-browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsService } from "../notifications/notifications.service";
import { AppTitleService } from "./app-title.service";

describe("AppTitleService", () => {
  const title = { setTitle: vi.fn() };
  const notifications = { unreadCount: signal(0) };
  let favicon16: HTMLLinkElement;
  let favicon32: HTMLLinkElement;

  beforeEach(() => {
    title.setTitle.mockReset();
    notifications.unreadCount.set(0);
    favicon16 = addFavicon("/favicon-16.png", "16x16");
    favicon32 = addFavicon("/favicon-32.png", "32x32");

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        AppTitleService,
        { provide: Title, useValue: title },
        { provide: NotificationsService, useValue: notifications },
      ],
    });
  });

  afterEach(() => {
    favicon16.remove();
    favicon32.remove();
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

  it("shows an unread dot in every favicon and restores the original icons when all are read", () => {
    TestBed.inject(AppTitleService);

    notifications.unreadCount.set(2);
    TestBed.tick();

    for (const favicon of [favicon16, favicon32]) {
      expect(favicon.getAttribute("href")).toBe("/assets/favicon/favicon-unread.svg");
      expect(favicon.getAttribute("type")).toBe("image/svg+xml");
      expect(favicon.hasAttribute("sizes")).toBe(false);
    }

    notifications.unreadCount.set(0);
    TestBed.tick();

    expect(favicon16.getAttribute("href")).toBe("/favicon-16.png");
    expect(favicon16.getAttribute("type")).toBe("image/png");
    expect(favicon16.getAttribute("sizes")).toBe("16x16");
    expect(favicon32.getAttribute("href")).toBe("/favicon-32.png");
    expect(favicon32.getAttribute("type")).toBe("image/png");
    expect(favicon32.getAttribute("sizes")).toBe("32x32");
  });
});

function addFavicon(href: string, sizes: string): HTMLLinkElement {
  const element = document.createElement("link");
  element.rel = "icon";
  element.type = "image/png";
  element.href = href;
  element.setAttribute("sizes", sizes);
  document.head.append(element);
  return element;
}
