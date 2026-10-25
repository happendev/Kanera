import type { OnDestroy, OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";
import { RouterLink } from "@angular/router";
import type { GettingStartedStep } from "@kanera/shared/dto";
import { ApiClient } from "../../core/api/api.client";
import { TOUCH_ONLY_QUERY } from "../../core/browser/input-modality";
import { GettingStartedService } from "../../core/getting-started/getting-started.service";
import { icu } from "../../core/i18n/icu";
import { formatShortcut } from "../../core/keyboard/keyboard-shortcuts.service";
import { BrowserPushService } from "../../core/notifications/browser-push.service";
import { GlobalSearchService } from "../../core/search/global-search.service";
import { mediaQuerySignal } from "../../shared/media-query.signal";
import { ToastService } from "../../shared/toast.service";
import { ScratchpadService } from "../scratchpad/scratchpad.service";
import { TooltipDirective } from "../../shared/tooltip.directive";

/** How a step is taken: a link to where it happens, or an action right here on the card. */
type StepAction =
  | { kind: "link"; commands: string[]; queryParams?: Record<string, string> }
  | { kind: "scratchpad" }
  | { kind: "push" }
  | { kind: "palette" }
  | { kind: "standaloneBoard" };

interface StepView {
  key: GettingStartedStep;
  done: boolean;
  /** The section's label, shown above the step in the spotlight. */
  section: string;
  icon: string;
  title: string;
  text: string;
  actionLabel: string;
  action: StepAction | null;
}

/** The palette shortcut as this platform writes it: "⌘K" on Apple devices, "Ctrl+K" elsewhere. */
const PALETTE_KEYS = (() => {
  const parts = formatShortcut("mod+k")[0] ?? [];
  return parts.join(parts[0] === "⌘" ? "" : "+");
})();

/** Tabler glyph for the spotlight, picked to read as what the step does. */
const STEP_ICONS: Record<GettingStartedStep, string> = {
  createCard: "square-plus",
  assignCard: "user-plus",
  comment: "message",
  mention: "at",
  completeCard: "circle-check",
  quickEdit: "pencil-bolt",
  useFilter: "filter",
  commandPalette: "command",
  viewWorkDone: "history",
  groupTable: "layout-rows",
  totalColumn: "sum",
  exportExcel: "file-spreadsheet",
  addDependency: "link",
  setStartDate: "calendar-event",
  viewTimeline: "timeline",
  scratchpad: "note",
  saveNote: "notebook",
  inviteTeam: "users",
  secondBoard: "layout-kanban",
  createAutomation: "bolt",
  enablePush: "bell-ringing",
  connectAgent: "plug",
  useAgent: "robot",
};

/**
 * Display groups, in the order someone meets them. The server decides which steps a viewer gets;
 * a section with none of its steps left in the payload is not drawn.
 */
const SECTIONS: readonly { key: string; label: string; steps: readonly GettingStartedStep[] }[] = [
  {
    key: "basics",
    label: $localize`:Getting started checklist section heading for the core card workflow:The basics`,
    steps: ["createCard", "assignCard", "comment", "mention", "completeCard"],
  },
  {
    key: "faster",
    label: $localize`:Getting started checklist section heading for shortcuts, filters and views:Work faster`,
    steps: ["quickEdit", "useFilter", "commandPalette", "viewWorkDone"],
  },
  {
    key: "tables",
    label: $localize`:Getting started checklist section heading for grouping, totals and export in the Table view:Tables`,
    steps: ["groupTable", "totalColumn", "exportExcel"],
  },
  {
    key: "planning",
    label: $localize`:Getting started checklist section heading for dependencies, start dates and the Timeline view:Plan ahead`,
    steps: ["addDependency", "setStartDate", "viewTimeline"],
  },
  {
    key: "notes",
    label: $localize`:Getting started checklist section heading for the scratchpad and notes:Notes`,
    steps: ["scratchpad", "saveNote"],
  },
  {
    key: "team",
    label: $localize`:Getting started checklist section heading for the organisation admin steps:Your team`,
    steps: ["inviteTeam", "secondBoard", "createAutomation"],
  },
  {
    key: "setup",
    label: $localize`:Getting started checklist section heading for push notifications and AI agents:Your setup`,
    steps: ["enablePush", "connectAgent", "useAgent"],
  },
];

/**
 * The "Getting started" checklist on home: the guidance between the one-time onboarding wizard and
 * a team that uses Kanera fully.
 *
 * A guided list rather than a wall of tips: one step at a time is open, shown in a spotlight beside
 * the list (or under its row on a narrow card) with what it teaches and the button that does it, and it is the first open step unless the user picked another. When a
 * step ticks, the next one opens, so the card walks people through the core loop of a card before
 * the team and setup steps.
 *
 * Each step ticks itself off from server state (see apps/api/src/modules/home/getting-started.ts),
 * so it never asks people to mark anything done. Steps keep their place when done, so nothing jumps
 * under the pointer. A checklist that was already complete on first sight never shows: an
 * established team would otherwise get a "you're all set" card the day this shipped. One completed
 * during the visit stays up, as "You're all set", for the rest of that visit.
 */
@Component({
  selector: "k-getting-started",
  standalone: true,
  imports: [NgTemplateOutlet, RouterLink, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./getting-started.component.html",
  styleUrl: "./getting-started.component.scss",
})
export class GettingStartedComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiClient);
  private readonly service = inject(GettingStartedService);
  private readonly search = inject(GlobalSearchService);
  private readonly toast = inject(ToastService);
  private readonly scratchpad = inject(ScratchpadService);
  readonly push = inject(BrowserPushService);

  /**
   * The board the card steps open: home's most recently visited board. The steps that happen on a
   * card have no better landing place, since the card to use is the user's own choice.
   */
  readonly boardId = input<string | null>(null);

  /** Standalone-only organisations have no workspace settings to send people to; home owns the dialog. */
  readonly newStandaloneBoard = output<void>();

  private readonly touchOnly = mediaQuerySignal(TOUCH_ONLY_QUERY);
  /**
   * Steps that were open when last loaded. Only these animate when they turn done, so a step that
   * was finished last week sits still instead of popping on every visit.
   */
  readonly openSteps = signal<ReadonlySet<GettingStartedStep>>(new Set());
  readonly pushBusy = signal(false);

  readonly steps = computed<StepView[]>(() => {
    const state = this.service.state();
    if (!state) return [];
    const target = state.teamTarget;
    const boardId = this.boardId();
    const notesWorkspaceId = state.notesWorkspaceId;
    const timelineBoardId = state.timelineBoardId;
    return state.steps.map(({ key, done }) => ({
      key,
      done,
      section: SECTIONS.find((section) => section.steps.includes(key))?.label ?? "",
      icon: STEP_ICONS[key],
      ...this.describe(key, target, boardId, notesWorkspaceId, timelineBoardId),
    }));
  });
  readonly sections = computed(() => {
    const byKey = new Map(this.steps().map((step) => [step.key, step]));
    return SECTIONS
      .map((section) => {
        const steps = section.steps.flatMap((key) => byKey.get(key) ?? []);
        return { ...section, steps, done: steps.filter((step) => step.done).length };
      })
      .filter((section) => section.steps.length > 0);
  });

  /** The step the user opened; undefined until they pick one. A picked step that ticks lets go. */
  private readonly picked = signal<GettingStartedStep | undefined>(undefined);
  readonly openKey = computed<GettingStartedStep | null>(() => {
    const steps = this.sections().flatMap((section) => section.steps);
    const picked = steps.find((step) => step.key === this.picked());
    if (picked && !picked.done) return picked.key;
    return steps.find((step) => !step.done)?.key ?? null;
  });
  readonly openStep = computed(() => this.steps().find((step) => step.key === this.openKey()) ?? null);
  readonly doneCount = computed(() => this.steps().filter((step) => step.done).length);
  readonly allDone = computed(() => this.steps().length > 0 && this.doneCount() === this.steps().length);
  readonly percent = computed(() => (this.steps().length ? Math.round((this.doneCount() / this.steps().length) * 100) : 0));
  readonly progressLabel = computed(() =>
    icu($localize`:Getting started checklist progress for screen readers:{done} of {total} steps done`, { done: this.doneCount(), total: this.steps().length }));

  readonly visible = computed(() => {
    const state = this.service.state();
    if (!state || state.dismissed || state.hidden || this.steps().length === 0) return false;
    return !this.allDone() || this.openSteps().size > 0;
  });

  /**
   * An agent is usually connected from a terminal, and push from another device, so the user comes
   * back to this tab to see the tick. Refetch on return rather than holding a socket subscription
   * for a card that changes a handful of times in its life.
   */
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === "visible") void this.reload();
  };

  ngOnInit(): void {
    void this.reload();
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  ngOnDestroy(): void {
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  private async reload(): Promise<void> {
    await this.service.load();
    // Union, never replace: a step stays "seen open" for the visit so its tick can still animate
    // and a completed checklist stays up after the last tick (see the class comment).
    const open = this.steps().filter((step) => !step.done).map((step) => step.key);
    if (open.some((key) => !this.openSteps().has(key))) this.openSteps.update((seen) => new Set([...seen, ...open]));
  }

  /**
   * With steps left, closing tucks the checklist into the account menu, where a progress ring brings
   * it back; with none left there is nothing to come back for, so it goes for good.
   */
  close(): void {
    if (this.allDone()) {
      this.service.dismiss();
      return;
    }
    this.service.hide();
    this.toast.info(
      $localize`:Toast after hiding the getting started checklist from home:Getting started is in your account menu whenever you want it.`,
      "user-circle",
    );
  }

  toggle(key: GettingStartedStep): void {
    // Closing the open step falls back to the first open one, so a step is always shown expanded.
    this.picked.set(this.openKey() === key ? undefined : key);
  }

  openPalette(): void {
    this.search.open();
  }

  openScratchpad(): void {
    this.scratchpad.setOpen(true);
  }

  /**
   * The same two writes as the push toggle in notification settings: subscribe this browser, then
   * switch the account's push channel on. A refusal leaves the step open with the browser's reason.
   */
  async enablePush(): Promise<void> {
    if (this.pushBusy()) return;
    this.pushBusy.set(true);
    try {
      await this.push.initialise();
      await this.push.subscribe();
      if (!this.push.subscribed()) return;
      await this.api.patch("/notifications/settings", { pushEnabled: true });
      await this.reload();
    } catch {
      this.push.error.set($localize`:Getting started checklist error:Push notifications could not be turned on. Try again from notification settings.`);
    } finally {
      this.pushBusy.set(false);
    }
  }

  private describe(
    key: GettingStartedStep,
    target: { workspaceId: string } | { boardId: string } | null,
    boardId: string | null,
    notesWorkspaceId: string | null,
    timelineBoardId: string | null,
  ): Omit<StepView, "key" | "done" | "section" | "icon"> {
    const openBoard = $localize`:Getting started step button:Open a board`;
    const boardLink: StepAction | null = boardId ? { kind: "link", commands: ["/b", boardId] } : null;
    const openTable = $localize`:Getting started step button; Table is a view name:Open a table`;
    const tableLink: StepAction = boardId
      ? { kind: "link", commands: ["/b", boardId], queryParams: { view: "table" } }
      : { kind: "link", commands: ["/my-cards"] };
    switch (key) {
      case "createCard":
        return {
          title: $localize`:Getting started step title:Create your first card`,
          // "New card" and "Add card" are the board's own button labels.
          text: this.touchOnly()
            ? $localize`:Getting started step text; New card and Add card are button labels on the board:Open a board and choose New card, or Add card at the foot of a list. Cards move through the lists as the work moves.`
            : $localize`:Getting started step text; C is the keyboard shortcut, New card is a button label on the board:Open a board and press C, or choose New card. Cards move through the lists as the work moves.`,
          actionLabel: openBoard,
          action: boardLink,
        };
      case "assignCard":
        return {
          title: $localize`:Getting started step title:Assign a card`,
          text: $localize`:Getting started step text; Assignees is a field label on the card and My Cards a page name:Open a card and choose Assignees, so everyone can see who owns it. Assigned cards gather in My Cards.`,
          actionLabel: openBoard,
          action: boardLink,
        };
      case "comment":
        return {
          title: $localize`:Getting started step title:Comment on a card`,
          text: $localize`:Getting started step text:Open a card and write a comment, so the conversation stays with the work instead of in chat.`,
          actionLabel: openBoard,
          action: boardLink,
        };
      case "mention":
        return {
          title: $localize`:Getting started step title:Mention someone`,
          text: $localize`:Getting started step text; @ is the character typed to mention someone:In a comment, type @ and pick a person. They are notified and can reply right on the card.`,
          actionLabel: openBoard,
          action: boardLink,
        };
      case "completeCard":
        return {
          title: $localize`:Getting started step title:Complete a card`,
          text: $localize`:Getting started step text; Mark complete is a button label:Open a card and choose Mark complete when the work is done. Completed cards show up in Work done.`,
          actionLabel: openBoard,
          action: boardLink,
        };
      case "quickEdit":
        return {
          title: $localize`:Getting started step title:Quick edit a card`,
          // Touch has no right-click; the card's actions button opens the same menu there.
          text: this.touchOnly()
            ? $localize`:Getting started step text; Quick edit is a menu item:Tap a card's actions button and choose Quick edit to change its title, people, labels or due date without opening it.`
            : $localize`:Getting started step text; Quick edit is a menu item:Right-click a card and choose Quick edit to change its title, people, labels or due date without opening it.`,
          actionLabel: openBoard,
          action: boardLink,
        };
      case "useFilter":
        return {
          title: $localize`:Getting started step title:Use a filter`,
          text: $localize`:Getting started step text; Filter is a button label and My Cards a page name:Choose Filter on a board or in My Cards to narrow cards by person, label, due date and more.`,
          actionLabel: $localize`:Getting started step button:Open My Cards`,
          action: { kind: "link", commands: ["/my-cards"] },
        };
      case "viewWorkDone":
        return {
          title: $localize`:Getting started step title; Work done is a view name:View Work done`,
          text: $localize`:Getting started step text; Work done is a view name:See what has been finished, day by day, on any board or across your cards.`,
          actionLabel: $localize`:Getting started step button; Work done is a view name:Open Work done`,
          action: boardId ? { kind: "link", commands: ["/b", boardId], queryParams: { view: "history" } } : null,
        };
      case "scratchpad":
        return {
          title: $localize`:Getting started step title:Write in your scratchpad`,
          text: $localize`:Getting started step text:Jot down quick thoughts in a private scratchpad that is one click away on every page.`,
          actionLabel: $localize`:Getting started step button:Open scratchpad`,
          action: { kind: "scratchpad" },
        };
      case "saveNote":
        return {
          title: $localize`:Getting started step title:Save a note`,
          text: $localize`:Getting started step text:Keep specs, meeting notes and how-tos next to the boards they are about, where the whole team can find them.`,
          actionLabel: $localize`:Getting started step button:Open notes`,
          action: notesWorkspaceId ? { kind: "link", commands: ["/w", notesWorkspaceId, "notes"] } : null,
        };
      // All three open the board's Table view; on a phone or before any board is open, My Cards
      // has the same table.
      case "groupTable":
        return {
          title: $localize`:Getting started step title; Table is a view name:Group a table`,
          text: $localize`:Getting started step text; Group is a toolbar button in the Table view:In Table view, choose Group to gather cards by assignee, label, due date or a custom field instead of by list.`,
          actionLabel: openTable,
          action: tableLink,
        };
      case "totalColumn":
        return {
          title: $localize`:Getting started step title:Total a column`,
          text: $localize`:Getting started step text; Calculate is a button in the table footer and Sum a menu option:In Table view, choose Calculate under a number column or time in progress, then Sum, to total it for every group.`,
          actionLabel: openTable,
          action: tableLink,
        };
      case "exportExcel":
        return {
          title: $localize`:Getting started step title:Export to Excel`,
          text: $localize`:Getting started step text; More table actions is a menu and Excel workbook a menu item:In Table view, open More table actions and choose Excel workbook to download the cards in view, grouped, with a summary sheet.`,
          actionLabel: openTable,
          action: tableLink,
        };
      // Both planning steps open the board the server picked: home's recent board may sit in a
      // workspace with start dates and the Timeline switched off.
      case "setStartDate":
        return {
          title: $localize`:Getting started step title:Set a start date`,
          text: $localize`:Getting started step text; Dates is a section and Add start date a button in card detail:In a card's Dates, choose Add start date. The card then runs from its start to its due date on the Timeline.`,
          actionLabel: openBoard,
          action: timelineBoardId ? { kind: "link", commands: ["/b", timelineBoardId] } : null,
        };
      case "viewTimeline":
        return {
          title: $localize`:Getting started step title; Timeline is a view name:Open the Timeline`,
          text: $localize`:Getting started step text; Timeline is a view name:See each dated card as a bar across the weeks, and drag a bar to reschedule it.`,
          actionLabel: $localize`:Getting started step button; Timeline is a view name:Open Timeline`,
          action: timelineBoardId ? { kind: "link", commands: ["/b", timelineBoardId], queryParams: { view: "timeline" } } : null,
        };
      case "addDependency":
        return {
          title: $localize`:Getting started step title:Link a dependency`,
          text: $localize`:Getting started step text; Dependencies is a section in card detail:In a card's Dependencies, mark what it is blocked by. Its assignee hears when it is ready to start.`,
          actionLabel: openBoard,
          action: boardLink,
        };
      case "inviteTeam":
        return {
          title: $localize`:Getting started step title:Invite your team`,
          text: $localize`:Getting started step text:Add people to the organisation, then give them the workspaces and boards they work on.`,
          actionLabel: $localize`:Getting started step button:Invite`,
          action: { kind: "link", commands: ["/settings", "users"] },
        };
      case "secondBoard":
        return {
          title: $localize`:Getting started step title:Create a second board`,
          // Lists and fields are workspace-scoped, which is the point worth teaching here: a new
          // workspace board needs no setup. Workspace boards are created in workspace settings.
          text: target && "workspaceId" in target
            ? $localize`:Getting started step text:Boards in a workspace share its lists and fields, so a new one is ready to use straight away.`
            : $localize`:Getting started step text:Give another project or team its own board.`,
          actionLabel: $localize`:Getting started step button:New board`,
          action: target && "workspaceId" in target
            ? { kind: "link", commands: ["/w", target.workspaceId, "settings", "general"] }
            : { kind: "standaloneBoard" },
        };
      case "createAutomation":
        return {
          title: $localize`:Getting started step title:Create an automation`,
          text: $localize`:Getting started step text:Assign, label or move cards on their own when something happens on a board.`,
          actionLabel: $localize`:Getting started step button:Create`,
          action: !target ? null : "workspaceId" in target
            ? { kind: "link", commands: ["/w", target.workspaceId, "settings", "automations"] }
            : { kind: "link", commands: ["/b", target.boardId, "settings", "automations"] },
        };
      case "connectAgent":
        return {
          title: $localize`:Getting started step title:Connect an AI agent`,
          text: $localize`:Getting started step text:Let Claude or another agent read and update your boards through MCP or the Kanera CLI.`,
          actionLabel: $localize`:Getting started step button:Connect`,
          action: { kind: "link", commands: ["/settings", "api-keys"] },
        };
      case "useAgent":
        return {
          title: $localize`:Getting started step title:Give your agent a task`,
          text: $localize`:Getting started step text:Ask your agent to add a card, move one along or comment on it. Its changes show on the card, marked as agent work.`,
          actionLabel: openBoard,
          action: boardLink,
        };
      case "enablePush":
        return {
          title: $localize`:Getting started step title:Turn on push notifications`,
          text: $localize`:Getting started step text:Hear about assignments and mentions on this device, even with Kanera closed.`,
          actionLabel: $localize`:Getting started step button:Turn on`,
          action: { kind: "push" },
        };
      case "commandPalette":
        return {
          title: $localize`:Getting started step title:Try the command palette`,
          // Phones and tablets have no shortcut to teach; the palette is the sidebar's search there.
          text: this.touchOnly()
            ? $localize`:Getting started step text:Search cards, notes and comments, and run commands, from one box.`
            : $localize`:Getting started step text; keys is a keyboard shortcut such as ⌘K or Ctrl+K:Press ${PALETTE_KEYS}:keys: to search cards, notes and comments, and run commands, from one box.`,
          actionLabel: $localize`:Getting started step button:Try it`,
          action: { kind: "palette" },
        };
    }
  }
}
