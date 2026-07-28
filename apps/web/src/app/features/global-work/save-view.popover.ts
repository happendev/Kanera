import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
} from "@angular/core";
import type { WorkViewVisibility } from "@kanera/shared/schema";
import {
  ANCHORED_PANEL_STYLES,
  ANCHORED_SHEET_STYLES,
  PANEL_INPUT_STYLES,
} from "../../shared/anchored-panel";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { AutofocusDirective } from "../../shared/autofocus.directive";
import { AvatarComponent } from "../../shared/avatar.component";
import { PickerListComponent } from "../../shared/picker-list.component";
import { GlobalWorkState } from "./global-work.state";

/**
 * Saved-view management for the global work pages, anchored to the "Save view" button.
 *
 * Two modes, driven by whether a saved view is currently applied: create a new view from the
 * current filters, or edit the applied one (visibility, sharing, delete). Sharing drills down
 * inside the panel rather than opening a nested popover, matching the create-card flow.
 */
@Component({
  selector: "k-save-view",
  standalone: true,
  imports: [AutofocusDirective, AvatarComponent, PickerListComponent],
  hostDirectives: [AnchoredPanelDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ap-panel">
      @if (view() === "share") {
        <div class="ap-head">
          <button type="button" class="ap-icon-button" aria-label="Back" (click)="view.set('main')">
            <i class="ti ti-chevron-left"></i>
          </button>
          <span class="ap-title">Share with</span>
        </div>
        <k-picker-list
          [groups]="shareGroups()"
          searchPlaceholder="Search colleagues…"
          emptyLabel="Everyone already has access"
          (pick)="addShare($event)"
        />
      } @else if (state.selectedView(); as selected) {
        <div class="ap-head">
          <span class="ap-title">{{ selected.name }}</span>
          <button type="button" class="ap-icon-button" aria-label="Close" (click)="closed.emit()">
            <i class="ti ti-x"></i>
          </button>
        </div>

        <div class="sv-body">
          @if (selected.editable) {
            <div class="sv-field">
              <span class="sv-label">Visibility</span>
              <div class="sv-segmented" role="group" aria-label="Visibility">
                @for (option of visibilityOptions; track option.value) {
                  <button
                    type="button"
                    [class.active]="selected.visibility === option.value"
                    [disabled]="!state.interactionReady()"
                    (click)="setVisibility(option.value)"
                  >
                    <i class="ti ti-{{ option.icon }}"></i>
                    {{ option.label }}
                  </button>
                }
              </div>
              <p class="sv-help">{{ visibilityHelp(selected.visibility) }}</p>
            </div>

            <div class="sv-field">
              <span class="sv-label">Shared with specific people</span>
              @if (selected.sharedUserIds.length) {
                <div class="sv-chips">
                  @for (userId of selected.sharedUserIds; track userId) {
                    <button
                      type="button"
                      class="sv-chip"
                      [disabled]="!state.interactionReady()"
                      (click)="state.removeShare(userId)"
                    >
                      @if (shareCandidatesById().get(userId); as person) {
                        <k-avatar [url]="person.avatarUrl" [name]="person.displayName" [size]="18" [userId]="userId" />
                        {{ person.displayName }}
                      } @else {
                        User no longer available
                      }
                      <i class="ti ti-x"></i>
                    </button>
                  }
                </div>
              }
              <button
                type="button"
                class="sv-add"
                [disabled]="!state.interactionReady() || shareCandidateCount() === 0"
                (click)="view.set('share')"
              >
                <i class="ti ti-user-plus"></i>
                Add a colleague
              </button>
            </div>

            <footer class="sv-actions">
              <button type="button" class="sv-delete" [disabled]="!state.interactionReady()" (click)="deleteView()">
                <i class="ti ti-trash"></i>
                Delete view
              </button>
              <button
                type="button"
                class="sv-save sv-update"
                [disabled]="state.saving() || !state.interactionReady()"
                (click)="saveCurrentView()"
              >
                <i class="ti ti-device-floppy"></i>
                Update view
              </button>
            </footer>
          } @else {
            <p class="sv-help">
              Shared by {{ selected.ownerName }}. Only the owner can change this view, and you’ll only
              see boards you can access.
            </p>
          }
        </div>
      } @else {
        <div class="ap-head">
          <span class="ap-title">Save this view</span>
          <button type="button" class="ap-icon-button" aria-label="Close" (click)="closed.emit()">
            <i class="ti ti-x"></i>
          </button>
        </div>

        <form class="sv-body" (submit)="saveNewView($event)">
          <div class="sv-field">
            <span class="sv-label">View name</span>
            <input
              autofocus
              class="ap-input"
              [value]="newViewName()"
              (input)="newViewName.set($any($event.target).value)"
              maxlength="120"
              placeholder="e.g. Launch risks"
            />
          </div>

          <div class="sv-field">
            <span class="sv-label">Visibility</span>
            <div class="sv-segmented" role="group" aria-label="Visibility">
              @for (option of visibilityOptions; track option.value) {
                <button
                  type="button"
                  [class.active]="newViewVisibility() === option.value"
                  (click)="newViewVisibility.set(option.value)"
                >
                  <i class="ti ti-{{ option.icon }}"></i>
                  {{ option.label }}
                </button>
              }
            </div>
            <p class="sv-help">{{ visibilityHelp(newViewVisibility()) }}</p>
          </div>

          <footer class="sv-actions sv-actions-end">
            <button type="button" class="sv-cancel" (click)="closed.emit()">Cancel</button>
            <button
              type="submit"
              class="sv-save"
              [disabled]="!newViewName().trim() || state.saving() || !state.interactionReady()"
            >
              Save view
            </button>
          </footer>
        </form>
      }
    </div>
  `,
  styles: [
    ANCHORED_PANEL_STYLES,
    ANCHORED_SHEET_STYLES,
    PANEL_INPUT_STYLES,
    `
      .sv-body {
        display: grid;
        gap: 14px;
        overflow-y: auto;
      }

      .sv-field { display: grid; gap: 6px; min-width: 0; }

      .sv-label {
        color: var(--text-muted);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      .sv-help {
        margin: 0;
        color: var(--text-muted);
        font-size: 11px;
        line-height: 1.45;
      }

      /* Segmented control instead of a select: two options read faster as a toggle, and it
         matches the page's display switch. */
      .sv-segmented {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 2px;
        padding: 3px;
        background: var(--surface-2);
        border: 1px solid var(--border);
        border-radius: var(--radius);

        button {
          height: 28px;
          padding: 0 8px;
          color: var(--text-muted);
          background: transparent;
          border: 0;
          border-radius: calc(var(--radius) - 3px);
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;

          &:hover:not(:disabled):not(.active) { color: var(--text); }

          &.active {
            color: var(--text);
            background: var(--surface);
            box-shadow: var(--shadow-sm);
          }

          &:disabled { cursor: not-allowed; opacity: 0.6; }

          i { font-size: 14px; }
        }
      }

      .sv-chips { display: flex; flex-wrap: wrap; gap: 5px; }

      .sv-chip {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: auto;
        min-height: 26px;
        padding: 3px 7px;
        color: var(--text);
        background: var(--surface-2);
        border: 1px solid var(--border);
        border-radius: 999px;
        font-size: 11px;
        cursor: pointer;

        &:hover:not(:disabled) { border-color: var(--border-strong); }
        &:disabled { cursor: not-allowed; opacity: 0.6; }

        i { color: var(--text-muted); font-size: 13px; }
      }

      .sv-add {
        justify-content: flex-start;
        height: 32px;
        padding: 0 9px;
        color: var(--text);
        background: transparent;
        border: 1px dashed var(--border-strong);
        border-radius: var(--radius-sm);
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;

        &:hover:not(:disabled) { background: var(--surface-2); }
        &:disabled { cursor: not-allowed; opacity: 0.5; }
      }

      .sv-actions {
        display: flex;
        gap: 8px;
        padding-top: 10px;
        border-top: 1px solid var(--border);
      }

      .sv-actions-end { justify-content: flex-end; }
      .sv-update { margin-left: auto; }

      /* Only compact panel sizing is set here. .sv-save deliberately keeps the global
         primary button colours (accent fill + hover + focus ring) so it matches every
         other primary action in the app; overriding just the background would leave the
         global button:hover rule — which out-specifies a single class — to flip it to
         accent on hover. */
      .sv-delete,
      .sv-cancel,
      .sv-save {
        height: 32px;
        padding: 0 12px;
        border-radius: var(--radius-sm);
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
      }

      .sv-delete {
        color: var(--danger);
        background: transparent;
        border: 1px solid transparent;

        &:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 10%, transparent); }
        &:disabled { cursor: not-allowed; opacity: 0.5; }
      }

      .sv-cancel {
        color: var(--text-muted);
        background: transparent;
        border: 1px solid var(--border);

        &:hover { color: var(--text); background: var(--surface-2); }
      }
    `,
  ],
})
export class SaveViewPopover {
  private readonly panel = inject(AnchoredPanelDirective);
  // Provided by GlobalWorkPage, so the panel edits the same saved view the page has applied.
  readonly state = inject(GlobalWorkState);

  constructor() {
    this.panel.configure({
      placement: () => ({ align: "end", width: 320, maxHeight: 460 }),
      // Escape inside the share sub-view steps back rather than closing the whole panel; an outside
      // click always closes, matching every other popover.
      onDismiss: (reason) => {
        if (reason === "escape" && this.view() !== "main") this.view.set("main");
        else this.closed.emit();
      },
    });
  }

  readonly closed = output<void>();

  readonly view = signal<"main" | "share">("main");
  readonly newViewName = signal("");
  readonly newViewVisibility = signal<WorkViewVisibility>("private");

  readonly visibilityOptions: { value: WorkViewVisibility; label: string; icon: string }[] = [
    { value: "private", label: "Private", icon: "lock" },
    { value: "organisation", label: "Everyone", icon: "building" },
  ];

  readonly shareCandidatesById = computed(() =>
    new Map(this.state.shareCandidates().map((person) => [person.userId, person]))
  );
  /** Colleagues who don't already have access to the applied view. */
  private readonly shareCandidates = computed(() => {
    const selected = this.state.selectedView();
    return this.state.shareCandidates().filter((person) =>
      person.userId !== selected?.ownerId && !selected?.sharedUserIds.includes(person.userId)
    );
  });
  readonly shareCandidateCount = computed(() => this.shareCandidates().length);
  readonly shareGroups = computed(() => [{
    id: "people",
    options: this.shareCandidates().map((person) => ({
      id: person.userId,
      label: person.displayName,
      avatarName: person.displayName,
      avatarUrl: person.avatarUrl,
      avatarUserId: person.userId,
    })),
  }]);

  visibilityHelp(visibility: WorkViewVisibility): string {
    return visibility === "private"
      ? "Only you and the people you share it with can open this view."
      : "Everyone in your organisation can open this view. They can’t change it, and still only see boards they can access.";
  }

  setVisibility(visibility: WorkViewVisibility): void {
    void this.state.updateSavedView(undefined, visibility);
  }

  async addShare(userId: string): Promise<void> {
    this.view.set("main");
    await this.state.addShare(userId);
  }

  async deleteView(): Promise<void> {
    await this.state.deleteSavedView();
    this.closed.emit();
  }

  async saveCurrentView(): Promise<void> {
    await this.state.updateSavedView();
    this.closed.emit();
  }

  async saveNewView(event: Event): Promise<void> {
    event.preventDefault();
    await this.state.createSavedView(this.newViewName(), this.newViewVisibility());
    this.newViewName.set("");
    this.closed.emit();
  }
}
