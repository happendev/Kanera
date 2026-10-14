import { NgOptimizedImage } from "@angular/common";
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, signal } from "@angular/core";
import type { BlobatarOptions } from "blobatar";
import { blobatarUri } from "blobatar/uri";
import { isDarkTheme, type Theme } from "../core/theme/theme.service";
import { visibleSignedMediaUrl } from "../core/media/signed-media-url";
import { PresenceService } from "../core/realtime/presence.service";
import { TooltipDirective } from "./tooltip.directive";
import { appLocale } from "../core/i18n/locale";
import { UserProfileCardService, type UserProfileAction } from "./user-profile/user-profile-card.service";

/** Number of `--avatar-color-N-*` slots defined in styles.scss. */
const AVATAR_COLOR_COUNT = 10;

export function avatarColorIndex(userId: string | null | undefined, name: string): number {
  const key = userId?.trim() || name.trim().toLocaleLowerCase() || "?";
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return hash % AVATAR_COLOR_COUNT;
}

export function avatarFallbackColorStyle(userId: string | null | undefined, name: string): string {
  const colorIndex = avatarColorIndex(userId, name);
  return `--mention-avatar-bg: var(--avatar-color-${colorIndex}-bg); --mention-avatar-fg: var(--avatar-color-${colorIndex}-fg);`;
}

/**
 * Blobatars render on a transparent backdrop, and the library's tone set spans pastel to near-black, so
 * pale bodies vanish on light themes and ink bodies on dark ones. Each theme family drops only the tones
 * that fail on it: dark keeps the pastels and loses ink, light keeps ink and loses the pale swatches.
 * Positions are swatch midpoints (pastel, grey-pale, vivid, deep, light, ink). A person's tone can change
 * with the theme; hue and shape come from the identity alone, so they stay recognisable.
 */
const BLOBATAR_DARK_THEME_OPTIONS: BlobatarOptions = { traits: { tone: [0.1, 0.28, 0.5, 0.7, 0.86] } };
const BLOBATAR_LIGHT_THEME_OPTIONS: BlobatarOptions = { traits: { tone: [0.5, 0.7, 0.96] } };

/**
 * Tracks the `data-theme` attribute ThemeService stamps on <html>, rather than injecting ThemeService:
 * avatars render inside nearly every component, and pulling the service's matchMedia/storage setup into
 * all of their tests (and the admin console) is not worth it for one boolean.
 */
let documentThemeDark: ReturnType<typeof signal<boolean>> | null = null;

export function documentThemeIsDark(): boolean {
  if (!documentThemeDark) {
    const root = document.documentElement;
    // Before index.html stamps the attribute, styles.scss follows the OS scheme, so mirror that.
    const read = () => {
      const theme = root.dataset["theme"] as Theme | undefined;
      return theme ? isDarkTheme(theme) : Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches);
    };
    documentThemeDark = signal(read());
    new MutationObserver(() => documentThemeDark?.set(read())).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  }
  return documentThemeDark();
}

