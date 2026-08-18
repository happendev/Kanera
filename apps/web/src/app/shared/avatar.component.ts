import { NgOptimizedImage } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from "@angular/core";
import { blobatarUri } from "blobatar/uri";
import { visibleSignedMediaUrl } from "../core/media/signed-media-url";
import { PresenceService } from "../core/realtime/presence.service";
import { TooltipDirective } from "./tooltip.directive";

export function avatarColorIndex(userId: string | null | undefined, name: string): number {
  const key = userId?.trim() || name.trim().toLocaleLowerCase() || "?";
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return hash % 12;
}

export function avatarFallbackColorStyle(userId: string | null | undefined, name: string): string {
  const colorIndex = avatarColorIndex(userId, name);
  return `--mention-avatar-bg: var(--avatar-color-${colorIndex}-bg); --mention-avatar-fg: var(--avatar-color-${colorIndex}-fg);`;
}

const relativeTimeNow = signal(Date.now());
let relativeTimeTimer: number | null = null;
let relativeTimeConsumers = 0;

function watchRelativeTimeTicker(): () => void {
  relativeTimeConsumers += 1;
  if (relativeTimeTimer === null) {
    relativeTimeNow.set(Date.now());
    relativeTimeTimer = window.setInterval(() => relativeTimeNow.set(Date.now()), 30_000);
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    relativeTimeConsumers = Math.max(0, relativeTimeConsumers - 1);
    if (relativeTimeConsumers === 0 && relativeTimeTimer !== null) {
      window.clearInterval(relativeTimeTimer);
      relativeTimeTimer = null;
    }
  };
}

@Component({
  selector: "k-avatar",
  standalone: true,
  imports: [NgOptimizedImage, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="avatar-body" [kTooltip]="avatarTooltip()">
      @if (visibleUrl()) {
        <img [ngSrc]="visibleUrl()!" [width]="size()" [height]="size()" [alt]="name()" (error)="markImageFailed()" />
      } @else {
        <img class="blobatar" [src]="fallbackUrl()" [alt]="name()" />
      }
    </span>
    @if (online()) {
      <span class="presence-dot" aria-label="Online"></span>
    }
  `,
  styles: [`
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      position: relative;
      border-radius: 50%;
      flex-shrink: 0;
      background: transparent;
      line-height: 1;
    }

    .avatar-body {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      border-radius: inherit;
      overflow: hidden;
    }

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .presence-dot {
      position: absolute;
      right: 3px;
      bottom: 2px;
      width: max(6px, 24%);
      height: max(6px, 24%);
      box-sizing: border-box;
      border-radius: 50%;
      background: #22c55e;
      box-shadow: 0 0 0 2px var(--avatar-presence-ring, var(--surface));
      z-index: 1;
    }
  `],
  host: {
    "[style.width.px]": "size()",
    "[style.height.px]": "size()",
    "[class.is-fallback]": "!visibleUrl()",
  },
})
export class AvatarComponent {
  // PresenceService is lazy internally, so regular DI is safe here: avatars only
  // connect presence listeners when a caller opts in with a user/workspace pair.
  private readonly presence = inject(PresenceService);

  readonly url = input<string | null>(null);
  readonly name = input("");
  readonly size = input(32);
  readonly userId = input<string | null>(null);
  readonly workspaceId = input<string | null>(null);
  readonly showPresence = input(false);
  readonly showTooltip = input(true);
  readonly lastOnlineAt = input<string | Date | null | undefined>(null);

  private readonly failedUrl = signal<string | null>(null);

  constructor() {
    effect((onCleanup) => {
      const workspaceId = this.shouldCheckPresence() ? this.workspaceId() : null;
      if (!workspaceId) return;
      const unwatch = this.presence.watchWorkspace(workspaceId);
      onCleanup(unwatch);
    });

    effect((onCleanup) => {
      if (!this.shouldCheckPresence() || this.online() || !this.tooltipLastOnlineAt()) return;
      const unwatch = watchRelativeTimeTicker();
      onCleanup(unwatch);
    });
  }

  protected readonly visibleUrl = computed(() => {
    const url = this.url();
    if (!url || url === this.failedUrl()) return null;
    // A cached member/auth payload can carry a signed avatar URL whose token has
    // expired; suppress it so we show the local fallback instead of a guaranteed 404.
    return visibleSignedMediaUrl(url);
  });

  protected readonly fallbackUrl = computed(() => {
    // Prefer the immutable user id so a rename does not unexpectedly change a person's identity.
    const identity = this.userId()?.trim() || this.name().trim().toLocaleLowerCase() || "?";
    return blobatarUri(identity);
  });
  protected readonly online = computed(() => {
    if (!this.shouldCheckPresence()) return false;
    return this.presence.isOnline(this.workspaceId(), this.userId());
  });
  protected readonly avatarTooltip = computed(() => {
    if (!this.showTooltip()) return "";
    const name = this.name().trim();
    if (!name) return "";
    if (!this.shouldCheckPresence() || this.online()) return name;
    const lastOnline = formatLastOnline(this.tooltipLastOnlineAt(), relativeTimeNow());
    return lastOnline ? `${name} · Last online ${lastOnline}` : name;
  });
  private readonly tooltipLastOnlineAt = computed(() => this.liveLastOnlineAt() ?? this.lastOnlineAt() ?? null);
  private readonly liveLastOnlineAt = computed(() => {
    if (!this.shouldCheckPresence()) return null;
    return this.presence.lastOnlineAt(this.workspaceId(), this.userId());
  });
  private readonly shouldCheckPresence = computed(() => Boolean(this.showPresence() && this.userId() && this.workspaceId()));

  protected markImageFailed() {
    this.failedUrl.set(this.url());
  }
}

function formatLastOnline(value: string | Date | null | undefined, now: number): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  if (Number.isNaN(timestamp)) return null;

  const seconds = Math.round((timestamp - now) / 1000);
  const absSeconds = Math.abs(seconds);
  if (absSeconds < 60) return "less than a minute ago";
  const units: { unit: Intl.RelativeTimeFormatUnit; seconds: number }[] = [
    { unit: "year", seconds: 31_536_000 },
    { unit: "month", seconds: 2_592_000 },
    { unit: "day", seconds: 86_400 },
    { unit: "hour", seconds: 3_600 },
    { unit: "minute", seconds: 60 },
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const { unit, seconds: unitSeconds } of units) {
    if (absSeconds >= unitSeconds) return formatter.format(Math.round(seconds / unitSeconds), unit);
  }
  return formatter.format(seconds, "second");
}
