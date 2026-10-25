import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import { documentThemeIsDark } from "./avatar.component";

const DARK_ICON = "/assets/logo/kanera%20icon%20dark.svg";
const LIGHT_ICON = "/assets/logo/kanera%20icon%20light.svg";
/** The logo mark is 278 x 200, so it sits wider than tall inside the square avatar slot. */
const ICON_ASPECT = 200 / 278;

/**
 * Stands in for a person's avatar when Kanera itself is the actor (time-in-progress alerts,
 * automations, schedule conflicts). It is the logo mark itself, with no tile or ring, so system rows
 * read as product messages rather than as a teammate called "Kanera".
 */
@Component({
  selector: "k-system-avatar",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "[style.width.px]": "size()",
    "[style.height.px]": "size()",
  },
  template: `<img [src]="src()" alt="Kanera" [width]="iconWidth()" [height]="iconHeight()" />`,
  styles: [`
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      line-height: 1;
    }

    img { display: block; }
  `],
})
export class SystemAvatarComponent {
  readonly size = input<number>(32);

  /* Slightly inset from the slot so the mark's visual weight matches a round photo avatar. */
  protected readonly iconWidth = computed(() => Math.round(this.size() * 0.85));
  protected readonly iconHeight = computed(() => Math.round(this.iconWidth() * ICON_ASPECT));
  protected readonly src = computed(() => (documentThemeIsDark() ? DARK_ICON : LIGHT_ICON));
}
