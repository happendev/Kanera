import { ChangeDetectionStrategy, Component, inject, input } from "@angular/core";
import { ThemeService } from "../core/theme/theme.service";

const DARK_LONG = "/assets/logo/Kanera%20dark%20long.svg";
const LIGHT_LONG = "/assets/logo/Kanera%20light%20long.svg";
const DARK_ICON = "/assets/logo/kanera%20icon%20dark.svg";
const LIGHT_ICON = "/assets/logo/kanera%20icon%20light.svg";

@Component({
  selector: "k-logo",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <img
      [src]="src()"
      alt="Kanera"
      [height]="height()"
    />
  `,
  styles: [`:host { display: contents; } img { display: block; }`],
})
export class LogoComponent {
  private readonly theme = inject(ThemeService);

  readonly variant = input<"icon" | "long">("long");
  readonly height = input<number>(32);

  protected src() {
    // Family, not exact value: carbon is dark and must not fall through to the light logo.
    const dark = this.theme.isDark();
    return this.variant() === "icon"
      ? (dark ? DARK_ICON : LIGHT_ICON)
      : (dark ? DARK_LONG : LIGHT_LONG);
  }
}
