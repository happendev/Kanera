import { ChangeDetectionStrategy, Component, computed, inject, input, output } from "@angular/core";
import type { WorkDoneEventType } from "@kanera/shared/dto";
import { AvatarComponent } from "../../../shared/avatar.component";
import { CardKeyDisplayService } from "../../../shared/card-key-display.service";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { CardLabelsComponent, type CardLabelPresentation } from "../card-labels.component";
import { iconForType, verbForType } from "./work-done-grouping";
import type { CardDayDigest, WorkDoneActor, WorkDoneDay } from "./work-done.types";
import { formatTime } from "../../../shared/date-format";
import { icu } from "../../../core/i18n/icu";
import { MinuteClockService } from "../../../shared/minute-clock.service";
import { timeInProgressChip, type TimeInProgressChip } from "../time-in-progress.util";

export type WorkDoneBoardSummary = { id: string; name: string; icon: string | null; iconColor: string | null };

/** Contributor avatars shown in a day header before the rest roll into a "+n" pill. */
const MAX_HEADER_ACTORS = 5;
/** Checklist item texts named individually in the chip's tooltip before it summarises. */
const MAX_CHECKLIST_TOOLTIP_ITEMS = 6;

/**
 * The per-type counts a day header shows, in reading order: what shipped first, then progress, then
 * what started. Each tooltip is a whole ICU plural message so every language can inflect it.
 */
const COUNT_ORDER: { type: WorkDoneEventType; icon: string; tooltip: string }[] = [
  {
    type: "completed",
    icon: "circle-check",
    tooltip: $localize`:Work done day tooltip:{count, plural, one {# card completed} other {# cards completed}}`,
  },
  {
    type: "checklistItemCompleted",
    icon: "checkbox",
    tooltip: $localize`:Work done day tooltip:{count, plural, one {# checklist item ticked} other {# checklist items ticked}}`,
  },
  // Counts coalesced move events rather than distinct cards, so "moves" is the honest noun.
  {
    type: "moved",
    icon: "arrow-right",
    tooltip: $localize`:Work done day tooltip - card moves between lists:{count, plural, one {# move} other {# moves}}`,
  },
  {
    type: "created",
    icon: "plus",
    tooltip: $localize`:Work done day tooltip:{count, plural, one {# card created} other {# cards created}}`,
  },
];

/**
 * One local day of the work-done stream: a sticky summary header over that day's card digests.
 *
 * Presentational only — grouping and digest construction happen in work-done-grouping.ts, so this
 * component just renders and raises intent to the orchestrating view.
 */
