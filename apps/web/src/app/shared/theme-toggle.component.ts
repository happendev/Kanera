import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ThemeService } from "../core/theme/theme.service";
import { TooltipDirective } from "./tooltip.directive";

@Component({
  selector: "k-theme-toggle",
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button class="icon-btn" (click)="theme.toggle()" [kTooltip]="theme.theme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'">
      <i [class]="theme.theme() === 'dark' ? 'ti ti-sun' : 'ti ti-moon'"></i>
    </button>
  `,
  styles: [`
    .icon-btn {
      background: none;
      border: none;
      cursor: pointer;
      padding: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted, var(--text));
      border-radius: 6px;
      font-size: 20px;
      line-height: 1;
      transition: color 0.15s, background 0.15s;
    }
    .icon-btn:hover {
      color: var(--text);
      background: var(--surface-subtle);
    }
  `],
})
export class ThemeToggleComponent {
  protected readonly theme = inject(ThemeService);
}
