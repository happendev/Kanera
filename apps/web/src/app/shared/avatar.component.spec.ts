import { ChangeDetectionStrategy, provideZonelessChangeDetection, signal } from "@angular/core";
import { Component } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vitest";
import { PresenceService } from "../core/realtime/presence.service";
import { AvatarComponent } from "./avatar.component";

@Component({
  standalone: true,
  imports: [AvatarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<k-avatar [url]="url()" name="Ada Lovelace" [size]="32" />`,
})
class AvatarHostComponent {
  readonly url = signal<string | null>("/missing-avatar.png");
  readonly showPresence = signal(false);
  readonly userId = signal<string | null>(null);
  readonly workspaceId = signal<string | null>(null);
}

@Component({
  standalone: true,
  imports: [AvatarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<k-avatar name="Ada Lovelace" [size]="32" [showPresence]="showPresence()" [showTooltip]="showTooltip()" [userId]="userId()" [workspaceId]="workspaceId()" [lastOnlineAt]="lastOnlineAt()" />`,
})
class PresenceAvatarHostComponent {
  readonly showPresence = signal(false);
  readonly showTooltip = signal(true);
  readonly userId = signal<string | null>(null);
  readonly workspaceId = signal<string | null>(null);
  readonly lastOnlineAt = signal<string | Date | null>(null);
}

@Component({
  standalone: true,
  imports: [AvatarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<k-avatar [name]="name()" [size]="32" [userId]="userId()" />`,
})
class FallbackColorAvatarHostComponent {
  readonly name = signal("Ada Lovelace");
  readonly userId = signal<string | null>("user-1");
}

const presence = {
  isOnline: (_workspaceId: string | null | undefined, userId: string | null | undefined) => userId === "online-user",
  lastOnlineAt: (_workspaceId: string | null | undefined, userId: string | null | undefined) => userId === "offline-user-live" ? "2026-06-21T11:59:30.000Z" : null,
  watchWorkspace: vi.fn(() => vi.fn()),
};

describe("AvatarComponent", () => {
  it("falls back to initials when the image cannot load", async () => {
    await TestBed.configureTestingModule({
      imports: [AvatarHostComponent],
      providers: [provideZonelessChangeDetection(), { provide: PresenceService, useValue: presence }],
    }).compileComponents();

    const fixture = TestBed.createComponent(AvatarHostComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    const image = host.querySelector("img");
    expect(image).toBeTruthy();

    image!.dispatchEvent(new Event("error"));
    fixture.detectChanges();

    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent?.trim()).toBe("A");
  });

  it("tries a new avatar URL after a previous URL failed", async () => {
    await TestBed.configureTestingModule({
      imports: [AvatarHostComponent],
      providers: [provideZonelessChangeDetection(), { provide: PresenceService, useValue: presence }],
    }).compileComponents();

    const fixture = TestBed.createComponent(AvatarHostComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    const image = host.querySelector("img");
    image!.dispatchEvent(new Event("error"));
    fixture.detectChanges();
    expect(host.querySelector("img")).toBeNull();

    fixture.componentInstance.url.set("/new-avatar.png");
    fixture.detectChanges();

    expect(host.querySelector("img")).toBeTruthy();
  });

  it("marks fallback initials with a deterministic color bucket", async () => {
    await TestBed.configureTestingModule({
      imports: [FallbackColorAvatarHostComponent],
      providers: [provideZonelessChangeDetection(), { provide: PresenceService, useValue: presence }],
    }).compileComponents();

    const fixture = TestBed.createComponent(FallbackColorAvatarHostComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    const avatar = host.querySelector<HTMLElement>("k-avatar");
    expect(avatar).toBeTruthy();
    if (!avatar) throw new Error("Expected avatar to render.");
    const firstColor = avatar.getAttribute("data-avatar-color");
    expect(firstColor).not.toBeNull();
    if (!firstColor) throw new Error("Expected fallback color to render.");

    expect(avatar.classList.contains("is-fallback")).toBe(true);
    expect(firstColor).toMatch(/^\d+$/);
    expect(avatar.style.getPropertyValue("--avatar-fallback-bg")).toBe(`var(--avatar-color-${firstColor}-bg)`);
    expect(avatar.style.getPropertyValue("--avatar-fallback-fg")).toBe(`var(--avatar-color-${firstColor}-fg)`);

    fixture.componentInstance.name.set("Different Name");
    fixture.detectChanges();

    expect(avatar.getAttribute("data-avatar-color")).toBe(firstColor);
  });

  it("uses different fallback buckets for different stable identities", async () => {
    await TestBed.configureTestingModule({
      imports: [FallbackColorAvatarHostComponent],
      providers: [provideZonelessChangeDetection(), { provide: PresenceService, useValue: presence }],
    }).compileComponents();

    const fixture = TestBed.createComponent(FallbackColorAvatarHostComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    const avatar = host.querySelector<HTMLElement>("k-avatar");
    expect(avatar).toBeTruthy();
    if (!avatar) throw new Error("Expected avatar to render.");
    const firstColor = avatar.getAttribute("data-avatar-color");

    fixture.componentInstance.userId.set("user-2");
    fixture.detectChanges();

    expect(avatar.getAttribute("data-avatar-color")).not.toBe(firstColor);
  });

  it("does not expose fallback styling while an image is visible", async () => {
    await TestBed.configureTestingModule({
      imports: [AvatarHostComponent],
      providers: [provideZonelessChangeDetection(), { provide: PresenceService, useValue: presence }],
    }).compileComponents();

    const fixture = TestBed.createComponent(AvatarHostComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    const avatar = host.querySelector<HTMLElement>("k-avatar");
    expect(avatar).toBeTruthy();
    if (!avatar) throw new Error("Expected avatar to render.");
    expect(host.querySelector("img")).toBeTruthy();
    expect(avatar.classList.contains("is-fallback")).toBe(false);
    expect(avatar.getAttribute("data-avatar-color")).toBeNull();
    expect(avatar.style.getPropertyValue("--avatar-fallback-bg")).toBe("");
    expect(avatar.style.getPropertyValue("--avatar-fallback-fg")).toBe("");
  });

  it("renders no badge by default", async () => {
    await TestBed.configureTestingModule({
      imports: [PresenceAvatarHostComponent],
      providers: [provideZonelessChangeDetection(), { provide: PresenceService, useValue: presence }],
    }).compileComponents();

    const fixture = TestBed.createComponent(PresenceAvatarHostComponent);
    fixture.componentInstance.userId.set("online-user");
    fixture.componentInstance.workspaceId.set("workspace-1");
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector(".presence-dot")).toBeNull();
  });

  it("renders a badge only when the presence user is online", async () => {
    await TestBed.configureTestingModule({
      imports: [PresenceAvatarHostComponent],
      providers: [provideZonelessChangeDetection(), { provide: PresenceService, useValue: presence }],
    }).compileComponents();

    const fixture = TestBed.createComponent(PresenceAvatarHostComponent);
    fixture.componentInstance.showPresence.set(true);
    fixture.componentInstance.userId.set("online-user");
    fixture.componentInstance.workspaceId.set("workspace-1");
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    let dot = host.querySelector(".presence-dot");
    expect(dot?.getAttribute("aria-label")).toBe("Online");

    fixture.componentInstance.userId.set("offline-user");
    fixture.detectChanges();

    dot = host.querySelector(".presence-dot");
    expect(dot).toBeNull();
  });

  it("keeps online avatar tooltips name-only and shows last online for offline users", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-21T12:00:00.000Z"));
    try {
      await TestBed.configureTestingModule({
        imports: [PresenceAvatarHostComponent],
        providers: [provideZonelessChangeDetection(), { provide: PresenceService, useValue: presence }],
      }).compileComponents();

      const fixture = TestBed.createComponent(PresenceAvatarHostComponent);
      fixture.componentInstance.showPresence.set(true);
      fixture.componentInstance.workspaceId.set("workspace-1");
      fixture.componentInstance.userId.set("online-user");
      fixture.componentInstance.lastOnlineAt.set("2026-06-19T09:00:00.000Z");
      fixture.detectChanges();
      const avatar = fixture.nativeElement.querySelector("k-avatar") as HTMLElement;

      avatar.querySelector<HTMLElement>(".avatar-body")?.dispatchEvent(new Event("mouseenter"));
      vi.advanceTimersByTime(350);
      fixture.detectChanges();

      expect(document.querySelector(".k-tooltip")?.textContent).toBe("Ada Lovelace");

      avatar.dispatchEvent(new Event("mouseleave"));
      fixture.componentInstance.userId.set("offline-user");
      fixture.detectChanges();
      avatar.querySelector<HTMLElement>(".avatar-body")?.dispatchEvent(new Event("mouseenter"));
      vi.advanceTimersByTime(350);
      fixture.detectChanges();

      expect(document.querySelector(".k-tooltip")?.textContent).toBe("Ada Lovelace · Last online 2 days ago");

      avatar.dispatchEvent(new Event("mouseleave"));
      fixture.componentInstance.userId.set("offline-user-live");
      fixture.detectChanges();
      avatar.querySelector<HTMLElement>(".avatar-body")?.dispatchEvent(new Event("mouseenter"));
      vi.advanceTimersByTime(350);
      fixture.detectChanges();

      expect(document.querySelector(".k-tooltip")?.textContent).toBe("Ada Lovelace · Last online less than a minute ago");

      avatar.dispatchEvent(new Event("mouseleave"));
      vi.advanceTimersByTime(30_000);
      fixture.detectChanges();
      avatar.querySelector<HTMLElement>(".avatar-body")?.dispatchEvent(new Event("mouseenter"));
      vi.advanceTimersByTime(350);
      fixture.detectChanges();

      expect(document.querySelector(".k-tooltip")?.textContent).toBe("Ada Lovelace · Last online 1 minute ago");
    } finally {
      vi.useRealTimers();
      document.querySelectorAll(".k-tooltip-panel").forEach((el) => el.remove());
    }
  });

  it("can suppress its own tooltip when nested inside another tooltip target", async () => {
    vi.useFakeTimers();
    try {
      await TestBed.configureTestingModule({
        imports: [PresenceAvatarHostComponent],
        providers: [provideZonelessChangeDetection(), { provide: PresenceService, useValue: presence }],
      }).compileComponents();

      const fixture = TestBed.createComponent(PresenceAvatarHostComponent);
      fixture.componentInstance.showTooltip.set(false);
      fixture.detectChanges();

      const host = fixture.nativeElement as HTMLElement;
      host.querySelector<HTMLElement>(".avatar-body")?.dispatchEvent(new Event("mouseenter"));
      vi.advanceTimersByTime(350);
      fixture.detectChanges();

      expect(document.querySelector(".k-tooltip")).toBeNull();
    } finally {
      vi.useRealTimers();
      document.querySelectorAll(".k-tooltip-panel").forEach((el) => el.remove());
    }
  });
});
