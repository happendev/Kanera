import type { OverlayRef } from "@angular/cdk/overlay";
import { Overlay } from "@angular/cdk/overlay";
import { TemplatePortal } from "@angular/cdk/portal";
import type { AfterViewInit, EffectRef, OnDestroy, TemplateRef} from "@angular/core";
import { ChangeDetectionStrategy, Component, ViewChild, ViewContainerRef, effect, inject, input, signal } from "@angular/core";
import { ToastLayoutService } from "./toast-layout.service";
import { TOAST_EXIT_MS } from "./toast.service";
import type { ToastVariant } from "./toast.service";

/**
 * The single toast primitive. Declarative hosts bind `show` for persistent status (offline, update
 * available); the `k-toast-stack` renders ToastService's transient queue through the same
 * component, so every toast in the app shares one look, one corner and one stacking order.
 */
@Component({
  selector: "k-toast",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-template #prompt>
      <div class="toast" [attr.data-variant]="variant()" [attr.role]="variant() === 'error' ? 'alert' : 'status'" [attr.aria-live]="variant() === 'error' ? 'assertive' : 'polite'">
        <i [class]="'ti ti-' + icon()"></i>
        <span class="message">{{ message() }}</span>
        <ng-content />
      </div>
    </ng-template>
  `,
  styles: `
    :host {
      display: contents;
    }

    .toast {
      max-width: min(420px, calc(100vw - 32px));
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 12px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18), 0 1px 3px rgba(0, 0, 0, 0.08);
      padding: 12px 16px;
      /* Toasts are transient notices, not content: a drag across one should never start a selection. */
      user-select: none;
      animation: toast-in var(--motion-base, 180ms) cubic-bezier(0.16, 1, 0.3, 1) both;
    }

    /* Exit runs while the layout service has already released the slot, so neighbours ease down
       under this toast as it fades. Duration must stay within TOAST_EXIT_MS. */
    .toast.leaving {
      animation: toast-out 160ms ease-in both;
      pointer-events: none;
    }

    i {
      color: var(--text-muted);
      font-size: 18px;
      flex-shrink: 0;
    }

    .toast[data-variant="success"] > i { color: var(--success); }
    .toast[data-variant="error"] > i { color: var(--danger); }

    .message {
      overflow-wrap: anywhere;
      min-width: 0;
      font-size: 14px;
      line-height: 1.4;
      color: var(--text);
    }

    @keyframes toast-in {
      from { opacity: 0; transform: translateY(12px) scale(0.98) }
      to { opacity: 1; transform: none }
    }

    @keyframes toast-out {
      from { opacity: 1; transform: none }
      to { opacity: 0; transform: translateY(8px) }
    }

    @media (prefers-reduced-motion: reduce) {
      .toast, .toast.leaving { animation-duration: 1ms; }
    }
  `,
})
export class ToastComponent implements AfterViewInit, OnDestroy {
  private readonly overlay = inject(Overlay);
  private readonly stack = inject(ToastLayoutService);
  private readonly viewContainerRef = inject(ViewContainerRef);
  private readonly toastId = Symbol("toast");
  private readonly viewReady = signal(false);
  private readonly delayedShow = signal(false);
  private readonly overlayRef: OverlayRef;
  private readonly delayEffect: EffectRef;
  private readonly portalEffect: EffectRef;
  private delayTimer: number | null = null;
  private exitTimer: number | null = null;

  readonly variant = input<ToastVariant>("info");
  readonly show = input(false);
  readonly delayMs = input(0);
  readonly bottomOffsetPx = input(16);
  readonly icon = input.required<string>();
  readonly message = input.required<string>();

  @ViewChild("prompt", { static: true }) private readonly promptTpl!: TemplateRef<unknown>;

  constructor() {
    this.overlayRef = this.overlay.create({
      hasBackdrop: false,
      // Layering lives in styles.scss on this class so it reads on the shared scale rather than as an
      // inline literal. It has to outrank --z-modal: a toast raised from inside a dialog used to be
      // painted under it and was simply invisible.
      panelClass: "k-toast-panel",
      positionStrategy: this.overlay.position().global().right("16px").bottom("16px"),
      scrollStrategy: this.overlay.scrollStrategies.noop(),
    });

    this.delayEffect = effect((onCleanup) => {
      if (!this.viewReady()) return;

      this.clearDelayTimer();
      this.delayedShow.set(false);
      if (!this.show()) return;

      const delayMs = this.delayMs();
      if (delayMs <= 0) {
        this.delayedShow.set(true);
      } else {
        this.delayTimer = window.setTimeout(() => {
          if (this.show()) this.delayedShow.set(true);
        }, delayMs);
      }

      onCleanup(() => this.clearDelayTimer());
    });

    this.portalEffect = effect(() => {
      if (!this.viewReady()) return;

      if (this.delayedShow()) {
        this.cancelExit();
        this.stack.register(this.toastId);
        this.updateOverlayPosition();
        if (!this.overlayRef.hasAttached()) {
          this.overlayRef.attach(new TemplatePortal(this.promptTpl, this.viewContainerRef));
          this.watchToastSize();
        }
      } else {
        this.beginExit();
      }
    });
  }

  ngAfterViewInit() {
    this.viewReady.set(true);
  }

  ngOnDestroy() {
    this.portalEffect.destroy();
    this.delayEffect.destroy();
    this.clearDelayTimer();
    this.clearExitTimer();
    this.stack.unregister(this.toastId);
    this.overlayRef.dispose();
  }

  /**
   * Hide with an exit animation. The layout slot is released immediately so the toasts above ease
   * down while this one fades; the overlay detaches once the animation has had time to finish.
   */
  private beginExit() {
    this.stack.unregister(this.toastId);
    if (!this.overlayRef.hasAttached() || this.exitTimer !== null) return;
    const toast = this.overlayRef.overlayElement.querySelector<HTMLElement>(".toast");
    toast?.classList.add("leaving");
    const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.exitTimer = window.setTimeout(() => {
      this.exitTimer = null;
      this.overlayRef.detach();
    }, reducedMotion ? 0 : TOAST_EXIT_MS);
  }

  /** Re-shown mid-exit: keep the existing overlay and let it settle back in place. */
  private cancelExit() {
    if (this.exitTimer === null) return;
    this.clearExitTimer();
    this.overlayRef.overlayElement.querySelector<HTMLElement>(".toast")?.classList.remove("leaving");
  }

  private clearExitTimer() {
    if (this.exitTimer === null) return;
    window.clearTimeout(this.exitTimer);
    this.exitTimer = null;
  }

  private clearDelayTimer() {
    if (this.delayTimer === null) return;
    window.clearTimeout(this.delayTimer);
    this.delayTimer = null;
  }

  private updateOverlayPosition() {
    const bottom = this.stack.bottomOffsetFor(this.toastId, this.bottomOffsetPx());
    this.overlayRef.updatePositionStrategy(this.overlay.position().global().right("16px").bottom(`${bottom}px`));
    this.overlayRef.updatePosition();
  }

  private watchToastSize() {
    const toast = this.overlayRef.overlayElement.querySelector<HTMLElement>(".toast");
    if (!toast) return;

    this.measureToast(toast);
    queueMicrotask(() => this.measureToast(toast));
  }

  private measureToast(toast: HTMLElement) {
    const rect = toast.getBoundingClientRect();
    this.stack.updateHeight(this.toastId, rect.height || toast.offsetHeight);
    this.updateOverlayPosition();
  }
}
