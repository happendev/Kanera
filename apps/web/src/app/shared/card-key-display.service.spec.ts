import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthService, type AuthUser } from "../core/auth/auth.service";
import { CardKeyDisplayService } from "./card-key-display.service";

describe("CardKeyDisplayService", () => {
  const user = signal<AuthUser | null>(null);

  beforeEach(() => {
    user.set(null);
    TestBed.configureTestingModule({
      providers: [{ provide: AuthService, useValue: { user } }],
    });
  });

  it("defaults to showing card keys without a signed-in user", () => {
    expect(TestBed.inject(CardKeyDisplayService).showCardKeys()).toBe(true);
  });

  it("defaults to showing card keys for an older session without the preference", () => {
    user.set({ showCardKeys: undefined } as AuthUser);

    expect(TestBed.inject(CardKeyDisplayService).showCardKeys()).toBe(true);
  });

  it("honours a signed-in user's disabled preference", () => {
    user.set({ showCardKeys: false } as AuthUser);

    expect(TestBed.inject(CardKeyDisplayService).showCardKeys()).toBe(false);
  });
});