export function blobatarFallbackUri(identity: string, isDark: boolean): string {
  return blobatarUri(identity, isDark ? BLOBATAR_DARK_THEME_OPTIONS : BLOBATAR_LIGHT_THEME_OPTIONS);
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
      <span class="presence-dot" aria-label="Online" i18n-aria-label="Presence indicator: the person is online now"></span>
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

    /* Clickable avatars (profile) get a hover ring and a keyboard focus ring on the avatar itself. The
       ring is an outline so it never shifts an overlapping assignee stack. */
    :host(.has-profile) {
      cursor: pointer;
      outline: 2px solid transparent;
      outline-offset: 1px;
      transition: outline-color var(--motion-fast, 120ms);
    }

    :host(.has-profile:hover) {
      outline-color: color-mix(in srgb, var(--accent) 45%, transparent);
    }

    :host(.has-profile:focus-visible),
    :host(.has-profile.is-profile-open) {
      outline-color: var(--accent);
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
    "[class.has-profile]": "profileEnabled()",
    "[class.is-profile-open]": "profileOpen()",
    "[attr.role]": "profileEnabled() ? 'button' : null",
    "[attr.tabindex]": "profileEnabled() ? 0 : null",
    "[attr.aria-haspopup]": "profileEnabled() ? 'dialog' : null",
    "[attr.aria-expanded]": "profileEnabled() ? profileOpen() : null",
    "[attr.aria-label]": "profileEnabled() ? profileAriaLabel() : null",
    "(click)": "onProfileClick($event)",
    "(keydown.enter)": "onProfileClick($event)",
    "(keydown.space)": "onProfileClick($event)",
  },
})
export class AvatarComponent {
  // PresenceService is lazy internally, so regular DI is safe here: avatars only
  // connect presence listeners when a caller opts in with a user/workspace pair.
  private readonly presence = inject(PresenceService);
  private readonly profileCards = inject(UserProfileCardService);
  private readonly hostRef = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly url = input<string | null>(null);
  readonly name = input("");
  readonly size = input(32);
  readonly userId = input<string | null>(null);
  readonly workspaceId = input<string | null>(null);
  readonly showPresence = input(false);
  readonly showTooltip = input(true);
  readonly lastOnlineAt = input<string | Date | null | undefined>(null);
  /**
   * Opt-in: clicking opens the person's profile card. Off by default because many avatars sit inside
   * something that already owns the click (member pickers, notification rows, the board header's
   * members button), and a nested interactive control inside a button is invalid and unreachable.
   */
  readonly profile = input(false);
  /** Surface-specific actions for the profile card's footer, e.g. "Unassign" from a card. */
  readonly profileActions = input<readonly UserProfileAction[] | null>(null);

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
    return blobatarFallbackUri(identity, documentThemeIsDark());
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
    return lastOnline
      ? $localize`:Avatar tooltip; the time is relative, e.g. "5 minutes ago":${name}:name: · Last online ${lastOnline}:lastOnline:`
      : name;
  });
  private readonly tooltipLastOnlineAt = computed(() => this.liveLastOnlineAt() ?? this.lastOnlineAt() ?? null);
  private readonly liveLastOnlineAt = computed(() => {
    if (!this.shouldCheckPresence()) return null;
    return this.presence.lastOnlineAt(this.workspaceId(), this.userId());
  });
  private readonly shouldCheckPresence = computed(() => Boolean(this.showPresence() && this.userId() && this.workspaceId()));

  protected readonly profileAriaLabel = computed(() => $localize`:Accessible label for an avatar that opens a profile card:View profile of ${this.name()}:name:`);
  protected readonly profileEnabled = computed(() => this.profile() && Boolean(this.userId()));
  protected readonly profileOpen = computed(() => {
    if (!this.profileEnabled()) return false;
    return this.profileCards.current()?.anchor === this.hostRef.nativeElement;
  });

  protected onProfileClick(event: Event) {
    if (!this.profileEnabled()) return;
    // The avatar usually sits inside something with its own click (a card tile opens the card, a
    // comment row selects it); the profile is the more specific intent, so it wins.
    event.preventDefault();
    event.stopPropagation();
    this.profileCards.toggle(this.hostRef.nativeElement, {
      userId: this.userId()!,
      workspaceId: this.workspaceId(),
      displayName: this.name(),
      avatarUrl: this.visibleUrl(),
      lastOnlineAt: this.lastOnlineAt() ?? null,
      actions: this.profileActions() ?? undefined,
    });
  }

  protected markImageFailed() {
    this.failedUrl.set(this.url());
  }
}

export function formatLastOnline(value: string | Date | null | undefined, now: number): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  if (Number.isNaN(timestamp)) return null;

  const seconds = Math.round((timestamp - now) / 1000);
  const absSeconds = Math.abs(seconds);
  if (absSeconds < 60) return $localize`:Relative time for under a minute, read after "Last online":less than a minute ago`;
  const units: { unit: Intl.RelativeTimeFormatUnit; seconds: number }[] = [
    { unit: "year", seconds: 31_536_000 },
    { unit: "month", seconds: 2_592_000 },
    { unit: "day", seconds: 86_400 },
    { unit: "hour", seconds: 3_600 },
    { unit: "minute", seconds: 60 },
  ];
  const formatter = new Intl.RelativeTimeFormat(appLocale(), { numeric: "auto" });
  for (const { unit, seconds: unitSeconds } of units) {
    if (absSeconds >= unitSeconds) return formatter.format(Math.round(seconds / unitSeconds), unit);
  }
  return formatter.format(seconds, "second");
}
