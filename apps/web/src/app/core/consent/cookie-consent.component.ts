import type { ElementRef } from "@angular/core";
import { ChangeDetectionStrategy, Component, effect, inject, signal, viewChild } from "@angular/core";
import { CookieConsentService } from "./cookie-consent.service";

@Component({
  selector: "k-cookie-consent",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./cookie-consent.component.html",
  styleUrl: "./cookie-consent.component.scss",
})
export class CookieConsentComponent {
  readonly consent = inject(CookieConsentService);
  readonly preferencesOpen = signal(false);
  readonly analytics = signal(false);
  private readonly dialog = viewChild<ElementRef<HTMLElement>>("dialog");
  private previouslyFocused: HTMLElement | null = null;

  constructor() {
    let handledRequest = this.consent.settingsRequest();
    effect(() => {
      const request = this.consent.settingsRequest();
      if (request === handledRequest) return;
      handledRequest = request;
      this.openPreferences();
    });
  }

  openPreferences(): void {
    this.analytics.set(this.consent.choice()?.analytics ?? false);
    this.previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.preferencesOpen.set(true);
    queueMicrotask(() => this.dialog()?.nativeElement.querySelector<HTMLElement>("button, input, a")?.focus());
  }

  closePreferences(): void {
    this.preferencesOpen.set(false);
    this.previouslyFocused?.focus();
    this.previouslyFocused = null;
  }

  save(analytics: boolean): void {
    this.consent.save(analytics);
    this.closePreferences();
  }

  onDialogKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      this.closePreferences();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [...(this.dialog()?.nativeElement.querySelectorAll<HTMLElement>("button, input, a") ?? [])]
      .filter((control) => !control.hasAttribute("disabled"));
    if (controls.length === 0) return;
    const first = controls[0]!;
    const last = controls.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
