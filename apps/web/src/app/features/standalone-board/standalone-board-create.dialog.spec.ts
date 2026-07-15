import { DialogRef } from "@angular/cdk/dialog";
import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { DEFAULT_WORKSPACE_TEMPLATE, WORKSPACE_TEMPLATES } from "@kanera/shared/workspace-templates";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { StandaloneBoardCreateDialogComponent } from "./standalone-board-create.dialog";

describe("StandaloneBoardCreateDialogComponent", () => {
  const close = vi.fn();
  const post = vi.fn(() => Promise.resolve({ initialBoard: { id: "board-1" } }));

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      imports: [StandaloneBoardCreateDialogComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { post } },
        { provide: DialogRef, useValue: { close } },
      ],
    });
  });

  it("uses the onboarding templates without a synthetic defaults option", () => {
    const fixture = TestBed.createComponent(StandaloneBoardCreateDialogComponent);
    fixture.detectChanges();
    const options = [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLOptionElement>("option")];

    expect(fixture.componentInstance.templateId()).toBe(DEFAULT_WORKSPACE_TEMPLATE.id);
    expect(options.map((option) => option.textContent?.trim())).toEqual(WORKSPACE_TEMPLATES.map((template) => template.name));
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain("Kanera defaults");
  });

  it("creates the board with the selected onboarding template", async () => {
    const fixture = TestBed.createComponent(StandaloneBoardCreateDialogComponent);
    fixture.componentInstance.name.set("Launch");

    await fixture.componentInstance.create();

    expect(post).toHaveBeenCalledWith("/workspaces", {
      kind: "board",
      name: "Launch",
      icon: DEFAULT_WORKSPACE_TEMPLATE.icon,
      initialBoard: { name: "Launch", icon: DEFAULT_WORKSPACE_TEMPLATE.icon },
      lists: DEFAULT_WORKSPACE_TEMPLATE.lists,
      customFields: DEFAULT_WORKSPACE_TEMPLATE.customFields,
      labels: DEFAULT_WORKSPACE_TEMPLATE.labels,
    });
    expect(close).toHaveBeenCalledWith("board-1");
  });
});
