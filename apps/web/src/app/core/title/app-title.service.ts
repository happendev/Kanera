import { Injectable, effect, inject, signal } from "@angular/core";
import { Title } from "@angular/platform-browser";
import type { RouterStateSnapshot} from "@angular/router";
import { TitleStrategy } from "@angular/router";
import { NotificationsService } from "../notifications/notifications.service";

type TitlePart = string | null | undefined | false;

@Injectable({ providedIn: "root" })
export class AppTitleService {
  private readonly title = inject(Title);
  private readonly notifications = inject(NotificationsService);
  private readonly appName = "Kanera";
  private readonly parts = signal<TitlePart[]>([]);

  constructor() {
    effect(() => {
      const unreadCount = this.notifications.unreadCount();
      const baseTitle = this.compose(...this.parts());
      const prefix = unreadCount > 0 ? `(${unreadCount}) ` : "";
      this.title.setTitle(`${prefix}${baseTitle}`);
    });
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