import { provideZonelessChangeDetection, signal } from "@angular/core";
import type { ComponentFixture } from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import { ActivatedRoute, Router } from "@angular/router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeService } from "../../core/theme/theme.service";
import { ResetPasswordPage } from "./reset-password.page";

describe("ResetPasswordPage", () => {
  let fixture: ComponentFixture<ResetPasswordPage>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn(async () => response({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await TestBed.configureTestingModule({
      imports: [ResetPasswordPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ActivatedRoute, useValue: {} },
        { provide: Router, useValue: { navigateByUrl: vi.fn() } },
        { provide: ThemeService, useValue: { theme: signal("dark") } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ResetPasswordPage);
    fixture.componentRef.setInput("token", "reset-token");
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it("uses cross-field validation before submitting", async () => {
    fixture.componentInstance.password.set("new-password");
    fixture.componentInstance.confirm.set("different-password");

    await fixture.componentInstance.submit(submitEvent());

    expect(fixture.componentInstance.error()).toBe("Passwords do not match.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires the reset token through submission validation", async () => {
    fixture.componentRef.setInput("token", null);
    fixture.componentInstance.password.set("new-password");
    fixture.componentInstance.confirm.set("new-password");

    await fixture.componentInstance.submit(submitEvent());

    expect(fixture.componentInstance.error()).toBe("Reset link is missing a token.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits the Signal Forms password model", async () => {
    fixture.componentInstance.password.set("new-password");
    fixture.componentInstance.confirm.set("new-password");

    await fixture.componentInstance.submit(submitEvent());

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({
      token: "reset-token",
      password: "new-password",
    });
    expect(fixture.componentInstance.success()).toBe(true);
  });
});

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

function submitEvent(): Event {
  return { preventDefault: vi.fn() } as unknown as Event;
}
