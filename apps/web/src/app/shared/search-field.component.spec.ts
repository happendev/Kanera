import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";
import { SearchFieldComponent } from "./search-field.component";

@Component({
  standalone: true,
  imports: [SearchFieldComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <k-search-field
      [value]="value()"
      [disabled]="disabled()"
      placeholder="Search cards"
      (valueChange)="value.set($event)"
    />
  `,
})
class HostComponent {
  readonly value = signal("");
  readonly disabled = signal(false);
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

describe("SearchFieldComponent", () => {
  it("emits every keystroke and reflects the bound value back", async () => {
    const { fixture, host } = await mount();
    const input = host.querySelector<HTMLInputElement>(".sf-input");
    if (!input) throw new Error("Expected the search input to render.");

    input.value = "invoice";
    input.dispatchEvent(new Event("input"));
    fixture.detectChanges();

    expect(fixture.componentInstance.value()).toBe("invoice");
    expect(host.querySelector<HTMLInputElement>(".sf-input")?.value).toBe("invoice");
  });

  it("shows the clear button only while there is a value, and clears to empty", async () => {
    const { fixture, host } = await mount();
    expect(host.querySelector(".sf-clear")).toBeNull();

    fixture.componentInstance.value.set("invoice");
    fixture.detectChanges();

    const clear = host.querySelector<HTMLButtonElement>(".sf-clear");
    if (!clear) throw new Error("Expected the clear button to render.");
    clear.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.value()).toBe("");
    expect(host.querySelector(".sf-clear")).toBeNull();
  });

  it("disables the input and hides the clear button when disabled", async () => {
    const { fixture, host } = await mount();
    fixture.componentInstance.value.set("invoice");
    fixture.componentInstance.disabled.set(true);
    fixture.detectChanges();

    expect(host.querySelector<HTMLInputElement>(".sf-input")?.disabled).toBe(true);
    expect(host.querySelector(".sf-clear")).toBeNull();
  });

  it("labels the input from the placeholder so an icon-only field is still announced", async () => {
    const { host } = await mount();
    expect(host.querySelector(".sf-input")?.getAttribute("aria-label")).toBe("Search cards");
  });
});
