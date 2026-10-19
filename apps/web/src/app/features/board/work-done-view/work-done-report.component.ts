import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from "@angular/core";
import type { WireBoardMemberUser } from "@kanera/shared/events";
import { icu } from "../../../core/i18n/icu";
import { AvatarComponent } from "../../../shared/avatar.component";
import { CardLabelsComponent } from "../card-labels.component";
import { CardKeyDisplayService } from "../../../shared/card-key-display.service";
import { StatTileComponent } from "../../../shared/stat-tile.component";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { ATTENTION_CARD_LIMIT, type ReportAttentionGroup, type ReportAttentionKind, type ReportPerson, type WorkDoneReport } from "./work-done-report";

/** Assignee avatars shown on an attention row before the rest roll into "+n". */
const MAX_ROW_ASSIGNEES = 3;

/**
 * The Report layout of the Work done view: a management read of one board over a period.
 *
 * Presentational only. `buildWorkDoneReport` in work-done-report.ts decides every number and
 * sentence; this component lays them out — headline first, then the period's numbers, then the two
 * charts, then what needs attention now, then the breakdowns the board's own content earns (people,
 * labels, select fields, checklists). Charts are plain HTML and CSS: one hue per series, thin marks,
 * hairline gridlines, a tooltip on every mark and every value also written out, so nothing is
 * readable through colour alone.
 */
@Component({
  selector: "k-work-done-report",
  standalone: true,
  imports: [AvatarComponent, CardLabelsComponent, StatTileComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./work-done-report.component.html",
  styleUrl: "./work-done-report.component.scss",
})
export class WorkDoneReportComponent {
  protected readonly showCardKeys = inject(CardKeyDisplayService).showCardKeys;

  readonly report = input.required<WorkDoneReport>();
  /** A refetch is in flight: the previous render stays up at reduced opacity rather than flashing a skeleton. */
  readonly refreshing = input(false);
  readonly workspaceId = input<string | null>(null);
  readonly membersById = input<ReadonlyMap<string, WireBoardMemberUser>>(new Map());
  readonly inProgressEnabled = input(true);
  /** The host is still paging cards in, so the "right now" counts below are knowingly incomplete. */
  readonly partial = input(false);

  readonly cardOpened = output<string>();

  readonly attentionLimit = ATTENTION_CARD_LIMIT;
  readonly maxRowAssignees = MAX_ROW_ASSIGNEES;

  private readonly pickedAttention = signal<ReportAttentionKind | null>(null);
  /** The expanded attention group: the picked one while it still has cards, else the worst one. */
  readonly activeAttention = computed<ReportAttentionGroup | null>(() => {
    const groups = this.report().attention;
    const picked = this.pickedAttention();
    return groups.find((group) => group.kind === picked) ?? groups[0] ?? null;
  });

  readonly deltaSuffix = computed(() => this.report().comparisonLabel ?? "");
  readonly hasFlow = computed(() => this.report().flow.some((day) => day.created || day.completed || day.moved));
  readonly openByListVisible = computed(() => this.report().openCount > 0 && this.report().lists.length > 0);
  readonly byBoardVisible = computed(() => this.report().boards.length > 0);
  readonly byWorkspaceVisible = computed(() => this.report().workspaces.length > 0);
  readonly peopleVisible = computed(() => this.report().people.length > 0);

  readonly openCountLabel = computed(() => icu($localize`:Report panel subtitle - open cards on the board:{count, plural, one {# open card} other {# open cards}}`, { count: this.report().openCount }));
  readonly checklistLabel = computed(() => {
    const checklist = this.report().checklist;
    if (!checklist) return "";
    return icu(
      $localize`:Report checklist meter text:{done} of {total, plural, one {# item} other {# items}} done across {cards, plural, one {# card} other {# cards}}`,
      { done: checklist.done, total: checklist.total, cards: checklist.cards },
    );
  });
  readonly checklistShare = computed(() => {
    const checklist = this.report().checklist;
    return checklist ? Math.round((checklist.done / checklist.total) * 100) : 0;
  });

  pickAttention(kind: ReportAttentionKind): void {
    this.pickedAttention.set(kind);
  }

  moreCount(group: ReportAttentionGroup): number {
    return Math.max(0, group.count - group.cards.length);
  }

  moreLabel(group: ReportAttentionGroup): string {
    return icu($localize`:Report attention list footer - cards not named individually:{count, plural, one {and # more} other {and # more}}`, { count: this.moreCount(group) });
  }

  assigneesFor(ids: readonly string[]): WireBoardMemberUser[] {
    const members = this.membersById();
    return ids.map((id) => members.get(id)).filter((member): member is WireBoardMemberUser => !!member);
  }

  personActivityLabel(person: ReportPerson): string {
    if (!person.completed && !person.other) return $localize`:Report people row - the person did nothing in the period:No activity this period`;
    const completed = icu($localize`:Report people row - cards completed:{count, plural, one {# completed} other {# completed}}`, { count: person.completed });
    if (!person.other) return completed;
    const other = icu($localize`:Report people row - other actions (created, moved, checklist items):{count, plural, one {# other action} other {# other actions}}`, { count: person.other });
    return `${completed} · ${other}`;
  }

  personWorkloadLabel(person: ReportPerson): string {
    return icu($localize`:Report people row - open assignments now:{count, plural, one {# open} other {# open}}`, { count: person.open });
  }

  personOverdueLabel(person: ReportPerson): string {
    return icu($localize`:Report people row - overdue assignments now:{count, plural, one {# overdue} other {# overdue}}`, { count: person.overdue });
  }

  /** The completed segment's share of the person's bar; the remainder is their other activity. */
  completedShare(person: ReportPerson): number {
    const total = person.completed + person.other;
    return total ? (person.completed / total) * person.share * 100 : 0;
  }

  otherShare(person: ReportPerson): number {
    const total = person.completed + person.other;
    return total ? (person.other / total) * person.share * 100 : 0;
  }

  unsetLabel(count: number): string {
    return icu($localize`:Report field breakdown - open cards with no value:{count, plural, one {# card without a value} other {# cards without a value}}`, { count });
  }

  barTooltip(name: string, value: number, hint: string | null): string {
    const base = $localize`:Tooltip on a report bar, e.g. "Billing · 4 open":${name}:name: · ${icu($localize`:Count of open cards in a bar tooltip:{count, plural, one {# open} other {# open}}`, { count: value })}:count:`;
    return hint ? `${base} · ${hint}` : base;
  }
}
