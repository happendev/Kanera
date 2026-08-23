import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";
import { DOCS_PATHS, DocsLinkComponent, KANERA_DOCS_URL, type DocsPath } from "./docs-link.component";

@Component({
  standalone: true,
  imports: [DocsLinkComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<k-docs-link [path]="path()" [fragment]="fragment()" [label]="label()" />`,
})
class HostComponent {
  readonly path = signal<DocsPath>("automations");
  readonly fragment = signal<string | null>(null);
  readonly label = signal("Learn more");
}

async function mount() {
  await TestBed.configureTestingModule({
    imports: [HostComponent],
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();

  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  const anchor = () => fixture.nativeElement.querySelector("a") as HTMLAnchorElement;
  return { fixture, anchor };
}

describe("DocsLinkComponent", () => {
  it("composes an absolute docs URL from the path", async () => {
    const { anchor } = await mount();
    expect(anchor().getAttribute("href")).toBe(`${KANERA_DOCS_URL}/automations`);
    expect(anchor().textContent?.trim()).toContain("Learn more");
  });

  it("appends a heading anchor when a fragment is set", async () => {
    const { fixture, anchor } = await mount();
    fixture.componentInstance.path.set("board-health");
    fixture.componentInstance.fragment.set("organisation-default");
    fixture.detectChanges();
    expect(anchor().getAttribute("href")).toBe(`${KANERA_DOCS_URL}/board-health#organisation-default`);
  });

  // Docs open away from the app, so the tab-napping guard has to be on every one of these links.
  it("opens in a new tab without leaking the opener", async () => {
    const { anchor } = await mount();
    expect(anchor().getAttribute("target")).toBe("_blank");
    expect(anchor().getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("keeps the slug list unique and sorted so the union stays easy to diff against the docs site", () => {
    expect([...DOCS_PATHS]).toEqual([...new Set(DOCS_PATHS)].sort());
  });
});
