import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from "@angular/core";
import { CdkTrapFocus } from "@angular/cdk/a11y";
import { KeyboardShortcutsService, formatShortcut } from "../core/keyboard/keyboard-shortcuts.service";

interface ShortcutRow {
  /** One inner array per press; a sequence such as `g h` has two. */
  keys: string[][];
  label: string;
  searchText: string;
}

interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

/**
 * The keyboard cheat sheet, opened with `?` anywhere outside a text field or from the account menu.
 * Rendered from KeyboardShortcutsService's live registry, so it lists exactly the shortcuts that
 * work on the current screen: page-level bindings appear only while that page is mounted.
 */
@Component({
  selector: "k-shortcuts-sheet",
  standalone: true,
  imports: [CdkTrapFocus],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ks-backdrop" (click)="closed.emit()" aria-hidden="true"></div>
    <div class="ks-sheet" role="dialog" aria-modal="true" aria-labelledby="ks-title" cdkTrapFocus [cdkTrapFocusAutoCapture]="true" (keydown.escape)="$event.preventDefault(); closed.emit()">
      <header class="ks-header">
        <h2 id="ks-title">Keyboard shortcuts</h2>
        <label class="ks-search">
          <i class="ti ti-search" aria-hidden="true"></i>
          <input
            type="search"
            placeholder="Search shortcuts"
            aria-label="Search keyboard shortcuts"
            aria-controls="ks-results"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
            cdkFocusInitial
          />
          @if (query()) {
            <button type="button" class="ks-search-clear" (click)="query.set('')" aria-label="Clear search">
              <i class="ti ti-x" aria-hidden="true"></i>
            </button>
          }
        </label>
        <button type="button" class="ghost icon ks-close" (click)="closed.emit()" aria-label="Close">
          <i class="ti ti-x"></i>
        </button>
      </header>
      <div id="ks-results" class="ks-results">
        @if (groups().length) {
          <div class="ks-groups">
            @for (group of groups(); track group.title) {
              <section class="ks-group">
                <h3>{{ group.title }}</h3>
                @for (row of group.rows; track row.label) {
                  <div class="ks-row">
                    <span class="ks-label">{{ row.label }}</span>
                    <span class="ks-keys">
                      @for (press of row.keys; track $index) {
                        @if (!$first) { <span class="ks-then">then</span> }
                        @for (key of press; track $index) {
                          <kbd class="k-kbd">{{ key }}</kbd>
                        }
                      }
                    </span>
                  </div>
                }
              </section>
            }
          </div>
        } @else {
          <div class="ks-empty" role="status">
            <i class="ti ti-search-off" aria-hidden="true"></i>
            <p>No shortcuts match “{{ query().trim() }}”</p>
            <button type="button" class="secondary" (click)="query.set('')">Clear search</button>
          </div>
        }
      </div>
      <span class="ks-result-count" aria-live="polite">
        @if (query().trim()) {
          {{ resultCount() }} {{ resultCount() === 1 ? 'shortcut' : 'shortcuts' }} found
        }
      </span>
    </div>
  `,
  styles: `
    .ks-backdrop {
      position: fixed;
      inset: 0;
      z-index: var(--z-modal);
      background: rgba(0, 0, 0, 0.4);
    }

    .ks-sheet {
      position: fixed;
      z-index: var(--z-modal);
      top: 50%;
      left: 50%;
      display: flex;
      flex-direction: column;
      width: min(920px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
      overflow: hidden;
      transform: translate(-50%, -50%);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-lg);
      animation: ks-in var(--motion-base) var(--ease-out);
    }

    @keyframes ks-in {
      from { opacity: 0; transform: translate(-50%, calc(-50% + 6px)); }
      to { opacity: 1; transform: translate(-50%, -50%); }
    }

    .ks-header {
      display: grid;
      grid-template-columns: minmax(max-content, 1fr) minmax(260px, 360px) auto;
      align-items: center;
      gap: var(--space-4);
      flex: none;
      padding: var(--space-4) var(--space-5);
      border-bottom: 1px solid var(--border);

      h2 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: 600;
        letter-spacing: var(--tracking-tight);
      }
    }

    .ks-search {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      height: 36px;
      padding: 0 4px 0 10px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      transition: border-color 0.12s, box-shadow 0.12s;
    }

    .ks-search:focus-within {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--ring);
    }

    .ks-search > i {
      flex: none;
      color: var(--text-muted);
      font-size: 15px;
    }

    :host .ks-search input {
      flex: 1;
      min-width: 0;
      height: 100%;
      padding: 0;
      color: var(--text);
      background: transparent;
      border: 0;
      border-radius: 0;
      outline: 0;
      box-shadow: none;
      font: inherit;
      font-size: var(--text-sm);
    }

    :host .ks-search input:focus {
      border-color: transparent;
      box-shadow: none;
    }

    :host .ks-search input::-webkit-search-cancel-button {
      appearance: none;
    }

    .ks-search-clear {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: none;
      width: 26px;
      height: 26px;
      padding: 0;
      color: var(--text-muted);
      background: transparent;
      border: 0;
      border-radius: var(--radius-sm);
      cursor: pointer;
    }

    .ks-search-clear:hover {
      color: var(--text);
      background: var(--surface-3);
    }

    .ks-result-count {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
    }

    .ks-results {
      min-height: 0;
      overflow: auto;
    }

    .ks-groups {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      align-items: start;
      gap: var(--space-4);
      padding: var(--space-4) var(--space-5) var(--space-5);
    }

    .ks-group {
      min-width: 0;
      padding: var(--space-3);
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
    }

    .ks-group h3 {
      margin: 0 0 var(--space-2);
      color: var(--text-muted);
      font-size: var(--text-sm);
      font-weight: 600;
    }

    .ks-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      min-height: 30px;
      font-size: var(--text-sm);
    }

    .ks-label {
      color: var(--text);
    }

    .ks-keys {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      flex: none;
    }

    .ks-then {
      margin: 0 3px;
      color: var(--text-muted);
      font-size: var(--text-xs);
    }

    .ks-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 260px;
      padding: var(--space-8) var(--space-5);
      color: var(--text-muted);
      text-align: center;
    }

    .ks-empty > i {
      margin-bottom: var(--space-2);
      font-size: 26px;
    }

    .ks-empty p {
      margin: 0 0 var(--space-4);
    }

    @media (max-width: 640px) {
      .ks-header {
        grid-template-columns: minmax(0, 1fr) auto;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
      }

      .ks-search {
        grid-column: 1 / -1;
        grid-row: 2;
      }

      .ks-close {
        grid-column: 2;
        grid-row: 1;
      }

      .ks-groups {
        grid-template-columns: 1fr;
        padding: var(--space-3) var(--space-4) var(--space-4);
      }
    }
  `,
})
export class ShortcutsSheetComponent {
  private readonly shortcuts = inject(KeyboardShortcutsService);
  readonly closed = output<void>();
  readonly query = signal("");

  readonly groups = computed<ShortcutGroup[]>(() => {
    const allGroups = new Map<string, ShortcutRow[]>();
    for (const binding of this.shortcuts.bindings()) {
      if (binding.when && !binding.when()) continue;
      const rows = allGroups.get(binding.group) ?? [];
      // Newest registration wins at dispatch, so it also wins the row in the sheet.
      const existing = rows.findIndex((row) => row.label === binding.label);
      const keys = formatShortcut(binding.keys);
      const row = {
        keys,
        label: binding.label,
        searchText: `${binding.label} ${binding.keys} ${keys.flat().join(" ")}`.toLocaleLowerCase(),
      };
      if (existing >= 0) rows[existing] = row;
      else rows.push(row);
      allGroups.set(binding.group, rows);
    }

    const query = this.query().trim().toLocaleLowerCase();
    return [...allGroups.entries()].flatMap(([title, rows]) => {
      if (!query || title.toLocaleLowerCase().includes(query)) return [{ title, rows }];
      const matchingRows = rows.filter((row) => row.searchText.includes(query));
      return matchingRows.length ? [{ title, rows: matchingRows }] : [];
    });
  });

  readonly resultCount = computed(() => this.groups().reduce((count, group) => count + group.rows.length, 0));
}
