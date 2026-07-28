import { ChangeDetectionStrategy, Component, inject, input, output } from "@angular/core";
import { ANCHORED_PANEL_STYLES, ANCHORED_SHEET_STYLES } from "./anchored-panel";
import { AnchoredPanelDirective } from "./anchored-panel.directive";
import { PickerListComponent, type PickerGroup } from "./picker-list.component";

/**
 * Drop-in replacement for a native `<select>`: a popover anchored to its trigger that renders the
 * shared grouped picker list. Mount it as the trigger button's sibling — placement resolves against
 * the host's parent element, the way the board's other popovers do.
 */
@Component({
  selector: "k-anchored-picker",
  standalone: true,
  imports: [PickerListComponent],
  hostDirectives: [AnchoredPanelDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ap-panel">
      <div class="ap-head">
        <span class="ap-title">{{ title() }}</span>
        <button type="button" class="ap-icon-button" aria-label="Close" (click)="closed.emit()">
          <i class="ti ti-x"></i>
        </button>
      </div>
      <k-picker-list
        [groups]="groups()"
        [selectedIds]="selectedId() ? [selectedId()!] : []"
        [searchPlaceholder]="searchPlaceholder()"
        [searchThreshold]="searchThreshold()"
        [emptyLabel]="emptyLabel()"
        (pick)="picked.emit($event)"
      />
    </div>
  `,
  styles: [ANCHORED_PANEL_STYLES, ANCHORED_SHEET_STYLES, `k-picker-list { min-height: 0; }`],
})
export class AnchoredPickerPopover {
  private readonly panel = inject(AnchoredPanelDirective);

  readonly title = input("Choose");
  readonly groups = input<PickerGroup[]>([]);
  readonly selectedId = input<string | null>(null);
  readonly searchPlaceholder = input("Search…");
  readonly searchThreshold = input(8);
  readonly emptyLabel = input("Nothing to show");
  readonly align = input<"start" | "end">("start");
  readonly width = input(288);

  readonly picked = output<string>();
  readonly closed = output<void>();

  constructor() {
    this.panel.configure({
      placement: () => ({ align: this.align(), width: this.width() }),
      onDismiss: () => this.closed.emit(),
    });
  }
}
