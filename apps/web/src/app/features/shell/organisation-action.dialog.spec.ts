import { DIALOG_DATA, DialogRef } from "@angular/cdk/dialog";
import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../../core/api/api.client";
import type { AuthUser } from "../../core/auth/auth.service";
import { CreateOrganisationDialogComponent, JoinOrganisationDialogComponent } from "./organisation-action.dialog";

describe("CreateOrganisationDialogComponent", () => {
  const close = vi.fn();
  const session = { accessToken: "new-token", user: {} as AuthUser };
  const post = vi.fn(() => Promise.resolve(session));

  beforeEach(() => {
    vi.clearAllMocks();
    post.mockResolvedValue(session);
    TestBed.configureTestingModule({
      imports: [CreateOrganisationDialogComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { post } },
        { provide: DialogRef, useValue: { close } },
        { provide: DIALOG_DATA, useValue: { hosted: true } },
      ],
    });
  });

  it("explains separate hosted billing and creates the organisation", async () => {
    const fixture = TestBed.createComponent(CreateOrganisationDialogComponent);
    fixture.componentInstance.name.set("  My Studio  ");
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain("its own plan and billing");
    await fixture.componentInstance.create();

    expect(post).toHaveBeenCalledWith("/clients", { name: "My Studio" });
    expect(close).toHaveBeenCalledWith(session);
  });

  it("keeps the dialog open and shows API errors", async () => {
    post.mockRejectedValueOnce(new ApiError(409, { message: "That organisation name is unavailable." }));
    const fixture = TestBed.createComponent(CreateOrganisationDialogComponent);
    fixture.componentInstance.name.set("Taken");

    await fixture.componentInstance.create();

    expect(close).not.toHaveBeenCalled();
    expect(fixture.componentInstance.error()).toBe("That organisation name is unavailable.");
  });
});

describe("JoinOrganisationDialogComponent", () => {
  const close = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      imports: [JoinOrganisationDialogComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: DialogRef, useValue: { close } },
      ],
    });
  });

  it("accepts and trims an invitation link or token", () => {
    const fixture = TestBed.createComponent(JoinOrganisationDialogComponent);
    fixture.componentInstance.invite.set("  https://kanera.test/invite?token=abc  ");

    fixture.componentInstance.join();

    expect(close).toHaveBeenCalledWith("https://kanera.test/invite?token=abc");
  });
});
