import { CdkDropListGroup } from "@angular/cdk/drag-drop";
import type { OnDestroy } from "@angular/core";
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, effect, inject, output } from "@angular/core";
import { APP_DOM_EVENTS } from "../../core/browser/browser-contracts";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { CardDragCoordinator } from "./card-drag-coordinator.service";
import { cardDragEdgeScrollStep } from "./card-drag-scroll";

/** Below this width the lanes use centered snap points, which is what makes centring worth doing. */
const MOBILE_KANBAN_QUERY = "(max-width: 768px)";

/**
 * The reusable kanban surface used by the board route and consolidated work views.
 *
 * Lists remain projected content so every surface can supply its own state adapter while sharing
 * the same scrolling, CDK drop-list group, responsive sizing, and mobile snap behaviour.
 *
 * Card-drag behaviour lives here rather than on each page: the CSS half (releasing scroll snap while
 * a drag is in flight) always did, and older host pages each carried a character-identical copy of
 * the JS half. Owning both means consolidated pages, which mount one canvas per workspace
 * section inside an `@for`, get touch dragging with no page-side code at all.
 */
@Component({
  selector: "k-board",
  standalone: true,
  hostDirectives: [
    CdkDropListGroup,
    { directive: TooltipDirective, inputs: ["kTooltip: tooltip"] },
  ],
  host: { class: "lists" },
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: "<ng-content />",
  styles: `
    :host {
      position: relative;
      z-index: 1;
      display: flex;
      flex: 1 1 auto;
      align-items: flex-start;
      min-width: 0;
      min-height: 0;
      gap: 12px;
      padding: 16px;
      overflow-x: auto;
      overflow-y: hidden;
      overscroll-behavior-x: contain;
    }

    :host(.is-dragging) {
      user-select: none;
    }

    @media (max-width: 480px) {
      :host {
        gap: 8px;
        padding: 10px;
      }
    }

    @media (max-width: 768px) {
      :host {
        scroll-snap-type: x proximity;
      }

      :host(.is-card-dragging) {
        scroll-snap-type: none;
      }

      /* Columns are the snap targets: centering each keeps one list focused with a peek of its
         neighbours. ::ng-deep because lists arrive as projected content, outside this component's
         emulated encapsulation — the surrounding page cannot be relied on to declare it, and a page
         that does declare it only repeats this value. A board grouped by something other than its
         lists projects k-board-group-column instead, and snaps identically. */
      :host ::ng-deep :is(k-list, k-board-group-column) {
        scroll-snap-align: center;
      }

      @supports (-webkit-touch-callout: none) {
        :host {
          scroll-snap-type: x mandatory;
        }
      }
    }
  `,
})
export class BoardCanvasComponent implements OnDestroy {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly dragCoordinator = inject(CardDragCoordinator);
  private scrollDrag: { startX: number; startScrollLeft: number } | null = null;
  readonly scrolled = output<HTMLElement>();
  readonly backgroundClicked = output<MouseEvent>();
  /**
   * Card drag started/finished *on this canvas*. Board uses it to pause its list-growth preloading
   * and list-title measurement, both of which are too expensive to run during a drag.
   */
  readonly cardDragStateChanged = output<boolean>();
  /** Edge auto-scroll pushed this canvas rightwards; Board uses it to stage the next list column. */
  readonly edgeScrolledRight = output<void>();

  private cardDragActive = false;
  private cardDropTargetListId: string | null = null;
  private cardDragSession = 0;
  private edgeScrollFrame: number | null = null;

  constructor() {
    document.addEventListener(APP_DOM_EVENTS.CARD_DROP_TARGET, this.onCardDropTarget);
    effect(() => {
      const active = this.dragCoordinator.active();
      // Read inside the effect so the two always change together: `end()` clears the source id in the
      // same update that flips `active`, so an owning canvas never misses its own drag ending.
      const sourceListId = this.dragCoordinator.sourceListId();
      this.applyCardDragState(active, sourceListId);
    });
  }

  get nativeElement(): HTMLElement {
    return this.element.nativeElement;
  }

  @HostListener("scroll")
  onScroll(): void {
    this.scrolled.emit(this.nativeElement);
  }

  @HostListener("click", ["$event"])
  onClick(event: MouseEvent): void {
    this.backgroundClicked.emit(event);
  }

