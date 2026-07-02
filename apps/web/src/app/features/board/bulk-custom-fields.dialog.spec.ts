import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { CardCustomFieldValue } from "@kanera/shared/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { BoardState } from "./board-state";
import { BulkCustomFieldsDialogComponent } from "./bulk-custom-fields.dialog";

function value(cardId: string, fieldId: string, patch: Partial<CardCustomFieldValue>): CardCustomFieldValue {
  return {
    cardId,
    fieldId,
    valueText: null,
    valueNumber: null,
    valueCheckbox: null,
    valueDate: null,
    valueUrl: null,
    valueOptionIds: null,
    valueUserIds: null,
    updatedAt: new Date("2026-06-09T00:00:00.000Z"),
    ...patch,
  };
}

function textField() {
  return { id: "f1", name: "Notes", type: "text", icon: "forms", allowMultiple: false };
}

describe("BulkCustomFieldsDialogComponent", () => {
  let valuesByCard: Map<string, Map<string, CardCustomFieldValue>>;
  let upsertCustomFieldValue: ReturnType<typeof vi.fn>;
  let clearCustomFieldValue: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    valuesByCard = new Map();
    upsertCustomFieldValue = vi.fn();
    clearCustomFieldValue = vi.fn();
  });

  async function createComponent(options: {
    patch?: ReturnType<typeof vi.fn>;
    post?: ReturnType<typeof vi.fn>;
    fields?: unknown[];
    hasFullValues?: boolean;
  } = {}) {
    const patch = options.patch ?? vi.fn(() => Promise.resolve({ values: [], clearedCardIds: [], skippedCardIds: [], updated: 0 }));
    const post = options.post ?? vi.fn(() => Promise.resolve({ customFieldValues: [] }));
    await TestBed.configureTestingModule({
      imports: [BulkCustomFieldsDialogComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { patch, post, get: vi.fn() } },
        {
          provide: BoardState,
          useValue: {
            customFieldValuesForCard: (cardId: string) => valuesByCard.get(cardId) ?? new Map(),
            hasFullCfValuesForBoard: () => options.hasFullValues ?? true,
            markCfValuesLoadedForBoard: vi.fn(),
            mergeCustomFieldValues: vi.fn(),
            upsertCustomFieldValue,
            clearCustomFieldValue,
          },
        },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(BulkCustomFieldsDialogComponent);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("cardIds", ["card-1", "card-2", "card-3"]);
    fixture.componentRef.setInput("cards", [
      { id: "card-1", boardId: "board-1" },
      { id: "card-2", boardId: "board-1" },
      { id: "card-3", boardId: "board-1" },
    ]);
    fixture.componentRef.setInput("customFields", options.fields ?? [textField()]);
    fixture.componentRef.setInput("members", []);
    fixture.componentRef.setInput("currentUserId", null);
    fixture.detectChanges();
    return { fixture, patch, post };
  }

  it("loads custom-field values for only the selected cards", async () => {
    const returned = value("card-1", "f1", { valueText: "hello" });
    const post = vi.fn(() => Promise.resolve({ customFieldValues: [returned] }));
    const { fixture } = await createComponent({ post, hasFullValues: false });
    await fixture.whenStable();

    expect(post).toHaveBeenCalledWith("/boards/board-1/custom-field-values/query", {
      cardIds: ["card-1", "card-2", "card-3"],
    });
    const state = TestBed.inject(BoardState);
    expect(state.mergeCustomFieldValues).toHaveBeenCalledWith([expect.objectContaining({ cardId: "card-1", valueText: "hello" })]);
    expect(state.markCfValuesLoadedForBoard).not.toHaveBeenCalled();
  });

  it("loads more than 200 selected cards in one request per board", async () => {
    const cardIds = Array.from({ length: 201 }, (_, index) => `card-${index}`);
    const post = vi.fn(() => Promise.resolve({ customFieldValues: [] }));
    const { fixture } = await createComponent({ post, hasFullValues: false });
    fixture.componentRef.setInput("cardIds", cardIds);
    fixture.componentRef.setInput("cards", cardIds.map((id) => ({ id, boardId: "board-1" })));

    // Re-run setup after replacing the inputs because createComponent performs initial detection.
    post.mockClear();
    fixture.componentInstance.ngOnInit();
    await fixture.whenStable();

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/boards/board-1/custom-field-values/query", { cardIds });
  });

  it("reports a mixed indicator when cards differ and the shared value when identical", async () => {
    valuesByCard.set("card-1", new Map([["f1", value("card-1", "f1", { valueText: "a" })]]));
    valuesByCard.set("card-2", new Map([["f1", value("card-2", "f1", { valueText: "b" })]]));
    const { fixture } = await createComponent();
    const field = fixture.componentInstance.fields()[0]!;

    expect(fixture.componentInstance.currentSummary(field)).toBe("Mixed");

    valuesByCard.set("card-2", new Map([["f1", value("card-2", "f1", { valueText: "a" })]]));
    // card-3 has no value → still differs from "a".
    expect(fixture.componentInstance.currentSummary(field)).toBe("Mixed");

    valuesByCard.set("card-3", new Map([["f1", value("card-3", "f1", { valueText: "a" })]]));
    expect(fixture.componentInstance.currentSummary(field)).toBe("a");
  });

  it("stages a scalar edit and applies the correct bulk payload", async () => {
    const patch = vi.fn(() => Promise.resolve({ values: [], clearedCardIds: [], skippedCardIds: [], updated: 3 }));
    const { fixture } = await createComponent({ patch });
    const field = fixture.componentInstance.fields()[0]!;

    fixture.componentInstance.stageScalar(field, "valueText", "hello");
    expect(fixture.componentInstance.stagedCount()).toBe(1);

    await fixture.componentInstance.apply();
    expect(patch).toHaveBeenCalledWith("/boards/board-1/cards/bulk/custom-fields", {
      cardIds: ["card-1", "card-2", "card-3"],
      fieldId: "f1",
      mode: "setAll",
      valueText: "hello",
    });
  });

  it("shows a blocking saving state until the bulk update completes", async () => {
    let resolvePatch!: (result: BulkResult) => void;
    type BulkResult = { values: never[]; clearedCardIds: never[]; skippedCardIds: never[]; updated: number };
    const patch = vi.fn(() => new Promise<BulkResult>((resolve) => (resolvePatch = resolve)));
    const { fixture } = await createComponent({ patch });
    const field = fixture.componentInstance.fields()[0]!;
    let dismissed = false;
    fixture.componentInstance.dismissed.subscribe(() => (dismissed = true));

    fixture.componentInstance.stageScalar(field, "valueText", "hello");
    const applyPromise = fixture.componentInstance.apply();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector(".saving-state")?.textContent).toContain("Updating 3 cards");
    expect(fixture.nativeElement.querySelector(".fields")).toBeNull();
    expect(fixture.nativeElement.querySelector(".icon-btn").disabled).toBe(true);
    fixture.componentInstance.dismiss();
    expect(dismissed).toBe(false);

    resolvePatch({ values: [], clearedCardIds: [], skippedCardIds: [], updated: 3 });
    await applyPromise;
    expect(dismissed).toBe(true);
  });

  it("switches the scope to fillEmpty", async () => {
    const patch = vi.fn((_url: string, _body: unknown) => Promise.resolve({ values: [], clearedCardIds: [], skippedCardIds: [], updated: 0 }));
    const { fixture } = await createComponent({ patch });
    const field = fixture.componentInstance.fields()[0]!;

    fixture.componentInstance.stageScalar(field, "valueText", "hello");
    fixture.componentInstance.setScope(field, "fillEmpty");
    await fixture.componentInstance.apply();

    expect(patch.mock.calls[0]?.[1]).toMatchObject({ mode: "fillEmpty", valueText: "hello" });
  });

  it("optimistically pushes returned values into board state and emits done", async () => {
    const returned = value("card-1", "f1", { valueText: "hello" });
    const patch = vi.fn(() => Promise.resolve({ values: [returned], clearedCardIds: ["card-2"], skippedCardIds: [], updated: 2 }));
    const { fixture } = await createComponent({ patch });
    const field = fixture.componentInstance.fields()[0]!;
    let doneEmitted = false;
    fixture.componentInstance.done.subscribe(() => (doneEmitted = true));

    fixture.componentInstance.stageScalar(field, "valueText", "hello");
    await fixture.componentInstance.apply();

    expect(upsertCustomFieldValue).toHaveBeenCalledWith(expect.objectContaining({ cardId: "card-1", fieldId: "f1", valueText: "hello" }));
    expect(clearCustomFieldValue).toHaveBeenCalledWith("card-2", "f1");
    expect(doneEmitted).toBe(true);
  });

  it("stages a clear as mode clear", async () => {
    const patch = vi.fn((_url: string, _body: unknown) => Promise.resolve({ values: [], clearedCardIds: [], skippedCardIds: [], updated: 0 }));
    const { fixture } = await createComponent({ patch });
    const field = fixture.componentInstance.fields()[0]!;

    fixture.componentInstance.stageClear(field);
    await fixture.componentInstance.apply();

    expect(patch.mock.calls[0]?.[1]).toMatchObject({ fieldId: "f1", mode: "clear" });
  });
});
