import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Router } from "@angular/router";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { CardKeyRedirectPage } from "./card-key-redirect.page";

describe("CardKeyRedirectPage", () => {
  it("resolves aliases while keeping the current key as the visible browser URL", async () => {
    const api = { get: vi.fn(() => Promise.resolve({ id: "card-1", boardId: "board-1", organisationKey: "0123456789ABCDEF", key: "WORK-42" })) };
    const router = { navigate: vi.fn(() => Promise.resolve(true)) };
    TestBed.configureTestingModule({
      imports: [CardKeyRedirectPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: api },
        { provide: Router, useValue: router },
      ],
    });

    const fixture = TestBed.createComponent(CardKeyRedirectPage);
    fixture.componentRef.setInput("organisationKey", "0123456789ABCDEF");
    fixture.componentRef.setInput("cardKey", "old-42");
    fixture.detectChanges();
    await fixture.whenStable();

    expect(api.get).toHaveBeenCalledWith("/organisations/0123456789ABCDEF/cards/by-key/old-42");
    expect(router.navigate).toHaveBeenCalledWith(["/b", "board-1", "c", "card-1"], {
      replaceUrl: true,
      browserUrl: "/o/0123456789ABCDEF/c/WORK-42",
    });
  });
});