@Component({
  selector: "k-work-done-day",
  standalone: true,
  imports: [AvatarComponent, CardLabelsComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./work-done-day.component.html",
  styleUrl: "./work-done-day.component.scss",
})
export class WorkDoneDayComponent {
  protected readonly showCardKeys = inject(CardKeyDisplayService).showCardKeys;
  private readonly clock = inject(MinuteClockService);
  readonly day = input.required<WorkDoneDay>();
  readonly collapsed = input(false);
  readonly workspaceId = input<string | null>(null);
  readonly selectedCardId = input<string | null>(null);
  readonly boardSummariesById = input<Map<string, WorkDoneBoardSummary> | null>(null);
  readonly timeZonesByWorkspace = input<ReadonlyMap<string, string> | null>(null);
  readonly labelsById = input<ReadonlyMap<string, CardLabelPresentation> | null>(null);

  readonly toggled = output<string>();
  readonly copyRequested = output<WorkDoneDay>();
  readonly digestOpened = output<CardDayDigest>();

  readonly iconFor = iconForType;
  readonly verbFor = verbForType;

  // Distinct cards, not rows: a card two people worked on that day renders two rows but is still one
  // card, and the header's job is to summarise the day's cards.
  readonly cardCountText = computed(() => {
    const count = new Set(this.day().digests.map((digest) => digest.cardId)).size;
    return icu($localize`:Number of distinct cards worked on in a day:{count, plural, one {# card} other {# cards}}`, { count });
  });

  /**
   * Always all four metrics, in a fixed order, even at zero.
   *
   * Every day panel therefore renders the same slots in the same positions, so the numbers form
   * readable columns down a multi-day stream. Omitting empty ones would reflow each header
   * independently and make the days impossible to compare at a glance; zeroes are dimmed instead.
   */
  readonly typeCounts = computed(() => {
    const counts = this.day().counts;
    return COUNT_ORDER.map((entry) => ({
      type: entry.type,
      icon: entry.icon,
      value: counts[entry.type],
      tooltip: icu(entry.tooltip, { count: counts[entry.type] }),
    }));
  });

  readonly visibleActors = computed(() => this.day().actors.slice(0, MAX_HEADER_ACTORS));
  readonly overflowActorCount = computed(() => Math.max(0, this.day().actors.length - MAX_HEADER_ACTORS));
  readonly overflowActorNames = computed(() =>
    this.day().actors.slice(MAX_HEADER_ACTORS).map((actor: WorkDoneActor) => actor.name).join(", ")
  );

  boardFor(digest: CardDayDigest): WorkDoneBoardSummary | null {
    return this.boardSummariesById()?.get(digest.boardId) ?? null;
  }

  /**
   * Label chips for a row. Resolved against the host's catalog; unknown ids are dropped rather than
   * rendered as blanks, since a cross-board stream can carry labels from a workspace the current
   * catalog does not cover.
   */
  labelsFor(digest: CardDayDigest): CardLabelPresentation[] {
    const lookup = this.labelsById();
    if (!lookup) return [];
    return digest.card.labelIds
      .map((id) => lookup.get(id))
      .filter((label): label is CardLabelPresentation => Boolean(label));
  }

  /** First word of a display name; the full name stays in the row's tooltip. */
  actorTooltip(actor: WorkDoneActor): string {
    return icu(
      $localize`:Tooltip on a contributor avatar, e.g. "Ada · 3 events":{count, plural, one {{name} · # event} other {{name} · # events}}`,
      { count: actor.eventCount, name: actor.name },
    );
  }

  workedOnBy(actor: WorkDoneActor): string {
    return $localize`:Tooltip on the person who did the work in a row:Worked on by ${actor.name}:person:`;
  }

  toggleLabel(): string {
    const date = this.day().fullLabel;
    return this.collapsed()
      ? $localize`:Button label - expand a day by its date:Expand ${date}:date:`
      : $localize`:Button label - collapse a day by its date:Collapse ${date}:date:`;
  }

  firstNameOf(actor: WorkDoneActor): string {
    return actor.name.split(" ")[0] ?? actor.name;
  }

  checklistChipText(digest: CardDayDigest): string {
    const ticks = digest.checklistTicks;
    // A single tick is worth naming inline; past that the count is the useful summary and the detail
    // moves to the tooltip.
    return ticks.length === 1
      ? ticks[0]!.text
      : icu($localize`:Chip - number of checklist items ticked on a card:{count, plural, one {# checklist item} other {# checklist items}}`, { count: ticks.length });
  }

  /**
   * Item names on one wrapped line. Joined with " · " rather than newlines because .k-tooltip does not
   * preserve them, so a multi-line string would collapse into an unpunctuated run of words.
   */
  checklistTooltip(digest: CardDayDigest): string {
    const ticks = digest.checklistTicks;
    const named = ticks.slice(0, MAX_CHECKLIST_TOOLTIP_ITEMS).map((tick) => tick.text);
    if (ticks.length > MAX_CHECKLIST_TOOLTIP_ITEMS) {
      named.push($localize`:How many more items are not named:+${ticks.length - MAX_CHECKLIST_TOOLTIP_ITEMS}:count: more`);
    }
    return named.join(" · ");
  }

  /**
   * The card's tracked time in progress, as it stands now (the digest carries the live card, not a
   * snapshot of that day). Beside what happened, it answers how much effort the card has taken.
   * No workspace alert here: this view reports work, it does not flag stuck cards.
   */
  timeInProgressFor(digest: CardDayDigest): TimeInProgressChip | null {
    return timeInProgressChip(digest.card, this.clock.now(), 0, this.timeZonesByWorkspace()?.get(digest.card.workspaceId));
  }

  /** Time of the card's last event that day, in the viewer's locale. */
  timeFor(digest: CardDayDigest): string {
    return formatTime(digest.lastAt);
  }
}
