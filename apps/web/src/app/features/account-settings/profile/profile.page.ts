import { ChangeDetectionStrategy, Component, ViewChild, inject, signal } from "@angular/core";
import type { ElementRef, OnDestroy } from "@angular/core";
import { ApiClient, ApiError } from "../../../core/api/api.client";
import { AuthService } from "../../../core/auth/auth.service";
import { AvatarComponent } from "../../../shared/avatar.component";
import { AccountSettingsPage } from "../account-settings.page";

@Component({
  selector: "k-account-settings-profile",
  standalone: true,
  imports: [AvatarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./profile.page.html",
  styleUrl: "./profile.page.scss",
})
export class AccountSettingsProfilePage implements OnDestroy {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  protected readonly settings = inject(AccountSettingsPage);

  @ViewChild("avatarCanvas") set avatarCanvas(canvas: ElementRef<HTMLCanvasElement> | undefined) {
    this.canvas = canvas?.nativeElement ?? null;
    if (this.canvas) requestAnimationFrame(() => this.drawAvatarCrop());
  }

  protected readonly avatarUploading = signal(false);
  protected readonly avatarError = signal<string | null>(null);
  protected readonly avatarCropSrc = signal<string | null>(null);
  protected readonly avatarCropFileName = signal("avatar.jpg");
  protected readonly avatarZoom = signal(1);
  protected readonly avatarOffsetX = signal(0);
  protected readonly avatarOffsetY = signal(0);
  protected readonly avatarDragging = signal(false);

  private canvas: HTMLCanvasElement | null = null;
  private avatarImage: HTMLImageElement | null = null;
  private dragStart: { x: number; y: number; offsetX: number; offsetY: number } | null = null;

  constructor() {
    this.settings.selectedTab.set("profile");
  }

  ngOnDestroy() {
    this.cancelAvatarCrop();
  }

  protected async selectAvatar(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;

    this.avatarError.set(null);
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      this.avatarError.set("Use a PNG, JPEG, or WEBP image.");
      return;
    }
    if (file.size > 6 * 1024 * 1024) {
      this.avatarError.set("Choose an image 6MB or smaller before cropping.");
      return;
    }

    if (this.avatarCropSrc()) URL.revokeObjectURL(this.avatarCropSrc()!);
    const url = URL.createObjectURL(file);
    this.avatarCropFileName.set(file.name.replace(/\.[^.]+$/, ".jpg") || "avatar.jpg");
    this.avatarCropSrc.set(url);
    this.avatarZoom.set(1);
    this.avatarOffsetX.set(0);
    this.avatarOffsetY.set(0);

    const image = new Image();
    image.onload = () => {
      this.avatarImage = image;
      this.fitAvatarToCircle();
      requestAnimationFrame(() => this.drawAvatarCrop());
    };
    image.src = url;
  }

  protected setAvatarZoom(value: string | number) {
    this.avatarZoom.set(Number(value));
    this.clampAvatarOffset();
    this.drawAvatarCrop();
  }

  protected startAvatarDrag(e: PointerEvent) {
    if (!this.avatarCropSrc() || !this.canvas) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.avatarDragging.set(true);
    this.dragStart = { x: e.clientX, y: e.clientY, offsetX: this.avatarOffsetX(), offsetY: this.avatarOffsetY() };
  }

  protected dragAvatar(e: PointerEvent) {
    if (!this.dragStart) return;
    this.avatarOffsetX.set(this.dragStart.offsetX + e.clientX - this.dragStart.x);
    this.avatarOffsetY.set(this.dragStart.offsetY + e.clientY - this.dragStart.y);
    this.clampAvatarOffset();
    this.drawAvatarCrop();
  }

  protected endAvatarDrag() {
    this.avatarDragging.set(false);
    this.dragStart = null;
  }

  protected cancelAvatarCrop() {
    if (this.avatarCropSrc()) URL.revokeObjectURL(this.avatarCropSrc()!);
    this.avatarCropSrc.set(null);
    this.avatarImage = null;
    this.dragStart = null;
  }

  protected async uploadAvatarCrop() {
    const canvas = this.canvas;
    if (!canvas || !this.avatarImage) return;
    this.avatarError.set(null);
    this.avatarUploading.set(true);
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.75));
      if (!blob) throw new Error("Could not prepare image.");
      if (blob.size > 2 * 1024 * 1024) throw new Error("Cropped avatar must be 2MB or smaller.");
      const form = new FormData();
      form.append("file", blob, this.avatarCropFileName());
      const updated = await this.api.request<{ avatarUrl: string | null }>("/auth/me/avatar", { method: "POST", body: form });
      this.auth.updateUser((u) => ({ ...u, avatarUrl: updated.avatarUrl }));
      this.cancelAvatarCrop();
    } catch (err) {
      this.avatarError.set(extractErrorMessage(err));
    } finally {
      this.avatarUploading.set(false);
    }
  }

  protected async deleteAvatar() {
    this.avatarError.set(null);
    this.avatarUploading.set(true);
    try {
      const updated = await this.api.delete<{ avatarUrl: string | null }>("/auth/me/avatar");
      this.auth.updateUser((u) => ({ ...u, avatarUrl: updated.avatarUrl }));
      this.cancelAvatarCrop();
    } catch (err) {
      this.avatarError.set(extractErrorMessage(err));
    } finally {
      this.avatarUploading.set(false);
    }
  }

  private fitAvatarToCircle() {
    if (!this.avatarImage) return;
    this.avatarZoom.set(1);
    this.clampAvatarOffset();
  }

  private avatarBaseScale() {
    if (!this.avatarImage) return 1;
    return Math.max(320 / this.avatarImage.width, 320 / this.avatarImage.height);
  }

  private clampAvatarOffset() {
    if (!this.avatarImage) return;
    // Zoom is relative to the fitted cover size, not source pixels. Large phone photos
    // should start fully usable at the minimum zoom instead of appearing over-cropped.
    const scale = this.avatarBaseScale() * this.avatarZoom();
    const width = this.avatarImage.width * scale;
    const height = this.avatarImage.height * scale;
    this.avatarOffsetX.set(Math.max((320 - width) / 2, Math.min((width - 320) / 2, this.avatarOffsetX())));
    this.avatarOffsetY.set(Math.max((320 - height) / 2, Math.min((height - 320) / 2, this.avatarOffsetY())));
  }

  private drawAvatarCrop() {
    if (!this.canvas || !this.avatarImage) return;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const size = this.canvas.width;
    const scale = this.avatarBaseScale() * this.avatarZoom();
    const width = this.avatarImage.width * scale;
    const height = this.avatarImage.height * scale;
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(this.avatarImage, (size - width) / 2 + this.avatarOffsetX(), (size - height) / 2 + this.avatarOffsetY(), width, height);
    ctx.restore();
  }
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
