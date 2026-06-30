import type { OverlayRef } from "@angular/cdk/overlay";
import { Overlay } from "@angular/cdk/overlay";
import { TemplatePortal } from "@angular/cdk/portal";
import type { AfterViewInit, EffectRef, OnDestroy, TemplateRef} from "@angular/core";
import { ChangeDetectionStrategy, Component, ViewChild, ViewContainerRef, effect, inject, input, signal } from "@angular/core";
import { StatusToastStackService } from "./status-toast-stack.service";

@Component({
  selector: "k-status-toast",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-template #prompt>
      <div class="status-toast" role="status" aria-live="polite">
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

    .status-toast {
      display: flex;
      align-items: center;
      gap: 10px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
      padding: 10px 14px;
      animation: slide-up 160ms ease;
    }

    i {
      color: var(--text-muted);
      font-size: 16px;
    }

    .message {
      font-size: 13px;
      color: var(--text);
    }

    @keyframes slide-up {
      from { opacity: 0; transform: translateY(8px) }
      to { opacity: 1; transform: none }
    }
  `,
})
export class StatusToastComponent implements AfterViewInit, OnDestroy {
  private readonly overlay = inject(Overlay);
  private readonly stack = inject(StatusToastStackService);
  private readonly viewContainerRef = inject(ViewContainerRef);
  private readonly toastId = Symbol("status-toast");
  private readonly viewReady = signal(false);
  private readonly delayedShow = signal(false);
  private readonly overlayRef: OverlayRef;
  private readonly delayEffect: EffectRef;
  private readonly portalEffect: EffectRef;
  private delayTimer: number | null = null;

  readonly show = input(false);
  readonly delayMs = input(0);
  readonly bottomOffsetPx = input(16);
  readonly icon = input.required<string>();
  readonly message = input.required<string>();

  @ViewChild("prompt", { static: true }) private readonly promptTpl!: TemplateRef<unknown>;

  constructor() {
    this.overlayRef = this.overlay.create({
      hasBackdrop: false,
      positionStrategy: this.overlay.position().global().right("16px").bottom("16px"),
      scrollStrategy: this.overlay.scrollStrategies.noop(),
    });
    this.overlayRef.overlayElement.style.zIndex = "9000";

    this.delayEffect = effect((onCleanup) => {
      if (!this.viewReady()) return;

      this.clearDelayTimer();
      this.delayedShow.set(false);
      if (!this.show()) {
        this.stack.unregister(this.toastId);
        this.overlayRef.detach();
        return;
      }

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
        this.stack.register(this.toastId);
        this.updateOverlayPosition();
        if (!this.overlayRef.hasAttached()) {
          this.overlayRef.attach(new TemplatePortal(this.promptTpl, this.viewContainerRef));
          this.watchToastSize();
        }
      } else {
        this.stack.unregister(this.toastId);
        this.overlayRef.detach();
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
    this.stack.unregister(this.toastId);
    this.overlayRef.dispose();
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
    const toast = this.overlayRef.overlayElement.querySelector<HTMLElement>(".status-toast");
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
