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
          <button type="button" class="ap-icon-button" aria-label="Back" i18n-aria-label="Button: back to the previous panel" (click)="view.set('main')">
            <i class="ti ti-chevron-left"></i>
          </button>
          <span class="ap-title" i18n="Heading: pick people to share a saved view with">Share with</span>
        </div>
        <k-picker-list
          [groups]="shareGroups()"
          searchPlaceholder="Search colleagues…"
          i18n-searchPlaceholder
          emptyLabel="Everyone already has access"
          i18n-emptyLabel
          (pick)="addShare($event)"
        />
      } @else if (state.selectedView(); as selected) {
        <div class="ap-head">
          <span class="ap-title">{{ selected.name }}</span>
          <button type="button" class="ap-icon-button" aria-label="Close" i18n-aria-label="Button: close the popover" (click)="closed.emit()">
            <i class="ti ti-x"></i>
          </button>
        </div>

        <div class="sv-body">
          @if (selected.editable) {
            <div class="sv-field">
              <span class="sv-label" i18n="Field label: who can open a saved view">Visibility</span>
              <div class="sv-segmented" role="group" aria-label="Visibility" i18n-aria-label="Field label: who can open a saved view">
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
              <span class="sv-label" i18n>Shared with specific people</span>
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
                        <ng-container i18n="Stand-in for a deleted or inaccessible user">User no longer available</ng-container>
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
                <ng-container i18n="Button: share the saved view with another person">Add a colleague</ng-container>
              </button>
            </div>

            <footer class="sv-actions">
              <button type="button" class="sv-delete" [disabled]="!state.interactionReady()" (click)="deleteView()">
                <i class="ti ti-trash"></i>
                <ng-container i18n="Button: delete the saved view">Delete view</ng-container>
              </button>
              <button
                type="button"
                class="sv-save sv-update"
                [disabled]="state.saving() || !state.interactionReady()"
                (click)="saveCurrentView()"
              >
                <i class="ti ti-device-floppy"></i>
                <ng-container i18n="Button: overwrite the saved view with the current filters">Update view</ng-container>
              </button>
            </footer>
          } @else {
            <p class="sv-help" i18n>Shared by {{ selected.ownerName // i18n(ph="owner") }}. Only the owner can change this view, and you’ll only see boards you can access.</p>
          }
        </div>
      } @else {
        <div class="ap-head">
          <span class="ap-title" i18n="Heading of the save view popover">Save this view</span>
          <button type="button" class="ap-icon-button" aria-label="Close" i18n-aria-label="Button: close the popover" (click)="closed.emit()">
            <i class="ti ti-x"></i>
          </button>
        </div>

        <form class="sv-body" (submit)="saveNewView($event)">
          <div class="sv-field">
            <span class="sv-label" i18n="Field label: name of a saved view">View name</span>
            <input
              autofocus
              class="ap-input"
              [value]="newViewName()"
              (input)="newViewName.set($any($event.target).value)"
              maxlength="120"
              placeholder="e.g. Launch risks"
              i18n-placeholder="Example name for a saved view"
            />
          </div>

          <div class="sv-field">
            <span class="sv-label" i18n="Field label: who can open a saved view">Visibility</span>
            <div class="sv-segmented" role="group" aria-label="Visibility" i18n-aria-label="Field label: who can open a saved view">
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
            <button type="button" class="sv-cancel" (click)="closed.emit()" i18n="Button: cancel saving the view">Cancel</button>
            <button
              type="submit"
              class="sv-save"
              [disabled]="!newViewName().trim() || state.saving() || !state.interactionReady()"
              i18n="Button: save the current filters as a new view"
            >Save view</button>
          </footer>
        </form>
      }
    </div>
  `,
  styles: [
    ANCHORED_PANEL_STYLES,
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
        font-size: var(--text-xs);
        font-weight: 700;
      }

      .sv-help {
        margin: 0;
        color: var(--text-muted);
        font-size: var(--text-xs);
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
          font-size: var(--text-sm);
          font-weight: 600;
          cursor: pointer;

          &:hover:not(:disabled):not(.active) { color: var(--text); }

          &.active {
            color: var(--text);
            background: var(--surface);
            box-shadow: var(--shadow-sm);
          }

          &:disabled { cursor: not-allowed; opacity: 0.6; }

          i { font-size: var(--text-md); }
        }
      }

      .sv-chips { display: flex; flex-wrap: wrap; gap: 5px; }

      .sv-chip {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: auto;
        min-height: var(--h-sm);
        padding: 3px 7px;
        color: var(--text);
        background: var(--surface-2);
        border: 1px solid var(--border);
        border-radius: 999px;
        font-size: var(--text-xs);
        cursor: pointer;

        &:hover:not(:disabled) { border-color: var(--border-strong); }
        &:disabled { cursor: not-allowed; opacity: 0.6; }

        i { color: var(--text-muted); font-size: var(--text-base); }
      }

      .sv-add {
        justify-content: flex-start;
        height: 32px;
        padding: 0 9px;
        color: var(--text);
        background: transparent;
        border: 1px dashed var(--border-strong);
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        font-weight: 600;
        cursor: pointer;

        &:hover:not(:disabled) { background: var(--surface-hover); }
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
        font-size: var(--text-base);
        font-weight: 600;
        cursor: pointer;
      }

      .sv-delete {
        color: var(--danger);
        background: transparent;
        border: 1px solid transparent;

        &:hover:not(:disabled) { background: var(--danger-soft); }
        &:disabled { cursor: not-allowed; opacity: 0.5; }
      }

      .sv-cancel {
        color: var(--text-muted);
        background: transparent;
        border: 1px solid var(--border);

        &:hover { color: var(--text); background: var(--surface-hover); }
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
    { value: "private", label: $localize`:Saved view visibility option, only the owner and people it is shared with:Private`, icon: "lock" },
    { value: "organisation", label: $localize`:Saved view visibility option, everyone in the organisation:Everyone`, icon: "building" },
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
      ? $localize`Only you and the people you share it with can open this view.`
      : $localize`Everyone in your organisation can open this view. They can’t change it, and still only see boards they can access.`;
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
