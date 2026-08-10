import { TestBed } from "@angular/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BodyScrollLockService } from "./body-scroll-lock.service";

describe("BodyScrollLockService", () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    document.body.classList.remove("k-no-scroll");
  });

  afterEach(() => document.body.classList.remove("k-no-scroll"));

  it("holds the body lock until every idempotent lease is released", () => {
    const service = TestBed.inject(BodyScrollLockService);
    const releaseFirst = service.acquire();
    const releaseSecond = service.acquire();
    expect(document.body.classList.contains("k-no-scroll")).toBe(true);

    releaseFirst();
    releaseFirst();
    expect(document.body.classList.contains("k-no-scroll")).toBe(true);

    releaseSecond();
    expect(document.body.classList.contains("k-no-scroll")).toBe(false);
  });
});
