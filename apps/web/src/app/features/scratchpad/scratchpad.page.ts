import { ChangeDetectionStrategy, Component, computed, effect, inject } from "@angular/core";
import { AppTitleService } from "../../core/title/app-title.service";
import { ScratchpadPanelComponent } from "./scratchpad-panel.component";
import { ScratchpadService } from "./scratchpad.service";

/**
 * The popped-out scratchpad: the panel filling its own browser tab.
 *
 * Deliberately outside the app shell. There is no sidebar, no page header and no trigger row here,
 * because the point of popping out is a tab that is nothing but the notepad — a second window you can
 * put beside a board, a call, or another app. Everything else, including autosave, realtime and crash
 * recovery, is the same `ScratchpadPanelComponent` the dock uses; only its frame differs.
 *
 * Root-provided `ScratchpadService` still owns the state, so this tab converges with every other one
 * through the same socket events and last-write-wins rules that already cover two devices.
 */
@Component({
  selector: "k-scratchpad-page",
  standalone: true,
  imports: [ScratchpadPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<k-scratchpad-panel variant="page" />`,
  styles: [
    `
      :host {
        display: block;
        /* dvh, not vh: on mobile browsers the toolbar collapsing must not leave the editor taller than
           the visible window, which would put the caret under the URL bar while typing. */
        height: 100dvh;
        background: var(--surface);
      }
    `,
  ],
})
export class ScratchpadPage {
  private readonly scratchpad = inject(ScratchpadService);
  private readonly title = inject(AppTitleService);

  /**
   * The active page's name, as a plain string.
   *
   * A computed rather than a read inside the effect: `activeNote` is a computed over the notes array and
   * hands back a new object on every keystroke, so an effect reading it directly would re-title the
   * browser tab on every character typed. Resolving to a string first means the effect below only runs
   * when the name actually changes.
   */
  private readonly pageName = computed(() => this.scratchpad.activeNote()?.title.trim() || null);

  constructor() {
    // The whole tab is one page at a time, so the page's name belongs in the browser tab: a popped-out
    // scratchpad has to be findable among a dozen other tabs, and renaming a page should be visible
    // there immediately. The route's own "Scratchpad" title stays as the fallback while nothing is
    // selected, and remains the second part so the tab still reads as part of the app.
    effect(() => {
      this.title.set(this.pageName(), "Scratchpad");
    });
  }
}
