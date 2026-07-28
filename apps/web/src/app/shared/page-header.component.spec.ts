import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";
import { PageHeaderComponent, type PageHeaderVariant } from "./page-header.component";

@Component({
  standalone: true,
  imports: [PageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <k-page-header
      icon="layout-kanban"
      iconColor="var(--color-teal)"
      [title]="title()"
      [subtitle]="subtitle()"
      [eyebrow]="eyebrow()"
      [variant]="variant()"
      [loading]="loading()"
    >
      <span phMeta class="slot-meta">avatars</span>
      <button phActions type="button" class="slot-action">Create</button>
      <span phIcons class="slot-icons">icons</span>
      <span phViews class="slot-views">views</span>
    </k-page-header>
  `,
})
class HostComponent {
  readonly title = signal("Delivery board");
  readonly subtitle = signal<string | null>("Acme workspace");
  readonly eyebrow = signal<string | null>(null);
  readonly variant = signal<PageHeaderVariant>("chrome");
  readonly loading = signal(false);
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

describe("PageHeaderComponent", () => {
  it("defaults to the chrome variant and reflects it as a host class", async () => {
    const { fixture, host } = await mount();
    const header = host.querySelector("k-page-header");

    expect(header?.classList.contains("is-chrome")).toBe(true);
    expect(header?.classList.contains("is-page")).toBe(false);

    fixture.componentInstance.variant.set("page");
    fixture.detectChanges();

    expect(header?.classList.contains("is-page")).toBe(true);
    expect(header?.classList.contains("is-chrome")).toBe(false);
  });

  it("renders the lead icon, title and subtitle", async () => {
    const { host } = await mount();

    expect(host.querySelector(".ph-icon")?.className).toContain("ti-layout-kanban");
    expect(host.querySelector<HTMLElement>(".ph-icon")?.style.color).toBe("var(--color-teal)");
    expect(host.querySelector(".ph-title")?.textContent?.trim()).toBe("Delivery board");
    expect(host.querySelector(".ph-subtitle")?.textContent?.trim()).toBe("Acme workspace");
  });

  it("omits the eyebrow and subtitle when not supplied", async () => {
    const { fixture, host } = await mount();
    fixture.componentInstance.subtitle.set(null);
    fixture.detectChanges();

    expect(host.querySelector(".ph-eyebrow")).toBeNull();
    expect(host.querySelector(".ph-subtitle")).toBeNull();

    fixture.componentInstance.eyebrow.set("Share to Kanera");
    fixture.detectChanges();

    expect(host.querySelector(".ph-eyebrow")?.textContent?.trim()).toBe("Share to Kanera");
  });

  it("swaps the title for a labelled skeleton while loading, keeping the slots mounted", async () => {
    const { fixture, host } = await mount();
    fixture.componentInstance.loading.set(true);
    fixture.detectChanges();

    expect(host.querySelector(".ph-title")).toBeNull();
    expect(host.querySelector(".ph-subtitle")).toBeNull();
    // Labelled, so the page still announces which page it is while its data loads.
    expect(host.querySelector(".ph-title-skeleton")?.getAttribute("aria-label")).toBe("Delivery board");
    // The slots stay projected: the view switch is navigation and must remain reachable.
    expect(host.querySelector(".slot-views")).toBeTruthy();

    fixture.componentInstance.loading.set(false);
    fixture.detectChanges();

    expect(host.querySelector(".ph-title-skeleton")).toBeNull();
    expect(host.querySelector(".ph-title")?.textContent?.trim()).toBe("Delivery board");
  });

  it("projects the slots in the canonical order: meta, actions, icons, views", async () => {
    const { host } = await mount();
    const slots = [...host.querySelectorAll("[class^='slot-']")].map((el) => el.className);

    expect(slots).toEqual(["slot-meta", "slot-action", "slot-icons", "slot-views"]);
    // Meta belongs to the identity group so it stacks with the title; the rest form the tail.
    expect(host.querySelector(".ph-identity .slot-meta")).toBeTruthy();
    expect(host.querySelector(".ph-tail .slot-action")).toBeTruthy();
    expect(host.querySelector(".ph-tail .ph-views .slot-views")).toBeTruthy();
  });
});
