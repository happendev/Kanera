import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";

interface MatchSegment {
  text: string;
  match: boolean;
}

/**
 * Splits `text` into plain and matched runs for every occurrence of `query`, using the pickers' own
 * filter rule: trimmed, case-insensitive substring (`toLowerCase().includes`), no diacritic folding.
 * Highlighting anything the filter would not have matched, or missing what it did, would make the
 * list look like it filtered on something else.
 *
 * Lower-cases one character at a time so offsets in the lowered string map back onto the original
 * even where lower-casing changes a character's length (Turkish dotted capital I becomes two code
 * units), which would otherwise shift every highlight after it.
 */
export function matchSegments(text: string, query: string): MatchSegment[] {
  const needle = query.trim().toLowerCase();
  if (!needle || !text) return text ? [{ text, match: false }] : [];

  let lowered = "";
  // origin[i] is the offset in `text` of the character that produced lowered[i].
  const origin: number[] = [];
  let offset = 0;
  for (const char of text) {
    const lower = char.toLowerCase();
    // One entry per UTF-16 unit of the lowered character, since indexOf counts units.
    origin.push(...new Array<number>(lower.length).fill(offset));
    lowered += lower;
    offset += char.length;
  }
  origin.push(text.length);

  const segments: MatchSegment[] = [];
  let cursor = 0;
  let from = 0;
  for (let at = lowered.indexOf(needle, from); at !== -1; at = lowered.indexOf(needle, from)) {
    const start = origin[at]!;
    const end = origin[at + needle.length]!;
    from = at + needle.length;
    if (end <= start || start < cursor) continue;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}

/**
 * Renders a picker row's label with the search match marked. Text is bound as interpolation, never
 * innerHTML, so a label or member name can contain anything without becoming markup.
 */
@Component({
  selector: "k-match-highlight",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  // One line on purpose: whitespace between segments would render as visible gaps inside the word.
  template: `@for (segment of segments(); track $index) {@if (segment.match) {<mark class="mh-mark">{{ segment.text }}</mark>} @else {<ng-container>{{ segment.text }}</ng-container>}}`,
  styles: `
    :host { display: inline; }

    /* The same tint global search uses for its matches, so a hit reads the same everywhere. No
       padding: the mark sits inside a word and must not change the label's width or ellipsis. */
    .mh-mark {
      color: inherit;
      font-weight: 600;
      background: color-mix(in srgb, var(--accent) 22%, transparent);
      border-radius: 2px;
    }
  `,
})
export class MatchHighlightComponent {
  readonly text = input("");
  readonly query = input("");

  readonly segments = computed(() => matchSegments(this.text(), this.query()));
}
