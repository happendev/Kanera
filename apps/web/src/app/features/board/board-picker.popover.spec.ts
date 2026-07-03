import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { BoardPickerPopover } from "./board-picker.popover";

describe("BoardPickerPopover", () => {
  const get = vi.fn();

  beforeEach(async () => {
    get.mockReset();
    get.mockResolvedValue([]);
    await TestBed.configureTestingModule({
      imports: [BoardPickerPopover],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { get } },
      ],
    }).compileComponents();
  });

  it("loads transfer targets through the source board authorization boundary", async () => {
    const fixture = TestBed.createComponent(BoardPickerPopover);
    fixture.componentRef.setInput("sourceBoardId", "board-1");
    fixture.componentRef.setInput("excludeBoardId", "board-1");
    fixture.detectChanges();

    await fixture.whenStable();

    expect(get).toHaveBeenCalledWith("/boards/board-1/transfer-targets");
  });
});
