import { DOCUMENT } from "@angular/common";
import { Injectable, effect, inject, signal } from "@angular/core";
import { Title } from "@angular/platform-browser";
import type { RouterStateSnapshot} from "@angular/router";
import { TitleStrategy } from "@angular/router";
import { NotificationsService } from "../notifications/notifications.service";

type TitlePart = string | null | undefined | false;

interface FaviconAttributes {
  element: HTMLLinkElement;
  href: string | null;
  type: string | null;
  sizes: string | null;
}

@Injectable({ providedIn: "root" })
export class AppTitleService {
  private readonly document = inject(DOCUMENT);
  private readonly title = inject(Title);
  private readonly notifications = inject(NotificationsService);
  private readonly appName = "Kanera";
  private readonly parts = signal<TitlePart[]>([]);
  private faviconAttributes: FaviconAttributes[] | null = null;
  private unreadFaviconVisible = false;

  constructor() {
    effect(() => {
      const unreadCount = this.notifications.unreadCount();
      const baseTitle = this.compose(...this.parts());
      const prefix = unreadCount > 0 ? `(${unreadCount}) ` : "";
      this.title.setTitle(`${prefix}${baseTitle}`);
      this.setUnreadFavicon(unreadCount > 0);
    });
  }

  private setUnreadFavicon(visible: boolean): void {
    if (visible === this.unreadFaviconVisible) return;
    this.unreadFaviconVisible = visible;

    // Browsers choose between the declared icon sizes independently. Swap every standard favicon
    // declaration together so the unread state is consistent whichever one the current browser uses.
    this.faviconAttributes ??= Array.from(
      this.document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'),
      (element) => ({
        element,
        href: element.getAttribute("href"),
        type: element.getAttribute("type"),
        sizes: element.getAttribute("sizes"),
      }),
    );

    for (const attributes of this.faviconAttributes) {
      if (visible) {
        attributes.element.setAttribute("href", "/assets/favicon/favicon-unread.svg");
        attributes.element.setAttribute("type", "image/svg+xml");
        attributes.element.removeAttribute("sizes");
      } else {
        this.restoreAttribute(attributes.element, "href", attributes.href);
        this.restoreAttribute(attributes.element, "type", attributes.type);
        this.restoreAttribute(attributes.element, "sizes", attributes.sizes);
      }
    }
  }

  private restoreAttribute(element: HTMLLinkElement, name: string, value: string | null): void {
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  }

  compose(...parts: TitlePart[]) {
    const cleaned = parts
      .flatMap((part) => (typeof part === "string" ? [part.trim()] : []))
      .filter(Boolean);

    return cleaned.length > 0 ? `${cleaned.join(" · ")} · ${this.appName}` : this.appName;
  }

  set(...parts: TitlePart[]) {
    this.parts.set(parts);
  }
}

@Injectable()
export class AppTitleStrategy extends TitleStrategy {
  private readonly appTitle = inject(AppTitleService);

  override updateTitle(snapshot: RouterStateSnapshot) {
    this.appTitle.set(this.buildTitle(snapshot));
  }
}
