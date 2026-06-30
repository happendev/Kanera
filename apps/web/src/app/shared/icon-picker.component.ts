import type {
  ElementRef} from "@angular/core";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  HostListener,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from "@angular/core";
import { DecimalPipe } from "@angular/common";
import type { ColorToken } from "@kanera/shared/colors";
import { PickerStateService } from "./picker-state.service";
import { TooltipDirective } from "./tooltip.directive";

const POPULAR_ICONS = [
  "rocket", "briefcase", "briefcase-2", "building", "building-community", "buildings",
  "home", "folder", "folders", "layout-dashboard", "dashboard", "users",
  "users-group", "clipboard-list", "checklist", "calendar", "calendar-event", "target",
  "flag", "chart-bar", "chart-donut", "chart-pie", "bulb", "globe",
  "map", "compass", "code", "database", "package", "notebook",
  "shield", "crown",
];

@Component({
  selector: "k-icon-picker",
  standalone: true,
  imports: [DecimalPipe, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ip-wrapper">
      <button type="button" class="ip-trigger" [kTooltip]="title()" [disabled]="disabled()" (click)="toggle($event)">
        <i class="ti ti-{{ value() }}" [style.color]="color() ? 'var(--color-' + color() + ')' : null"></i>
      </button>

      @if (open()) {
        <div class="ip-dropdown" (click)="$event.stopPropagation()">
          <div class="ip-search">
            <i class="ti ti-search"></i>
            <input
              #searchInput
              placeholder="Search icons…"
              [value]="search()"
              (input)="search.set($any($event.target).value)"
            />
          </div>
          @if (!search()) {
            <div class="ip-section-label">
              <span>Popular</span>
              <span class="ip-section-hint">
                @if (totalCount() > 0) {
                  search to browse all {{ totalCount() | number }} icons
                } @else {
                  loading icon list
                }
              </span>
            </div>
          }
          <div class="ip-grid">
            @for (icon of displayed(); track icon) {
              <button
                type="button"
                class="ip-icon"
                [class.is-selected]="icon === value()"
                [kTooltip]="icon"
                (click)="select(icon)"
              >
                <i class="ti ti-{{ icon }}"></i>
              </button>
            }
            @if (displayed().length === 0) {
              <div class="ip-empty">No icons found</div>
            }
          </div>
        </div>
      }
    </div>
  `,
  styles: `
    .ip-wrapper {
      position: relative;
    }

    .ip-trigger {
      width: 36px;
      height: 36px;
      padding: 0;
      border-radius: var(--radius);
      background: var(--surface-2);
      border: 1px solid var(--border-strong);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      flex-shrink: 0;

      i {
        font-size: 18px;
        color: var(--accent);
      }

      &:hover {
        border-color: var(--accent);
        background: var(--surface-hover);
      }

      &:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }
    }

    .ip-dropdown {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      z-index: 100;
      width: 320px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-sm);
      overflow: hidden;
    }

    .ip-search {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);

      i {
        font-size: 15px;
        color: var(--text-muted);
        flex-shrink: 0;
      }

      input {
        border: none;
        background: transparent;
        font-size: 13px;
        color: var(--text);
        width: 100%;
        height: auto;
        padding: 0;

        &:focus {
          outline: none;
          box-shadow: none;
        }
      }
    }

    .ip-section-label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px 0;
      font-size: 11px;
      font-weight: 500;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .ip-section-hint {
      font-weight: 400;
      text-transform: none;
      letter-spacing: 0;
    }

    .ip-grid {
      display: grid;
      grid-template-columns: repeat(8, 1fr);
      gap: 2px;
      padding: 8px;
      max-height: 240px;
      overflow-y: auto;
      overscroll-behavior: contain;
    }

    .ip-icon {
      width: 34px;
      height: 34px;
      padding: 0;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;

      i { font-size: 18px; }

      &:hover {
        background: var(--surface-2);
        color: var(--text);
      }

      &.is-selected {
        background: var(--accent);
        color: var(--accent-fg);
        border-color: var(--accent);
      }
    }

    .ip-empty {
      grid-column: 1 / -1;
      text-align: center;
      font-size: 12px;
      color: var(--text-muted);
      padding: 16px 0;
    }
  `,
})
export class IconPickerComponent {
  private readonly pickerState = inject(PickerStateService);
  private readonly id = crypto.randomUUID();

  readonly value = input.required<string>();
  readonly disabled = input(false);
  readonly disabledTitle = input<string | null>(null);
  // optional palette token used only to tint the displayed icon; null leaves the default color
  readonly color = input<ColorToken | null>(null);
  readonly valueChange = output<string>();

  readonly open = signal(false);
  readonly search = signal("");
  readonly icons = signal<readonly string[]>([]);

  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>("searchInput");
  private iconLoadPromise: Promise<void> | null = null;

  readonly totalCount = computed(() => this.icons().length);
  readonly title = computed(() => this.disabledTitle() ?? `Icon: ${this.value()}`);

  readonly displayed = computed(() => {
    const q = this.search().toLowerCase().trim();
    if (!q) return POPULAR_ICONS;
    return this.icons().filter((n) => n.includes(q)).slice(0, 100);
  });

  constructor() {
    effect(() => {
      if (this.pickerState.activeId() !== this.id) {
        this.open.set(false);
      }
    });
  }

  toggle(event: Event) {
    event.stopPropagation();
    if (this.disabled()) return;
    const willOpen = !this.open();
    this.open.set(willOpen);
    if (willOpen) {
      this.pickerState.open(this.id);
      this.search.set("");
      void this.loadIcons();
      setTimeout(() => this.searchInput()?.nativeElement.focus(), 0);
    }
  }

  select(icon: string) {
    if (this.disabled()) return;
    this.valueChange.emit(icon);
    this.open.set(false);
  }

  @HostListener("document:click")
  onDocumentClick() {
    if (this.open()) this.open.set(false);
  }

  private loadIcons() {
    if (this.icons().length > 0) return Promise.resolve();

    this.iconLoadPromise ??= import("./tabler-icons").then(({ TABLER_ICONS }) => {
      this.icons.set(TABLER_ICONS);
    });

    return this.iconLoadPromise;
  }
}
