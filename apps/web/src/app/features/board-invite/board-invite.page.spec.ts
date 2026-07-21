import { provideZonelessChangeDetection, signal } from "@angular/core";
import type { ComponentFixture } from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import { Router } from "@angular/router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { ThemeService } from "../../core/theme/theme.service";
import { BoardInvitePage } from "./board-invite.page";

describe("BoardInvitePage", () => {
  let fixture: ComponentFixture<BoardInvitePage>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [BoardInvitePage],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: ApiClient,
          useValue: {
            get: vi.fn(async () => ({
              id: "invite-1",
              boardId: "board-1",
              boardName: "Delivery",
              workspaceName: "Product",
              clientName: "Acme",
              role: "editor",
              expiresAt: null,
            })),
            post: vi.fn(),
          },
        },
        { provide: AuthService, useValue: { isAuthenticated: signal(false) } },
        { provide: ThemeService, useValue: { theme: signal("dark") } },
        { provide: Router, useValue: { navigate: vi.fn() } },
      ],
    }).compileComponents();
  });

  it("returns to the invitation after an existing user signs in", async () => {
    fixture = TestBed.createComponent(BoardInvitePage);
    fixture.componentRef.setInput("token", "invite-token");
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.loginUrl()).toBe(
      "/login?returnUrl=%2Fboard-invite%3Ftoken%3Dinvite-token",
    );
  });
});
