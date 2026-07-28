import { ChangeDetectionStrategy, Component, computed, input, output } from "@angular/core";
import type { WorkDoneEventType } from "@kanera/shared/dto";
import { AvatarComponent } from "../../../shared/avatar.component";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { CardLabelsComponent, type CardLabelPresentation } from "../card-labels.component";
import { iconForType, verbForType } from "./work-done-grouping";
import type { CardDayDigest, WorkDoneActor, WorkDoneDay } from "./work-done.types";

export type WorkDoneBoardSummary = { id: string; name: string; icon: string | null; iconColor: string | null };

/** Contributor avatars shown in a day header before the rest roll into a "+n" pill. */
const MAX_HEADER_ACTORS = 5;
/** Checklist item texts named individually in the chip's tooltip before it summarises. */
const MAX_CHECKLIST_TOOLTIP_ITEMS = 6;

/**
 * The per-type counts a day header shows, in reading order: what shipped first, then progress, then
 * what started. Singular and plural are spelled out because none of these pluralise by adding "s".
 */
const COUNT_ORDER: { type: WorkDoneEventType; icon: string; one: string; many: string }[] = [
  { type: "completed", icon: "circle-check", one: "card completed", many: "cards completed" },
  { type: "checklistItemCompleted", icon: "checkbox", one: "checklist item ticked", many: "checklist items ticked" },
  // Counts coalesced move events rather than distinct cards, so "moves" is the honest noun.
  { type: "moved", icon: "arrow-right", one: "move", many: "moves" },
  { type: "created", icon: "plus", one: "card created", many: "cards created" },
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
  readonly day = input.required<WorkDoneDay>();
  readonly collapsed = input(false);
  readonly workspaceId = input<string | null>(null);
  readonly selectedCardId = input<string | null>(null);
  readonly boardSummariesById = input<Map<string, WorkDoneBoardSummary> | null>(null);
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
    return `${count} ${count === 1 ? "card" : "cards"}`;
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
      tooltip: `${counts[entry.type]} ${counts[entry.type] === 1 ? entry.one : entry.many}`,
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
  firstNameOf(actor: WorkDoneActor): string {
    return actor.name.split(" ")[0] ?? actor.name;
  }

  checklistChipText(digest: CardDayDigest): string {
    const ticks = digest.checklistTicks;
    // A single tick is worth naming inline; past that the count is the useful summary and the detail
    // moves to the tooltip.
    return ticks.length === 1 ? ticks[0]!.text : `${ticks.length} checklist items`;
  }

  /**
   * Item names on one wrapped line. Joined with " · " rather than newlines because .k-tooltip does not
   * preserve them, so a multi-line string would collapse into an unpunctuated run of words.
   */
  checklistTooltip(digest: CardDayDigest): string {
    const ticks = digest.checklistTicks;
    const named = ticks.slice(0, MAX_CHECKLIST_TOOLTIP_ITEMS).map((tick) => tick.text);
    if (ticks.length > MAX_CHECKLIST_TOOLTIP_ITEMS) {
      named.push(`+${ticks.length - MAX_CHECKLIST_TOOLTIP_ITEMS} more`);
    }
    return named.join(" · ");
  }

  /** Time of the card's last event that day, in the viewer's locale. */
  timeFor(digest: CardDayDigest): string {
    return new Date(digest.lastAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
}