  @HostListener("mousedown", ["$event"])
  onMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest("k-list, k-board-group-column") || target.closest(".add-list")) return;
    this.scrollDrag = { startX: event.clientX, startScrollLeft: this.nativeElement.scrollLeft };
    this.nativeElement.classList.add("is-dragging");
  }

  @HostListener("window:mousemove", ["$event"])
  onMouseMove(event: MouseEvent): void {
    if (!this.scrollDrag) return;
    event.preventDefault();
    this.nativeElement.scrollLeft = this.scrollDrag.startScrollLeft - (event.clientX - this.scrollDrag.startX);
  }

  @HostListener("window:mouseup")
  onMouseUp(): void {
    this.endScrollDrag();
  }

  /**
   * Mobile kanban uses centered snap points. When the user taps Add on a peeking adjacent column,
   * center that column before opening the composer so the textarea is fully usable.
   */
  centerListForMobile(listId: string, behavior: ScrollBehavior = "smooth"): void {
    if (!window.matchMedia?.(MOBILE_KANBAN_QUERY).matches) return;
    this.listElement(listId)?.scrollIntoView({ behavior, block: "nearest", inline: "center" });
  }

  ngOnDestroy(): void {
    document.removeEventListener(APP_DOM_EVENTS.CARD_DROP_TARGET, this.onCardDropTarget);
    this.endScrollDrag();
    this.stopEdgeScrollLoop();
    this.nativeElement.classList.remove("is-card-dragging");
  }

  private endScrollDrag(): void {
    if (!this.scrollDrag) return;
    this.scrollDrag = null;
    this.nativeElement.classList.remove("is-dragging");
  }

  /**
   * Consolidated pages mount one canvas per workspace section, and CDK drags are announced globally.
   * Only the canvas that actually holds the dragged card may react: any other canvas would scroll its
   * own lanes sideways for a drag happening elsewhere on the page, and each extra edge-scroll loop
   * would add another `window.scrollBy()` to the same frame, multiplying vertical auto-scroll speed
   * by the number of mounted sections.
   *
   * `cardDragActive` is therefore only ever true on the owning canvas, which is what makes the
   * teardown branch below safe to run unguarded.
   */
  private applyCardDragState(active: boolean, sourceListId: string | null): void {
    if (active) {
      if (this.cardDragActive || !sourceListId || !this.listElement(sourceListId)) return;
      this.beginCardDrag();
    } else if (this.cardDragActive) {
      this.endCardDrag();
    }
  }

  private beginCardDrag(): void {
    const el = this.nativeElement;
    this.cardDragActive = true;
    // Mobile scroll snapping otherwise pulls each small edge-scroll nudge back to the current
    // column, making lists beyond the viewport unreachable during a card drag.
    el.classList.add("is-card-dragging");
    // A new drag owns its own destination. Clear any stale target and stop a previous smooth snap
    // animation before edge scrolling starts, otherwise consecutive drops can compete.
    this.cardDropTargetListId = null;
    this.cardDragSession += 1;
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ left: el.scrollLeft, behavior: "auto" });
    }
    this.cardDragStateChanged.emit(true);
    this.startEdgeScrollLoop();
  }

  private endCardDrag(): void {
    this.cardDragActive = false;
    this.nativeElement.classList.remove("is-card-dragging");
    this.stopEdgeScrollLoop();
    this.scheduleDropTargetSnap();
    this.cardDragStateChanged.emit(false);
  }

  private readonly onCardDropTarget = (event: Event): void => {
    if (!(event instanceof CustomEvent) || typeof event.detail !== "string") return;
    // A drop that landed in another section's canvas is none of this canvas's business.
    if (!this.listElement(event.detail)) return;
    this.cardDropTargetListId = event.detail;
    this.scheduleDropTargetSnap();
  };

  private scheduleDropTargetSnap(): void {
    if (!this.cardDropTargetListId || this.cardDragActive) return;
    const targetListId = this.cardDropTargetListId;
    const dragSession = this.cardDragSession;
    this.cardDropTargetListId = null;
    // CDK's touch path can emit dragEnded either before or after dropListDropped. Defer until
    // both have arrived, then center only if another drag has not taken ownership of the lane.
    queueMicrotask(() => {
      if (dragSession === this.cardDragSession && !this.cardDragActive) {
        this.centerListForMobile(targetListId);
      }
    });
  }

  private startEdgeScrollLoop(): void {
    if (this.edgeScrollFrame !== null) return;
    const el = this.nativeElement;

    // While a card drag is in flight, nudge this canvas horizontally and the page vertically when the
    // pointer sits near a viewport edge.
    const tick = () => {
      this.edgeScrollFrame = window.requestAnimationFrame(tick);
      const pointer = this.dragCoordinator.pointer();
      if (!pointer) return;

      const xStep = cardDragEdgeScrollStep(pointer.x, window.innerWidth);
      if (xStep !== 0) {
        el.scrollLeft += xStep;
        if (xStep > 0) this.edgeScrolledRight.emit();
      }

      const yStep = cardDragEdgeScrollStep(pointer.y, window.innerHeight);
      if (yStep !== 0) {
        window.scrollBy({ top: yStep, left: 0 });
      }
    };

    this.edgeScrollFrame = window.requestAnimationFrame(tick);
  }

  private stopEdgeScrollLoop(): void {
    if (this.edgeScrollFrame === null) return;
    window.cancelAnimationFrame(this.edgeScrollFrame);
    this.edgeScrollFrame = null;
  }

  /**
   * A lane column, whether it is a list (`k-list`) or a grouped bucket
   * (`k-board-group-column`). Both stamp `data-list-id`, so matching on the attribute keeps
   * edge-scroll arming and mobile snapping working on either grouping without this component
   * knowing which one the page chose to project.
   */
  private listElement(listId: string): HTMLElement | null {
    return this.nativeElement.querySelector<HTMLElement>(`[data-list-id="${CSS.escape(listId)}"]`);
  }
}
