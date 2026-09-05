import { ChangeDetectionStrategy, Component, computed, inject, output } from "@angular/core";
import { A11yModule } from "@angular/cdk/a11y";
import { KeyboardShortcutsService, formatShortcut } from "../core/keyboard/keyboard-shortcuts.service";

interface ShortcutRow {
  /** One inner array per press; a sequence such as `g h` has two. */
  keys: string[][];
  label: string;
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
  imports: [A11yModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ks-backdrop" (click)="closed.emit()" aria-hidden="true"></div>
    <div class="ks-sheet" role="dialog" aria-modal="true" aria-labelledby="ks-title" cdkTrapFocus [cdkTrapFocusAutoCapture]="true">
      <header class="ks-header">
        <h2 id="ks-title">Keyboard shortcuts</h2>
        <button type="button" class="ghost icon" (click)="closed.emit()" aria-label="Close" cdkFocusInitial>
          <i class="ti ti-x"></i>
        </button>
      </header>
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
      width: min(560px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
      overflow: auto;
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
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-4) var(--space-5) var(--space-3);
      border-bottom: 1px solid var(--border);

      h2 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: 600;
        letter-spacing: var(--tracking-tight);
      }
    }

    .ks-groups {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: var(--space-5) var(--space-6);
      padding: var(--space-4) var(--space-5) var(--space-5);
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
      font-size: var(--text-base);
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
  `,
})
export class ShortcutsSheetComponent {
  private readonly shortcuts = inject(KeyboardShortcutsService);
  readonly closed = output<void>();

  readonly groups = computed<ShortcutGroup[]>(() => {
    const groups = new Map<string, ShortcutRow[]>();
    for (const binding of this.shortcuts.bindings()) {
      if (binding.when && !binding.when()) continue;
      const rows = groups.get(binding.group) ?? [];
      // Newest registration wins at dispatch, so it also wins the row in the sheet.
      const existing = rows.findIndex((row) => row.label === binding.label);
      const row = { keys: formatShortcut(binding.keys), label: binding.label };
      if (existing >= 0) rows[existing] = row;
      else rows.push(row);
      groups.set(binding.group, rows);
    }
    return [...groups.entries()].map(([title, rows]) => ({ title, rows }));
  });
}
