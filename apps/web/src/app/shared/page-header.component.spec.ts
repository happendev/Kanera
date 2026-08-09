import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  // The header decides for itself whether its row still fits, because no media query can: the
  // sidebar is user-collapsible, so the same viewport leaves the bar ~200px wider or narrower.
  describe("fit", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /**
     * Mounts with a stubbed ResizeObserver and a fake layout: the tail reports its labelled width
     * until the header collapses it, and its icon-only width after — which is exactly the feedback
     * the fit decision has to survive.
     */
    async function mountMeasured(labelled: number, collapsed: number) {
      let notify: (() => void) | null = null;
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: () => void) {
            notify = callback;
          }
          observe() {}
          disconnect() {}
        },
      );

      const { fixture, host } = await mount();
      const header = host.querySelector("k-page-header") as HTMLElement;
      const bar = host.querySelector(".ph-bar") as HTMLElement;
      const tail = host.querySelector(".ph-tail") as HTMLElement;

      let barWidth = 0;
      Object.defineProperty(bar, "clientWidth", { get: () => barWidth });
      Object.defineProperty(tail, "offsetWidth", {
        get: () => (header.classList.contains("is-tight") ? collapsed : labelled),
      });

      return {
        header,
        /** Resizes the bar and delivers the observation, as the real observer would. */
        resize: (width: number) => {
          barWidth = width;
          notify?.();
          fixture.detectChanges();
        },
        /** Re-delivers an observation at the current width — what the tail's own resize triggers. */
        settle: () => {
          notify?.();
          fixture.detectChanges();
        },
      };
    }

    it("drops the projected controls' labels once the row runs out of room", async () => {
      // Needs 72px of title floor + the 8px bar gap + the tail: 580px in all.
      const { header, resize } = await mountMeasured(500, 300);

      resize(700);
      expect(header.classList.contains("is-tight")).toBe(false);

      resize(560);
      expect(header.classList.contains("is-tight")).toBe(true);

      resize(600);
      expect(header.classList.contains("is-tight")).toBe(false);
    });

    it("holds the labelled width while collapsed, so the decision cannot oscillate", async () => {
      const { header, resize, settle } = await mountMeasured(500, 300);

      resize(560);
      expect(header.classList.contains("is-tight")).toBe(true);

      // Collapsing shrank the tail to 300, which on its own says the row fits again. Re-measuring
      // that would expand, no longer fit, collapse, and flip forever at this one width.
      settle();
      settle();
      expect(header.classList.contains("is-tight")).toBe(true);
    });
  });
});
