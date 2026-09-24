import { DIALOG_DATA, DialogRef } from "@angular/cdk/dialog";
import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from "@angular/core";
import type { ElementRef, OnDestroy } from "@angular/core";
import type { SafeResourceUrl } from "@angular/platform-browser";
import { DomSanitizer } from "@angular/platform-browser";
import { MediaDownloadService } from "../../core/media/media-download.service";
import type { AttachmentPreviewType } from "../../shared/attachment-preview";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { DescriptionViewerComponent } from "./description-viewer.component";
import { formatDate } from "../../shared/date-format";

const MARKDOWN_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
/** Finger travel below this still counts as a tap rather than a pan. */
const TAP_SLOP_PX = 8;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 30;
const DOUBLE_TAP_SCALE = 2.5;

export type ImageLightboxItem = {
  src: string;
  fileName?: string;
  createdAt?: string | Date;
  mediaType?: AttachmentPreviewType;
  mimeType?: string;
};

export type ImageLightboxData = ImageLightboxItem & {
  images?: ImageLightboxItem[];
  initialIndex?: number;
};

@Component({
  selector: "k-image-lightbox",
  standalone: true,
  imports: [DescriptionViewerComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="lb-shell" (click)="close()">
      @if (hasMultiple()) {
      <button
        type="button"
        class="lb-nav-btn lb-nav-prev"
        (click)="showPrevious(); $event.stopPropagation()"
        aria-label="Previous attachment"
        kTooltip="Previous attachment"
      >
        <i class="ti ti-chevron-left"></i>
      </button>
      <button
        type="button"
        class="lb-nav-btn lb-nav-next"
        (click)="showNext(); $event.stopPropagation()"
        aria-label="Next attachment"
        kTooltip="Next attachment"
      >
        <i class="ti ti-chevron-right"></i>
      </button>
      <div class="lb-position" (click)="$event.stopPropagation()">{{ positionLabel() }}</div>
      }

      <!-- Gestures listen on the whole stage, not just the <img>: a fitted image on a phone is often
           too small for both pinch fingers to land on it. -->
      <div
        class="lb-img-wrap"
        [class.lb-img-wrap-gestures]="isImage()"
        (pointerdown)="startPan($event)"
        (pointermove)="movePan($event)"
        (pointerup)="endPan($event)"
        (pointercancel)="endPan($event)"
        (click)="onStageClick($event)"
      >
        @if (isVideo()) {
        <video
          class="lb-video"
          [src]="activeImage().src"
          controls
          autoplay
          playsinline
          preload="metadata"
          (click)="$event.stopPropagation()"
        ></video>
        } @else if (isAudio()) {
        <div class="lb-file-card lb-audio-card" (click)="$event.stopPropagation()">
          <i class="ti ti-file-music lb-file-icon"></i>
          <span class="lb-file-card-name">{{ activeImage().fileName || 'Audio attachment' }}</span>
          <audio [src]="activeImage().src" controls autoplay preload="metadata"></audio>
        </div>
        } @else if (isPdf()) {
          @if (pdfSrc(); as src) {
          <iframe
            class="lb-pdf"
            [src]="src"
            [title]="'PDF preview: ' + (activeImage().fileName || 'attachment.pdf')"
            (click)="$event.stopPropagation()"
          ></iframe>
          } @else {
          <div class="lb-file-card" (click)="$event.stopPropagation()">
            <i class="ti ti-file-type-pdf lb-file-icon"></i>
            <span class="lb-file-card-name">{{ activeImage().fileName || 'PDF attachment' }}</span>
            @if (pdfLoading()) {
            <span class="lb-file-hint">Loading preview…</span>
            } @else {
            <span class="lb-file-hint">Preview unavailable. Download the PDF to view it.</span>
            }
          </div>
          }
        } @else if (isMarkdown()) {
          <article class="lb-markdown" (click)="$event.stopPropagation()">
            @if (markdown(); as value) {
            <k-description-viewer [value]="value" emptyLabel="This Markdown file is empty." emptyIcon="markdown" [showCopy]="true" />
            } @else {
            <div class="lb-file-card lb-markdown-state">
              <i class="ti ti-markdown lb-file-icon"></i>
              <span class="lb-file-card-name">{{ activeImage().fileName || 'Markdown attachment' }}</span>
              @if (markdownLoading()) {
              <span class="lb-file-hint">Rendering preview…</span>
              } @else {
              <span class="lb-file-hint">{{ markdownError() || 'This Markdown file is empty.' }}</span>
              }
            </div>
            }
          </article>
        } @else {
        <img
          #lightboxImage
          class="lb-img"
          [class.lb-img-pannable]="scale() > 1"
          [class.lb-img-dragging]="isDragging()"
          [src]="activeImage().src"
          [style.transform]="imageTransform()"
          (wheel)="onWheel($event)"
          (click)="$event.stopPropagation()"
          draggable="false"
          alt=""
        />
        }
      </div>

      <div class="lb-controls" (click)="$event.stopPropagation()">
        @if (hasMultiple()) {
        <button type="button" class="lb-ctrl-btn" (click)="showPrevious()" aria-label="Previous attachment">
          <i class="ti ti-chevron-left"></i>
        </button>
        }
        @if (isImage()) {
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
        }
        @if (hasMultiple()) {
        <button type="button" class="lb-ctrl-btn" (click)="showNext()" aria-label="Next attachment">
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

    .lb-img,
    .lb-video {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      border-radius: var(--radius-sm);
      box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
      transform-origin: center center;
      transition: transform 0.15s ease;
      cursor: default;
    }

    .lb-img-wrap-gestures {
      overscroll-behavior: contain;
      touch-action: none;
    }

    .lb-img {
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
    }

    .lb-img-pannable {
      cursor: grab;
    }

    .lb-img-dragging {
      cursor: grabbing;
      transition: none;
    }

    .lb-video {
      width: min(1200px, 100%);
      background: #000;
    }

    .lb-file-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 14px;
      width: min(520px, calc(100vw - 48px));
      min-height: 280px;
      padding: 40px;
      box-sizing: border-box;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: var(--radius-lg);
      background: rgba(20, 20, 22, 0.94);
      box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
      color: #fff;
      cursor: default;
    }

    .lb-file-icon {
      font-size: 64px;
      color: rgba(255, 255, 255, 0.82);
    }

    .lb-file-card-name {
      max-width: 100%;
      overflow-wrap: anywhere;
      font-size: 17px;
      font-weight: 600;
      text-align: center;
    }

    .lb-audio-card audio {
      width: min(400px, 100%);
      margin-top: 8px;
    }

    .lb-file-hint {
      color: rgba(255, 255, 255, 0.58);
      font-size: 14px;
      text-align: center;
    }

    .lb-pdf {
      width: min(1200px, calc(100vw - 48px));
      height: calc(100vh - 150px);
      border: 0;
      border-radius: var(--radius-sm);
      background: #fff;
      box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
    }

    .lb-markdown {
      width: min(960px, calc(100vw - 48px));
      height: calc(100vh - 150px);
      padding: clamp(24px, 5vw, 64px);
      box-sizing: border-box;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--surface);
      box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
      color: var(--text);
      cursor: default;
    }

    .lb-markdown-state {
      width: 100%;
      min-height: 100%;
      padding: 24px;
      border: 0;
      background: transparent;
      box-shadow: none;
      color: var(--text);
    }

    .lb-markdown-state .lb-file-icon {
      color: var(--text-muted);
    }

    .lb-markdown-state .lb-file-hint {
      color: var(--text-muted);
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
export class ImageLightboxComponent implements OnDestroy {
  private readonly dialogRef = inject(DialogRef);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly mediaDownloads = inject(MediaDownloadService);
  private pdfObjectUrl: string | null = null;
  private pdfAbortController: AbortController | null = null;
  private markdownAbortController: AbortController | null = null;
  readonly data = inject(DIALOG_DATA) as ImageLightboxData;
  readonly images = this.resolveImages(this.data);

  readonly minScale = 0.5;
  readonly maxScale = 4;
  readonly step = 0.5;
  readonly scale = signal(1);
  readonly panX = signal(0);
  readonly panY = signal(0);
  readonly isDragging = signal(false);
  readonly currentIndex = signal(this.clampIndex(this.data.initialIndex ?? 0));
  private dragPointerId: number | null = null;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartPanX = 0;
  private dragStartPanY = 0;
  private readonly activePointers = new Map<number, { x: number; y: number }>();
  private pinchStartDistance = 0;
  private pinchStartScale = 1;
  private pinchStartMid = { x: 0, y: 0 };
  private pinchStartPan = { x: 0, y: 0 };
  private pinchOrigin = { x: 0, y: 0 };
  private gestureMoved = false;
  private suppressStageClick = false;
  private lastTap: { x: number; y: number; time: number } | null = null;
  private readonly imageRef = viewChild<ElementRef<HTMLImageElement>>("lightboxImage");

  readonly hasMultiple = computed(() => this.images.length > 1);
  readonly activeImage = computed(() => this.images[this.currentIndex()]!);
  readonly isImage = computed(() => !this.activeImage().mediaType || this.activeImage().mediaType === "image");
  readonly isVideo = computed(() => this.activeImage().mediaType === "video");
  readonly isAudio = computed(() => this.activeImage().mediaType === "audio");
  readonly isPdf = computed(() => this.activeImage().mediaType === "pdf");
  readonly isMarkdown = computed(() => this.activeImage().mediaType === "markdown");
  readonly pdfSrc = signal<SafeResourceUrl | null>(null);
  readonly pdfLoading = signal(false);
  readonly markdown = signal<string | null>(null);
  readonly markdownLoading = signal(false);
  readonly markdownError = signal<string | null>(null);
  readonly positionLabel = computed(() => `${this.currentIndex() + 1} / ${this.images.length}`);
  readonly zoomLabel = computed(() => Math.round(this.scale() * 100) + "%");
  readonly imageTransform = computed(() =>
    `translate(${this.panX()}px, ${this.panY()}px) scale(${this.scale()})`,
  );

  constructor() {
    effect(() => {
      const image = this.activeImage();
      this.resetPdfPreview();
      this.resetMarkdownPreview();
      if (this.isPdf()) {
        const controller = new AbortController();
        this.pdfAbortController = controller;
        void this.loadPdfPreview(image.src, controller);
      } else if (this.isMarkdown()) {
        const controller = new AbortController();
        this.markdownAbortController = controller;
        void this.loadMarkdownPreview(image.src, controller);
      }
    });
  }

  ngOnDestroy() {
    this.resetPdfPreview();
    this.resetMarkdownPreview();
  }

  zoomIn() {
    if (!this.isImage()) return;
    this.scale.update((s) => Math.min(this.maxScale, parseFloat((s + this.step).toFixed(2))));
  }

  zoomOut() {
    if (!this.isImage()) return;
    this.scale.update((s) => {
      const nextScale = Math.max(this.minScale, parseFloat((s - this.step).toFixed(2)));
      if (nextScale <= 1) this.resetPan();
      return nextScale;
    });
  }

  resetZoom() {
    this.scale.set(1);
    this.resetPan();
  }

  startPan(event: PointerEvent) {
    if (!this.isImage() || event.button !== 0) return;
    if (this.activePointers.size === 0) {
      this.gestureMoved = false;
      this.suppressStageClick = false;
    }
    if (event.pointerType === "mouse" && this.scale() <= 1) return;
    event.preventDefault();
    // Capture on the element under the finger, not the stage, so a tap on the image still clicks the
    // image (which stops propagation) instead of the stage (which closes the lightbox).
    (event.target as Element).setPointerCapture?.(event.pointerId);
    this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.activePointers.size === 2) {
      this.startPinch();
      return;
    }
    if (this.scale() <= 1) return;
    this.startDrag(event.pointerId, event.clientX, event.clientY);
  }

  movePan(event: PointerEvent) {
    if (!this.activePointers.has(event.pointerId)) return;
    this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.activePointers.size >= 2) {
      event.preventDefault();
      this.movePinch();
      return;
    }
    if (this.dragPointerId !== event.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - this.dragStartX;
    const dy = event.clientY - this.dragStartY;
    if (Math.hypot(dx, dy) > TAP_SLOP_PX) this.gestureMoved = true;
    this.setClampedPan(this.dragStartPanX + dx, this.dragStartPanY + dy);
  }

  endPan(event: PointerEvent) {
    const target = event.target as Element | null;
    if (target?.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
    if (!this.activePointers.delete(event.pointerId)) return;
    this.pinchStartDistance = 0;
    if (this.activePointers.size === 1) {
      // Lifting one finger of a pinch continues as a one-finger pan from where the other finger is.
      const [pointerId, pointer] = this.activePointers.entries().next().value!;
      if (this.scale() > 1) this.startDrag(pointerId, pointer.x, pointer.y);
      else {
        this.dragPointerId = null;
        this.isDragging.set(false);
      }
      return;
    }
    if (this.activePointers.size > 0) return;
    this.dragPointerId = null;
    this.isDragging.set(false);
    // Pinching below 100% is only a transient "rubber band"; settle back to the fitted image.
    if (this.scale() < 1) this.resetZoom();
    // A drag or pinch ends with a synthetic click on whatever is under the finger; when that is the
    // stage backdrop it must not close the lightbox.
    this.suppressStageClick = this.gestureMoved;
    if (!this.gestureMoved && event.pointerType === "touch" && target === this.imageElement()) {
      this.handleTap(event.clientX, event.clientY);
    }
  }

  onStageClick(event: MouseEvent) {
    if (!this.suppressStageClick) return;
    this.suppressStageClick = false;
    event.stopPropagation();
  }

  onWheel(event: WheelEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (event.deltaY < 0) this.zoomIn();
    if (event.deltaY > 0) this.zoomOut();
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
    return formatDate(value, "medium");
  }

  async downloadActiveImage() {
    const image = this.activeImage();
    await this.mediaDownloads.download(image.src, image.fileName ?? "");
  }

  private async loadPdfPreview(src: string, controller: AbortController) {
    this.pdfLoading.set(true);
    try {
      const response = await fetch(src, { signal: controller.signal });
      if (!response.ok) throw new Error(`PDF preview failed with status ${response.status}`);
      const source = await response.blob();
      if (controller.signal.aborted || this.pdfAbortController !== controller) return;
      const pdf = source.type === "application/pdf"
        ? source
        : new Blob([source], { type: "application/pdf" });
      this.pdfObjectUrl = URL.createObjectURL(pdf);
      this.pdfSrc.set(this.sanitizer.bypassSecurityTrustResourceUrl(this.pdfObjectUrl));
    } catch {
      if (!controller.signal.aborted && this.pdfAbortController === controller) this.pdfSrc.set(null);
    } finally {
      if (this.pdfAbortController === controller) this.pdfLoading.set(false);
    }
  }

  private resetPdfPreview(): void {
    this.pdfAbortController?.abort();
    this.pdfAbortController = null;
    if (this.pdfObjectUrl) URL.revokeObjectURL(this.pdfObjectUrl);
    this.pdfObjectUrl = null;
    this.pdfSrc.set(null);
    this.pdfLoading.set(false);
  }

  private async loadMarkdownPreview(src: string, controller: AbortController) {
    this.markdownLoading.set(true);
    try {
      const response = await fetch(src, { signal: controller.signal });
      if (!response.ok) throw new Error(`Markdown preview failed with status ${response.status}`);
      const source = await response.blob();
      if (source.size > MARKDOWN_PREVIEW_MAX_BYTES) {
        throw new Error("This Markdown file is too large to preview. Download it to view the full file.");
      }
      const value = await source.text();
      if (controller.signal.aborted || this.markdownAbortController !== controller) return;
      this.markdown.set(value);
    } catch (error) {
      if (controller.signal.aborted || this.markdownAbortController !== controller) return;
      this.markdown.set(null);
      this.markdownError.set(error instanceof Error && error.message.startsWith("This Markdown file")
        ? error.message
        : "Preview unavailable. Download the Markdown file to view it.");
    } finally {
      if (this.markdownAbortController === controller) this.markdownLoading.set(false);
    }
  }

  private resetMarkdownPreview(): void {
    this.markdownAbortController?.abort();
    this.markdownAbortController = null;
    this.markdown.set(null);
    this.markdownLoading.set(false);
    this.markdownError.set(null);
  }

  private resolveImages(data: ImageLightboxData): ImageLightboxItem[] {
    if (data.images?.length) return data.images;
    return [{
      src: data.src,
      fileName: data.fileName,
      createdAt: data.createdAt,
      mediaType: data.mediaType,
      mimeType: data.mimeType,
    }];
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

  private imageElement(): HTMLImageElement | null {
    return this.imageRef()?.nativeElement ?? null;
  }

  private resetPan(): void {
    this.dragPointerId = null;
    this.activePointers.clear();
    this.pinchStartDistance = 0;
    this.isDragging.set(false);
    this.panX.set(0);
    this.panY.set(0);
  }

  private panBounds(image: HTMLImageElement): { x: number; y: number } {
    const container = image.parentElement;
    if (!container) return { x: 0, y: 0 };
    // Keep at least one edge of the scaled image aligned with the viewport so panning cannot lose it
    // completely off-screen. The image's untransformed dimensions are stable while it is dragged.
    return {
      x: Math.max(0, (image.offsetWidth * this.scale() - container.clientWidth) / 2),
      y: Math.max(0, (image.offsetHeight * this.scale() - container.clientHeight) / 2),
    };
  }

  private startDrag(pointerId: number, x: number, y: number): void {
    this.dragPointerId = pointerId;
    this.dragStartX = x;
    this.dragStartY = y;
    this.dragStartPanX = this.panX();
    this.dragStartPanY = this.panY();
    this.isDragging.set(true);
  }

  private startPinch(): void {
    const [first, second] = [...this.activePointers.values()];
    if (!first || !second) return;
    this.gestureMoved = true;
    this.dragPointerId = null;
    // isDragging also disables the transform transition, which otherwise makes pinching lag behind.
    this.isDragging.set(true);
    this.pinchStartDistance = Math.hypot(second.x - first.x, second.y - first.y);
    this.pinchStartScale = this.scale();
    this.pinchStartMid = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    this.pinchStartPan = { x: this.panX(), y: this.panY() };
    this.pinchOrigin = this.imageOrigin();
  }

  private movePinch(): void {
    const [first, second] = [...this.activePointers.values()];
    if (!first || !second || this.pinchStartDistance <= 0) return;
    const distance = Math.hypot(second.x - first.x, second.y - first.y);
    const nextScale = parseFloat(
      this.clamp(this.pinchStartScale * distance / this.pinchStartDistance, this.minScale, this.maxScale).toFixed(3),
    );
    const mid = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    // Keep the image point that started under the fingers' midpoint under the current midpoint, so the
    // image zooms around the pinch and follows the fingers as they move together.
    const ratio = nextScale / this.pinchStartScale;
    const origin = this.pinchOrigin;
    this.scale.set(nextScale);
    this.setClampedPan(
      mid.x - origin.x - ratio * (this.pinchStartMid.x - origin.x - this.pinchStartPan.x),
      mid.y - origin.y - ratio * (this.pinchStartMid.y - origin.y - this.pinchStartPan.y),
    );
  }

  /** Double-tap toggles between the fitted image and a close-up centred on the tapped point. */
  private handleTap(x: number, y: number): void {
    const now = Date.now();
    const last = this.lastTap;
    this.lastTap = { x, y, time: now };
    if (!last || now - last.time > DOUBLE_TAP_MS || Math.hypot(x - last.x, y - last.y) > DOUBLE_TAP_SLOP_PX) return;
    this.lastTap = null;
    if (this.scale() > 1) {
      this.resetZoom();
      return;
    }
    const origin = this.imageOrigin();
    const ratio = DOUBLE_TAP_SCALE / this.scale();
    this.scale.set(DOUBLE_TAP_SCALE);
    this.setClampedPan(
      x - origin.x - ratio * (x - origin.x - this.panX()),
      y - origin.y - ratio * (y - origin.y - this.panY()),
    );
  }

  /** Screen position of the image's untransformed centre, which is its scale origin. */
  private imageOrigin(): { x: number; y: number } {
    const image = this.imageElement();
    if (!image) return { x: 0, y: 0 };
    const rect = image.getBoundingClientRect();
    // Scaling about the centre leaves the centre in place, so only the pan offset needs removing.
    return { x: rect.left + rect.width / 2 - this.panX(), y: rect.top + rect.height / 2 - this.panY() };
  }

  private setClampedPan(x: number, y: number): void {
    const image = this.imageElement();
    const bounds = image ? this.panBounds(image) : { x: 0, y: 0 };
    this.panX.set(this.clamp(x, -bounds.x, bounds.x) || 0);
    this.panY.set(this.clamp(y, -bounds.y, bounds.y) || 0);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
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
