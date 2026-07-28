import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";
import { SegmentedComponent, type SegmentedOption } from "./segmented.component";

const OPTIONS: SegmentedOption[] = [
  { id: "board", icon: "layout-kanban", label: "Board view" },
  { id: "table", icon: "table", label: "Table view" },
  { id: "calendar", icon: "calendar", label: "Calendar view", disabled: true },
];

@Component({
  standalone: true,
  imports: [SegmentedComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <k-segmented
      [options]="options"
      [value]="value()"
      [showLabels]="showLabels()"
      ariaLabel="View mode"
      (valueChange)="value.set($event)"
    />
  `,
})
class HostComponent {
  readonly options = OPTIONS;
  readonly value = signal("board");
  readonly showLabels = signal(false);
}

async function mount() {
  await TestBed.configureTestingModule({
    imports: [HostComponent],
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();

  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement };
}

describe("SegmentedComponent", () => {
  it("marks exactly one segment active and reports it via aria-pressed", async () => {
    const { host } = await mount();
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".sg-btn")];

    expect(buttons).toHaveLength(3);
    expect(buttons.filter((button) => button.classList.contains("is-active"))).toHaveLength(1);
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("false");
  });

  it("emits the selected id and moves the active pill", async () => {
    const { fixture, host } = await mount();
    host.querySelectorAll<HTMLButtonElement>(".sg-btn")[1]?.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.value()).toBe("table");
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".sg-btn")];
    expect(buttons[0]?.classList.contains("is-active")).toBe(false);
    expect(buttons[1]?.classList.contains("is-active")).toBe(true);
  });

  it("disables the segments marked disabled", async () => {
    const { host } = await mount();
    expect(host.querySelectorAll<HTMLButtonElement>(".sg-btn")[2]?.disabled).toBe(true);
  });

  it("is icon-only with an aria-label by default, and labelled when asked", async () => {
    const { fixture, host } = await mount();
    expect(host.querySelector(".sg-btn span")).toBeNull();
    expect(host.querySelector(".sg-btn")?.getAttribute("aria-label")).toBe("Board view");

    fixture.componentInstance.showLabels.set(true);
    fixture.detectChanges();

    expect(host.querySelector(".sg-btn span")?.textContent?.trim()).toBe("Board view");
    // The visible label is the accessible name once it renders; a duplicate aria-label would win
    // over it and is dropped.
    expect(host.querySelector(".sg-btn")?.getAttribute("aria-label")).toBeNull();
  });

  it("names the group so screen readers announce what the switch controls", async () => {
    const { host } = await mount();
    expect(host.querySelector(".sg-track")?.getAttribute("aria-label")).toBe("View mode");
  });
});
