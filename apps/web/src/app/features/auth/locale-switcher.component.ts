import { ChangeDetectionStrategy, Component } from "@angular/core";
import type { Locale } from "@kanera/shared/locales";
import { appLocale, applyLocale } from "../../core/i18n/locale";
import { LanguageMenuComponent } from "../../shared/language-menu.component";

/**
 * Language picker for the signed-out pages (login, signup, password reset), so a visitor can read
 * Kanera in their language before they have an account. The choice is kept on this device and
 * reloads the page; signup then sends it so the new account and its first emails start in it.
 * Signed-in people change language from Settings → Profile, which also saves it to the account.
 */
@Component({
  selector: "k-locale-switcher",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LanguageMenuComponent],
  template: `<k-language-menu variant="ghost" [value]="current" (picked)="select($event)" />`,
  styles: [`:host { display: flex; justify-content: center; }`],
})
export class LocaleSwitcherComponent {
  protected readonly current = appLocale();

  protected select(locale: Locale): void {
    applyLocale(locale);
  }
}
