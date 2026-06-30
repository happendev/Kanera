import type { ConnectedPosition, OverlayRef } from "@angular/cdk/overlay";
import { Overlay } from "@angular/cdk/overlay";
import { ComponentPortal } from "@angular/cdk/portal";
import type { ComponentRef, OnDestroy } from "@angular/core";
import { ChangeDetectionStrategy, Component, Directive, ElementRef, HostListener, effect, inject, input } from "@angular/core";

export type TooltipPosition = "top" | "right" | "bottom" | "left";

const SHOW_DELAY_MS = 300;
const AUTO_HIDE_MS = 10_000;
const TOOLTIP_OFFSET = 8;
let nextTooltipId = 0;

@Component({
  selector: "k-tooltip-content",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="k-tooltip" [id]="id()" role="tooltip">{{ text() }}</div>`,
})
class TooltipContentComponent {
  readonly id = input.required<string>();
  readonly text = input.required<string>();
}

@Directive({
  selector: "[kTooltip]",
  standalone: true,
})
export class TooltipDirective implements OnDestroy {
  private readonly overlay = inject(Overlay);
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly tooltipId = `k-tooltip-${++nextTooltipId}`;
  private overlayRef: OverlayRef | null = null;
  private tooltipRef: ComponentRef<TooltipContentComponent> | null = null;
  private showTimer: number | null = null;
  private hideTimer: number | null = null;
  private previousTitle: string | null = null;

  readonly kTooltip = input<string | null | undefined>("");
  readonly kTooltipPosition = input<TooltipPosition>("top");
  readonly kTooltipDisabled = input(false);

  constructor() {
    effect(() => {
      const text = this.tooltipText();
      const disabled = this.kTooltipDisabled();

      this.stripNativeTitle();
      if (!text || disabled) {
        this.hide();
        return;
      }

      if (this.overlayRef?.hasAttached()) this.renderTooltip(text);
    });
  }

  @HostListener("mouseenter")
  onMouseEnter() {
    this.scheduleShow();
  }

  @HostListener("mouseleave")
  onMouseLeave() {
    this.hide();
  }

  @HostListener("focusin")
  onFocusIn() {
    this.show();
  }

  @HostListener("focusout")
  onFocusOut() {
    this.hide();
  }

  @HostListener("click")
  onClick() {
    this.hide();
  }

  @HostListener("document:keydown.escape")
  onEscape() {
    this.hide();
  }

  ngOnDestroy() {
    this.hide();
    this.overlayRef?.dispose();
    this.restoreNativeTitle();
  }

  private scheduleShow() {
    if (document.body.classList.contains("is-card-dragging")) return;
    if (!this.tooltipText() || this.kTooltipDisabled()) return;
    this.clearShowTimer();
    this.showTimer = window.setTimeout(() => this.show(), SHOW_DELAY_MS);
  }

  private show() {
    this.clearShowTimer();
    if (document.body.classList.contains("is-card-dragging")) return;
    const text = this.tooltipText();
    if (!text || this.kTooltipDisabled()) return;

    if (!this.overlayRef) {
      this.overlayRef = this.overlay.create({
        hasBackdrop: false,
        panelClass: ["k-tooltip-panel", `k-tooltip-panel-${this.kTooltipPosition()}`],
        positionStrategy: this.positionStrategy(),
        scrollStrategy: this.overlay.scrollStrategies.reposition(),
      });
      this.overlayRef.overlayElement.style.zIndex = "8200";
    } else {
      this.overlayRef.updatePositionStrategy(this.positionStrategy());
      this.overlayRef.overlayElement.classList.remove(
        "k-tooltip-panel-top",
        "k-tooltip-panel-right",
        "k-tooltip-panel-bottom",
        "k-tooltip-panel-left",
      );
      this.overlayRef.overlayElement.classList.add(`k-tooltip-panel-${this.kTooltipPosition()}`);
    }

    this.renderTooltip(text);
    this.overlayRef.updatePosition();
    this.elementRef.nativeElement.setAttribute("aria-describedby", this.tooltipId);
    this.scheduleAutoHide();
  }

  private hide() {
    this.clearShowTimer();
    this.clearHideTimer();
    this.overlayRef?.detach();
    this.tooltipRef = null;
    this.elementRef.nativeElement.removeAttribute("aria-describedby");
  }

  private renderTooltip(text: string) {
    if (!this.overlayRef) return;
    if (!this.overlayRef.hasAttached()) {
      this.tooltipRef = this.overlayRef.attach(new ComponentPortal(TooltipContentComponent));
    }
    this.tooltipRef?.setInput("id", this.tooltipId);
    this.tooltipRef?.setInput("text", text);
    this.tooltipRef?.changeDetectorRef.detectChanges();
  }

  private positionStrategy() {
    return this.overlay
      .position()
      .flexibleConnectedTo(this.elementRef)
      .withFlexibleDimensions(false)
      .withPush(true)
      .withViewportMargin(8)
      .withPositions(this.positionsFor(this.kTooltipPosition()));
  }

  private positionsFor(position: TooltipPosition): ConnectedPosition[] {
    const positions: Record<TooltipPosition, ConnectedPosition[]> = {
      top: [
        { originX: "center", originY: "top", overlayX: "center", overlayY: "bottom", offsetY: -TOOLTIP_OFFSET, panelClass: "k-tooltip-origin-top" },
        { originX: "center", originY: "bottom", overlayX: "center", overlayY: "top", offsetY: TOOLTIP_OFFSET, panelClass: "k-tooltip-origin-bottom" },
        { originX: "end", originY: "center", overlayX: "start", overlayY: "center", offsetX: TOOLTIP_OFFSET, panelClass: "k-tooltip-origin-right" },
        { originX: "start", originY: "center", overlayX: "end", overlayY: "center", offsetX: -TOOLTIP_OFFSET, panelClass: "k-tooltip-origin-left" },
      ],
      right: [
        { originX: "end", originY: "center", overlayX: "start", overlayY: "center", offsetX: TOOLTIP_OFFSET, panelClass: "k-tooltip-origin-right" },
        { originX: "start", originY: "center", overlayX: "end", overlayY: "center", offsetX: -TOOLTIP_OFFSET, panelClass: "k-tooltip-origin-left" },
        { originX: "center", originY: "top", overlayX: "center", overlayY: "bottom", offsetY: -TOOLTIP_OFFSET, panelClass: "k-tooltip-origin-top" },
        { originX: "center", originY: "bottom", overlayX: "center", overlayY: "top", offsetY: TOOLTIP_OFFSET, panelClass: "k-tooltip-origin-bottom" },
      ],
      bottom: [
        { originX: "center", originY: "bottom", overlayX: "center", overlayY: "top", offsetY: TOOLTIP_OFFSET, panelClass: "k-tooltip-origin-bottom" },
        { originX: "center", originY: "top", overlayX: "center", overlayY: "bottom", offsetY: -TOOLTIP_OFFSET, panelClass: "k-tooltip-origin-top" },
        { originX: "end", originY: "center", overlayX: "start", overlayY: "center", offsetX: TOOLTIP_OFFSET, panelClass: "k-tooltip-origin-right" },
        { originX: "start", originY: "center", overlayX: "end", overlayY: "center", offsetX: -TOOLTIP_OFFSET, panelClass: "k-tooltip-origin-left" },
      ],
      left: [
        { originX: "start", originY: "center", overlayX: "end", overlayY: "center", offsetX: -TOOLTIP_OFFSET, panelClass: "k-tooltip-origin-left" },
        { originX: "end", originY: "center", overlayX: "start", overlayY: "center", offsetX: TOOLTIP_OFFSET, panelClass: "k-tooltip-origin-right" },
        { originX: "center", originY: "top", overlayX: "center", overlayY: "bottom", offsetY: -TOOLTIP_OFFSET, panelClass: "k-tooltip-origin-top" },
        { originX: "center", originY: "bottom", overlayX: "center", overlayY: "top", offsetY: TOOLTIP_OFFSET, panelClass: "k-tooltip-origin-bottom" },
      ],
    };
    return positions[position];
  }

  private tooltipText() {
    return `${this.kTooltip() ?? ""}`.trim();
  }

  private stripNativeTitle() {
    const host = this.elementRef.nativeElement;
    const title = host.getAttribute("title");
    if (title !== null) {
      this.previousTitle = title;
      host.removeAttribute("title");
    }
  }

  private restoreNativeTitle() {
    if (this.previousTitle === null) return;
    this.elementRef.nativeElement.setAttribute("title", this.previousTitle);
  }

  private clearShowTimer() {
    if (this.showTimer === null) return;
    window.clearTimeout(this.showTimer);
    this.showTimer = null;
  }

  private scheduleAutoHide() {
    this.clearHideTimer();
    this.hideTimer = window.setTimeout(() => this.hide(), AUTO_HIDE_MS);
  }

  private clearHideTimer() {
    if (this.hideTimer === null) return;
    window.clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }
}
