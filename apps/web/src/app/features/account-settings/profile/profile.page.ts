import { ChangeDetectionStrategy, Component, ViewChild, inject, signal } from "@angular/core";
import type { ElementRef, OnDestroy, OnInit } from "@angular/core";
import { ApiClient, ApiError } from "../../../core/api/api.client";
import { AuthService } from "../../../core/auth/auth.service";
import { CookieConsentService } from "../../../core/consent/cookie-consent.service";
import { AvatarComponent } from "../../../shared/avatar.component";
import { mfaQrDataUrl } from "../../../shared/mfa-qr";
import { AccountSettingsPage } from "../account-settings.page";

@Component({
  selector: "k-account-settings-profile",
  standalone: true,
  imports: [AvatarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./profile.page.html",
  styleUrl: "./profile.page.scss",
})
export class AccountSettingsProfilePage implements OnDestroy, OnInit {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  protected readonly consent = inject(CookieConsentService);
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
  protected readonly mfaEnabled = signal(false);
  protected readonly mfaPassword = signal("");
  protected readonly mfaCode = signal("");
  protected readonly mfaSecret = signal("");
  protected readonly mfaQrUrl = signal("");
  protected readonly mfaRecoveryCodes = signal<string[]>([]);
  protected readonly mfaBusy = signal(false);
  protected readonly mfaError = signal<string | null>(null);

  private canvas: HTMLCanvasElement | null = null;
  private avatarImage: HTMLImageElement | null = null;
  private dragStart: { x: number; y: number; offsetX: number; offsetY: number } | null = null;

  constructor() {
    this.settings.selectedTab.set("profile");
  }

  async ngOnInit() {
    const status = await this.api.get<{ enabled: boolean }>("/auth/mfa");
    this.mfaEnabled.set(status.enabled);
  }

  protected async startMfa() {
    if (!this.mfaPassword()) { this.mfaError.set("Enter your current password to set up an authenticator."); return; }
    await this.runMfa(async () => {
      const setup = await this.api.post<{ secret: string; otpauthUri: string }>("/auth/mfa/enroll", { currentPassword: this.mfaPassword() });
      this.mfaSecret.set(setup.secret);
      this.mfaQrUrl.set(mfaQrDataUrl(setup.otpauthUri));
    });
  }

  protected async confirmMfa() {
    if (!/^\d{6}$/.test(this.mfaCode().trim())) { this.mfaError.set("Enter the six-digit code from your authenticator app."); return; }
    await this.runMfa(async () => {
      const result = await this.api.post<{ recoveryCodes: string[] }>("/auth/mfa/enroll/confirm", { code: this.mfaCode() });
      this.mfaEnabled.set(true); this.mfaRecoveryCodes.set(result.recoveryCodes); this.mfaSecret.set(""); this.mfaQrUrl.set(""); this.mfaCode.set("");
    });
  }

  protected async regenerateMfaCodes() {
    if (!this.mfaPassword()) { this.mfaError.set("Enter your current password."); return; }
    if (!this.mfaCode().trim()) { this.mfaError.set("Enter an authenticator or recovery code."); return; }
    await this.runMfa(async () => { const result = await this.api.post<{ recoveryCodes: string[] }>("/auth/mfa/recovery-codes", { currentPassword: this.mfaPassword(), code: this.mfaCode() }); this.mfaRecoveryCodes.set(result.recoveryCodes); });
  }

  protected async disableMfa() {
    if (!this.mfaPassword()) { this.mfaError.set("Enter your current password."); return; }
    if (!this.mfaCode().trim()) { this.mfaError.set("Enter an authenticator or recovery code."); return; }
    await this.runMfa(async () => { await this.api.delete("/auth/mfa", { currentPassword: this.mfaPassword(), code: this.mfaCode() }); this.mfaEnabled.set(false); this.mfaRecoveryCodes.set([]); this.mfaCode.set(""); });
  }

  private async runMfa(action: () => Promise<void>) {
    this.mfaBusy.set(true); this.mfaError.set(null);
    try { await action(); } catch (err) { this.mfaError.set(extractErrorMessage(err)); } finally { this.mfaBusy.set(false); }
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
  if (err instanceof ApiError) {
    const message = (err.body as { message?: unknown } | null)?.message;
    if (message === "invalid verification code") return "That verification code is incorrect. Try again.";
    if (message === "invalid password") return "Your current password is incorrect.";
    if (message === "validation failed") return "Check the highlighted details and try again.";
    if (typeof message === "string" && message.trim()) return message;
    return "Unable to update two-factor authentication. Try again.";
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
