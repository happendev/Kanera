import { ChangeDetectionStrategy, Component, computed, inject, output } from "@angular/core";
import { ANCHORED_PANEL_STYLES, ANCHORED_SHEET_STYLES } from "../../../shared/anchored-panel";
import { AnchoredPanelDirective } from "../../../shared/anchored-panel.directive";
import { WorkspaceSettingsPage } from "../workspace-settings.page";

/**
 * The Examples menu for automations, anchored to the toolbar button.
 *
 * Automations used to teach themselves only from the empty state, which meant the examples vanished
 * the moment the workspace had one rule — exactly when an admin starts wondering what else is
 * possible. Living in the toolbar keeps the catalogue reachable for the life of the workspace, and
 * lets the empty state shrink to a single sentence.
 *
 * Picking one creates it disabled and expanded, so the admin lands on a real, editable rule.
 */
@Component({
  selector: "k-automation-examples",
  standalone: true,
  hostDirectives: [AnchoredPanelDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ap-panel">
      <div class="ap-head">
        <span class="ap-title">Example automations</span>
        <button type="button" class="ap-icon-button" aria-label="Close" (click)="closed.emit()">
          <i class="ti ti-x"></i>
        </button>
      </div>

      <div class="ae-body">
        @for (group of groups(); track group.name) {
          <section class="ae-group">
            <h4 class="ae-group-name">{{ group.name }}</h4>
            @for (recipe of group.recipes; track recipe.id) {
              <!-- aria-disabled rather than disabled: the global button reset sets
                   pointer-events:none on :disabled, which would also swallow the click that a
                   screen-reader user needs to hear nothing happen from — and the requirement line
                   already carries the explanation on screen. pick() re-checks availability. -->
              <button
                type="button"
                class="ae-recipe"
                [class.is-unavailable]="!recipe.available"
                [attr.aria-disabled]="recipe.available ? null : true"
                (click)="pick(recipe.id, recipe.available)"
              >
                <i class="ti {{ recipe.icon }} ae-recipe-icon"></i>
                <span class="ae-recipe-text">
                  <strong>{{ recipe.title }}</strong>
                  <small>{{ recipe.detail }}</small>
                  @if (!recipe.available) {
                    <em class="ae-recipe-blocked"><i class="ti ti-plus"></i> {{ recipe.requirement }}</em>
                  }
                </span>
                @if (recipe.available) {
                  <i class="ti ti-arrow-right ae-recipe-go"></i>
                }
              </button>
            }
          </section>
        }
      </div>

      <p class="ae-foot">Examples are created switched off, so you can adjust one before it runs.</p>
    </div>
  `,
  styles: [
    ANCHORED_PANEL_STYLES,
    ANCHORED_SHEET_STYLES,
    `
      .ae-body {
        display: grid;
        gap: 12px;
        overflow-y: auto;
      }

      .ae-group {
        display: grid;
        gap: 4px;
        min-width: 0;
      }

      .ae-group-name {
        margin: 0 0 2px;
        color: var(--text-muted);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      .ae-recipe {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: start;
        gap: 9px;
        height: auto;
        padding: 8px 9px;
        color: var(--text);
        background: transparent;
        border: 1px solid transparent;
        border-radius: var(--radius-sm);
        cursor: pointer;
        text-align: left;
        /* Undo the global button reset: these rows carry a wrapping sentence. */
        white-space: normal;
        line-height: 1.4;

        &:hover {
          background: var(--surface-2);
          border-color: var(--border);
        }

        &.is-unavailable {
          cursor: default;

          &:hover { background: transparent; border-color: transparent; }

          .ae-recipe-icon,
          strong { color: var(--text-muted); }
        }
      }

      .ae-recipe-icon {
        margin-top: 1px;
        color: var(--accent);
        font-size: 17px;
      }

      .ae-recipe-text {
        display: grid;
        gap: 2px;
        min-width: 0;
      }

      .ae-recipe strong {
        font-size: 13px;
        font-weight: 600;
      }

      .ae-recipe small {
        color: var(--text-muted);
        font-size: 12px;
        line-height: 1.4;
      }

      .ae-recipe-blocked {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        color: var(--warning);
        font-size: 11px;
        font-style: normal;

        i { font-size: 12px; }
      }

      .ae-recipe-go {
        margin-top: 2px;
        color: var(--text-muted);
        font-size: 14px;
      }

      .ae-foot {
        margin: 0;
        padding-top: 8px;
        border-top: 1px solid var(--border);
        color: var(--text-muted);
        font-size: 11px;
        line-height: 1.45;
      }
    `,
  ],
})
export class AutomationExamplesPopover {
  private readonly panel = inject(AnchoredPanelDirective);
  // Route-scoped page state, the same instance the automations tab edits.
  protected readonly settings = inject(WorkspaceSettingsPage);

  readonly closed = output<void>();

  constructor() {
    this.panel.configure({
      placement: () => ({ align: "end", width: 380, maxHeight: 480 }),
      onDismiss: () => this.closed.emit(),
    });
  }

  /** Only groups with at least one recipe, so the catalogue can shrink without leaving empty headings. */
  protected readonly groups = computed(() => {
    const recipes = this.settings.automationRecipes();
    return this.settings.automationRecipeGroups
      .map((name) => ({ name, recipes: recipes.filter((recipe) => recipe.group === name) }))
      .filter((group) => group.recipes.length > 0);
  });

  protected async pick(id: string, available: boolean): Promise<void> {
    if (!available) return;
    this.closed.emit();
    await this.settings.applyAutomationRecipe(id);
  }
}
