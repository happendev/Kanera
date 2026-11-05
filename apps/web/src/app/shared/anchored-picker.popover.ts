import { ChangeDetectionStrategy, Component, computed, inject, input, output } from "@angular/core";
import { ANCHORED_PANEL_STYLES } from "./anchored-panel";
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
      <div class="ap-head" [class.is-plain]="hasSearch()">
        <span class="ap-title">{{ title() }}</span>
        <button type="button" class="ap-icon-button" aria-label="Close" i18n-aria-label (click)="closed.emit()">
          <i aria-hidden="true" class="ti ti-x"></i>
        </button>
      </div>
      <k-picker-list
        [groups]="groups()"
        [selectedIds]="selectedIds()"
        [searchPlaceholder]="searchPlaceholder()"
        [searchThreshold]="searchThreshold()"
        [emptyLabel]="emptyLabel()"
        (pick)="picked.emit($event)"
      />
    </div>
  `,
  styles: [
    ANCHORED_PANEL_STYLES,
    `
    k-picker-list {
      min-height: 0;
      /* Search sits a step in from the rows, level with the title. */
      --pl-search-inset: 4px;
    }

    /* The .k-menu inset: rows reach to 4px from the edge, so a picker's highlight lines up with a
       menu's when the two are open side by side. The title keeps its own inset to align with the
       row text. */
    .ap-panel { padding: 4px; }
    .ap-head { padding: 4px 4px 6px 8px; }
    .ap-head.is-plain { padding-bottom: 0; }

    @media (hover: none), (pointer: coarse), (any-pointer: coarse) {
      /* Keep the 44px close target inside the panel now that the head sits 4px from its edge. */
      .ap-head .ap-icon-button { margin-right: -4px; }
    }
    `,
  ],
})
export class AnchoredPickerPopover {
  private readonly panel = inject(AnchoredPanelDirective);

  readonly title = input($localize`:Default picker heading:Choose`);
  readonly groups = input<PickerGroup[]>([]);
  readonly selectedId = input<string | null>(null);
  readonly searchPlaceholder = input($localize`:Picker search placeholder:Search…`);
  readonly searchThreshold = input(8);
  readonly emptyLabel = input($localize`:Picker empty state:Nothing to show`);
  readonly align = input<"start" | "end">("start");
  readonly width = input(288);

  /**
   * Null means nothing is chosen. An empty string is a real id: the "All boards" and "All teammates"
   * rows use it, and a truthiness check left those defaults without their check.
   */
  protected readonly selectedIds = computed(() => {
    const id = this.selectedId();
    return id == null ? [] : [id];
  });

  /** Mirrors the list's own rule (PickerListComponent.showSearch) for when the search box renders. */
  protected readonly hasSearch = computed(() =>
    this.groups().reduce((total, group) => total + group.options.length, 0) >= this.searchThreshold()
  );

  readonly picked = output<string>();
  readonly closed = output<void>();

  constructor() {
    this.panel.configure({
      // 560, not the shared 420: scope and teammates lists were cut short with half the screen free
      // below them. Placement still clamps to the viewport on short screens.
      placement: () => ({ align: this.align(), width: this.width(), maxHeight: 560 }),
      onDismiss: () => this.closed.emit(),
    });
  }
}
