import type { ElementRef, OnDestroy } from "@angular/core";
import { ChangeDetectionStrategy, Component, effect, inject, input, signal, viewChild } from "@angular/core";
import { PanelStackService } from "./panel-stack.service";

/** Per-instance so `aria-controls` still resolves if a page ever renders two toolbars. */
let nextControlsId = 0;

/**
 * The app's one page toolbar — row 2 of the canonical page chrome, and purely the query bar.
 *
 * Slot order is fixed at **search → scope → Filter → Group → Sort**, with any saved-view picker or
 * tail control pinned right. Search sits in `[ptSearch]`, the rest in `[ptControls]`, the tail in
 * `[ptTail]`.
 *
 * ## The collapse
 *
 * Below `$bp-collapse` the `[ptControls]` body collapses behind a single `⚙` trigger instead of
 * stacking six full-width rows into a sticky bar. Search deliberately stays *outside* that body: it
 * is the one control people reach for on a phone, and hiding it behind a trigger was the specific
 * complaint that started this work. It gets its own full-width row instead.
 *
 * Two constraints a future change must not break:
 *
 * - **No `z-index` on the open panel.** It registers with `PanelStackService`, which assigns the
 *   whole open set a deterministic `--z-panel`-derived order. A hardcoded value (board.page.scss
 *   used to carry a bare `z-index: 30`) fights that.
 * - **No `transform`, `filter`, `backdrop-filter`, `will-change`, `contain` or `container-type`** on
 *   the toolbar or the panel, ever. Any of them makes the element the containing block for every
 *   `position: fixed` picker inside it, which would then anchor to the toolbar instead of the
 *   viewport and drift off-screen. `position`, `z-index` and `overflow` are all safe. An opaque
 *   background is how the sticky bar stays legible instead of a blur.
 *   `AnchoredPanelDirective` warns in dev mode if this is ever broken.
 */
@Component({
  selector: "k-page-toolbar",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pt-bar">
      <!--
        Search and the controls wrap inside their own box so the tail is never the item that gets
        pushed onto a line of its own. See .pt-main in the stylesheet.
      -->
      <div class="pt-main">
        <div class="pt-search">
          <ng-content select="[ptSearch]" />
        </div>

        <!--
          On desktop the body is display: contents, so the projected control groups stay direct flex
          children of the wrapping row and the wide layout is exactly what it was before the compact
          branch existed.
        -->
        <div class="pt-controls" [id]="controlsId" #controlsBody [class.is-open]="open()">
          <ng-content select="[ptControls]" />
        </div>
      </div>

      <div class="pt-tail">
        <button
          #compactTrigger
          type="button"
          class="pt-compact"
          [class.is-set]="compactActive()"
          [disabled]="disabled()"
          [attr.aria-expanded]="open()"
          [attr.aria-controls]="controlsId"
          [attr.aria-label]="open() ? 'Hide filters and sorting' : 'Show filters and sorting'"
          (click)="toggle($event)"
        >
          <i class="ti ti-adjustments-horizontal" aria-hidden="true"></i>
        </button>
        <ng-content select="[ptTail]" />
      </div>
    </div>
  `,
  styleUrl: "./page-toolbar.component.scss",
})
export class PageToolbarComponent implements OnDestroy {
  /**
   * Accents the `⚙`. This is the only signal a phone user gets that filters are hiding rows behind a
   * collapsed panel, so it must be true whenever *any* control inside `[ptControls]` is away from
   * its default — not just the Filter popover.
   */
  readonly compactActive = input(false);
  readonly disabled = input(false);

  protected readonly controlsId = `k-page-toolbar-controls-${nextControlsId++}`;

  private readonly panelStack = inject(PanelStackService);
  private readonly controlsBody = viewChild<ElementRef<HTMLElement>>("controlsBody");
  private readonly compactTrigger = viewChild<ElementRef<HTMLElement>>("compactTrigger");
  private unregister: (() => void) | null = null;

  protected readonly open = signal(false);

  constructor() {
    effect(() => {
      const open = this.open();
      const hostEl = this.controlsBody()?.nativeElement ?? null;
      // The expanded body registers as a stack layer rather than hand-rolling a document click
      // handler, because that is what makes nesting behave: PanelStackService derives layer parenting
      // from DOM containment, so a picker opened from inside the panel becomes a *child* layer. An
      // outside click that lands in the picker then cannot dismiss the panel underneath it, and
      // Escape closes the picker first and the panel second — with no bespoke guard here.
      if (!open || !hostEl) {
        this.unregister?.();
        this.unregister = null;
        return;
      }
      if (this.unregister) return;
      this.unregister = this.panelStack.register({
        hostEl,
        // The trigger toggles the panel itself. Without this the stack's capture-phase listener would
        // dismiss on the very click `toggle` is about to read as "close", and it would reopen.
        keepOpenWithin: () => [this.compactTrigger()?.nativeElement],
        dismiss: () => this.open.set(false),
      });
    });
  }

  ngOnDestroy(): void {
    this.unregister?.();
    this.unregister = null;
  }

  /**
   * `stopPropagation` keeps this click from reaching anything that would act on it a second time;
   * the stack has already seen it in the capture phase, which is how an open picker gets dismissed.
   */
  protected toggle(event: MouseEvent): void {
    event.stopPropagation();
    this.open.update((open) => !open);
  }
}
