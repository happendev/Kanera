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

  it("explains the selected template and previews the content it creates", () => {
    const fixture = TestBed.createComponent(StandaloneBoardCreateDialogComponent);
    const projectDelivery = WORKSPACE_TEMPLATES.find((template) => template.id === "project-delivery")!;
    fixture.componentInstance.templateId.set(projectDelivery.id);
    fixture.detectChanges();

    const preview = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(".template-preview")!;
    expect(preview.textContent).toContain(projectDelivery.name);
    expect(preview.textContent).toContain(projectDelivery.description);
    expect(preview.textContent).not.toContain("stages");
    expect(preview.textContent).not.toContain("fields");
    expect(preview.textContent).not.toContain("labels");
    expect(preview.textContent).not.toContain("checklists");
    expect(preview.textContent).not.toContain("starter cards");
    expect(preview.querySelector(".ti-check")).toBeNull();
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
      checklistTemplates: DEFAULT_WORKSPACE_TEMPLATE.checklistTemplates ?? [],
      cards: DEFAULT_WORKSPACE_TEMPLATE.cards ?? [],
      automations: DEFAULT_WORKSPACE_TEMPLATE.automations ?? [],
    });
    expect(close).toHaveBeenCalledWith("board-1");
  });
});
