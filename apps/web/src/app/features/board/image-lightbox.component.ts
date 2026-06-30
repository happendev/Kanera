import { DIALOG_DATA, DialogRef } from "@angular/cdk/dialog";
import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  inject,
  signal,
} from "@angular/core";
import { TooltipDirective } from "../../shared/tooltip.directive";

export type ImageLightboxItem = {
  src: string;
  fileName?: string;
  createdAt?: string | Date;
};

export type ImageLightboxData = ImageLightboxItem & {
  images?: ImageLightboxItem[];
  initialIndex?: number;
};

@Component({
  selector: "k-image-lightbox",
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="lb-shell" (click)="close()">
      @if (hasMultiple()) {
      <button
        type="button"
        class="lb-nav-btn lb-nav-prev"
        (click)="showPrevious(); $event.stopPropagation()"
        aria-label="Previous image"
        kTooltip="Previous image"
      >
        <i class="ti ti-chevron-left"></i>
      </button>
      <button
        type="button"
        class="lb-nav-btn lb-nav-next"
        (click)="showNext(); $event.stopPropagation()"
        aria-label="Next image"
        kTooltip="Next image"
      >
        <i class="ti ti-chevron-right"></i>
      </button>
      <div class="lb-position" (click)="$event.stopPropagation()">{{ positionLabel() }}</div>
      }

      <div class="lb-img-wrap">
        <img
          class="lb-img"
          [src]="activeImage().src"
          [style.transform]="'scale(' + scale() + ')'"
          (click)="$event.stopPropagation()"
          alt=""
        />
      </div>

      <div class="lb-controls" (click)="$event.stopPropagation()">
        @if (hasMultiple()) {
        <button type="button" class="lb-ctrl-btn" (click)="showPrevious()" aria-label="Previous image">
          <i class="ti ti-chevron-left"></i>
        </button>
        }
        <button type="button" class="lb-ctrl-btn" (click)="zoomOut()" [disabled]="scale() <= minScale" aria-label="Zoom out">
          <i class="ti ti-zoom-out"></i>
        </button>
        <span class="lb-zoom-pct">{{ zoomLabel() }}</span>
        <button type="button" class="lb-ctrl-btn" (click)="zoomIn()" [disabled]="scale() >= maxScale" aria-label="Zoom in">
          <i class="ti ti-zoom-in"></i>
        </button>
        <button type="button" class="lb-ctrl-btn" (click)="resetZoom()" aria-label="Reset zoom" kTooltip="Reset zoom (0)">
          <i class="ti ti-arrows-maximize"></i>
        </button>
        @if (hasMultiple()) {
        <button type="button" class="lb-ctrl-btn" (click)="showNext()" aria-label="Next image">
          <i class="ti ti-chevron-right"></i>
        </button>
        }
        <span class="lb-ctrl-sep"></span>
        <button
          type="button"
          class="lb-ctrl-btn"
          (click)="downloadActiveImage(); $event.stopPropagation()"
          aria-label="Download"
          kTooltip="Download"
        >
          <i class="ti ti-download"></i>
        </button>
        <button type="button" class="lb-ctrl-btn" (click)="close()" aria-label="Close">
          <i class="ti ti-x"></i>
        </button>
      </div>

      @if (activeImage().fileName || activeImage().createdAt) {
      <div class="lb-footer" (click)="$event.stopPropagation()">
        @if (activeImage().fileName) {
        <span class="lb-footer-name">{{ activeImage().fileName }}</span>
        }
        @if (activeImage().fileName && activeImage().createdAt) {
        <span class="lb-footer-sep">·</span>
        }
        @if (activeImage().createdAt; as createdAt) {
        <span class="lb-footer-date">Added {{ formatDate(createdAt) }}</span>
        }
      </div>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      width: 100vw;
      height: 100vh;
      box-sizing: border-box;
    }

    .lb-shell {
      position: relative;
      display: flex;
      flex-direction: column;
      justify-content: center;
      width: 100%;
      height: 100%;
      cursor: pointer;
    }

    .lb-controls {
      position: absolute;
      bottom: 60px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 8px 10px;
      background: rgba(0, 0, 0, 0.65);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      white-space: nowrap;
    }

    .lb-position {
      position: absolute;
      top: 24px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2;
      padding: 8px 12px;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      color: rgba(255, 255, 255, 0.85);
      font-size: 13px;
      font-weight: 500;
      letter-spacing: 0.02em;
      cursor: default;
    }

    .lb-ctrl-sep {
      width: 1px;
      height: 22px;
      background: rgba(255, 255, 255, 0.2);
      margin: 0 4px;
    }

    .lb-zoom-pct {
      font-size: 13px;
      color: rgba(255, 255, 255, 0.7);
      min-width: 46px;
      text-align: center;
    }

    .lb-ctrl-btn {
      width: 40px;
      height: 40px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
      border-radius: 8px;
      color: rgba(255, 255, 255, 0.85);
      font-size: 20px;
      cursor: pointer;
      transition: background-color 0.15s, color 0.15s;
      text-decoration: none;
    }

    .lb-ctrl-btn:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.15);
      color: #fff;
    }

    .lb-ctrl-btn:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }

    .lb-nav-btn {
      position: absolute;
      top: 50%;
      z-index: 2;
      width: 48px;
      height: 48px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      color: rgba(255, 255, 255, 0.92);
      font-size: 24px;
      cursor: pointer;
      transform: translateY(-50%);
      transition: background-color 0.15s, color 0.15s;
    }

    .lb-nav-btn:hover {
      background: rgba(255, 255, 255, 0.15);
      color: #fff;
    }

    .lb-nav-prev {
      left: 24px;
    }

    .lb-nav-next {
      right: 24px;
    }

    .lb-img-wrap {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      padding: 24px 24px 120px;
      box-sizing: border-box;
      overflow: hidden;
      cursor: default;
    }

    .lb-img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      border-radius: var(--radius-sm);
      box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
      transform-origin: center center;
      transition: transform 0.15s ease;
      cursor: default;
    }

    .lb-footer {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 14px 20px;
      background: linear-gradient(to top, rgba(0, 0, 0, 0.6), transparent);
      cursor: default;
    }

    .lb-footer-name {
      font-size: 15px;
      font-weight: 500;
      color: rgba(255, 255, 255, 0.95);
    }

    .lb-footer-sep {
      font-size: 14px;
      color: rgba(255, 255, 255, 0.4);
    }

    .lb-footer-date {
      font-size: 13px;
      color: rgba(255, 255, 255, 0.6);
    }

    @media (max-width: 720px) {
      .lb-nav-prev {
        left: 12px;
      }

      .lb-nav-next {
        right: 12px;
      }

      .lb-controls {
        bottom: 56px;
      }
    }
  `,
})
export class ImageLightboxComponent {
  private readonly dialogRef = inject(DialogRef);
  readonly data = inject(DIALOG_DATA) as ImageLightboxData;
  readonly images = this.resolveImages(this.data);

  readonly minScale = 0.5;
  readonly maxScale = 4;
  readonly step = 0.5;
  readonly scale = signal(1);
  readonly currentIndex = signal(this.clampIndex(this.data.initialIndex ?? 0));

  readonly hasMultiple = computed(() => this.images.length > 1);
  readonly activeImage = computed(() => this.images[this.currentIndex()]!);
  readonly positionLabel = computed(() => `${this.currentIndex() + 1} / ${this.images.length}`);
  readonly zoomLabel = computed(() => Math.round(this.scale() * 100) + "%");

  zoomIn() {
    this.scale.update((s) => Math.min(this.maxScale, parseFloat((s + this.step).toFixed(2))));
  }

  zoomOut() {
    this.scale.update((s) => Math.max(this.minScale, parseFloat((s - this.step).toFixed(2))));
  }

  resetZoom() {
    this.scale.set(1);
  }

  showPrevious() {
    this.navigate(-1);
  }

  showNext() {
    this.navigate(1);
  }

  close() {
    this.dialogRef.close();
  }

  formatDate(value: string | Date): string {
    return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  async downloadActiveImage() {
    const image = this.activeImage();
    const fileName = image.fileName ?? "";
    try {
      const response = await fetch(image.src);
      if (!response.ok) throw new Error(`Image download failed with status ${response.status}`);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      try {
        this.triggerDownload(objectUrl, fileName);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
      return;
    } catch {
      this.triggerDownload(image.src, fileName);
    }
  }

  private resolveImages(data: ImageLightboxData): ImageLightboxItem[] {
    if (data.images?.length) return data.images;
    return [{ src: data.src, fileName: data.fileName, createdAt: data.createdAt }];
  }

  private triggerDownload(url: string, fileName: string) {
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
  }

  private clampIndex(index: number): number {
    if (this.images.length === 0) return 0;
    return Math.min(Math.max(index, 0), this.images.length - 1);
  }

  private navigate(direction: -1 | 1) {
    if (this.images.length <= 1) return;
    const nextIndex = (this.currentIndex() + direction + this.images.length) % this.images.length;
    this.currentIndex.set(nextIndex);
    this.resetZoom();
  }

  @HostListener("document:keydown.=")
  onKeyZoomIn() { this.zoomIn(); }

  @HostListener("document:keydown.-")
  onKeyZoomOut() { this.zoomOut(); }

  @HostListener("document:keydown.0")
  onKeyReset() { this.resetZoom(); }

  @HostListener("document:keydown.arrowleft", ["$event"])
  onKeyPrevious(event: Event) {
    if (!this.hasMultiple()) return;
    (event as KeyboardEvent).preventDefault();
    this.showPrevious();
  }

  @HostListener("document:keydown.arrowright", ["$event"])
  onKeyNext(event: Event) {
    if (!this.hasMultiple()) return;
    (event as KeyboardEvent).preventDefault();
    this.showNext();
  }
}
