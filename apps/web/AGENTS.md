Web client rules. The root [`AGENTS.md`](../../AGENTS.md) still applies.

## Angular conventions

The app is zoneless with `ChangeDetectionStrategy.OnPush` everywhere, so state lives in signals.

- Use `input()` / `output()`, `inject()`, and `@if` / `@for` / `@switch`. Don't use decorators,
  constructor DI or structural directives.
- Route and query params bind through `withComponentInputBinding()`; read them as `input()` signals
  rather than subscribing to `ActivatedRoute`.
- Put async setup in `ngOnInit`, not the constructor.
- Don't use `FormsModule` or `ngModel` with signals. Bind natively:
  ```html
  <input [value]="query()" (input)="query.set($any($event.target).value)" />
  <input type="number" [value]="count()" (input)="count.set(+$any($event.target).value)" />
  <select [value]="days() ?? ''" (input)="days.set($any($event.target).value ? +$any($event.target).value : null)">
  ```
- A `<select>` with `@for` options needs `[selected]` on every option, including a static placeholder.
  Zoneless applies `[value]` before the options exist.
  ```html
  <option value="" [selected]="!selectedId()">None</option>
  @for (item of items(); track item.id) {
  <option [value]="item.id" [selected]="item.id === selectedId()">{{ item.name }}</option>
  }
  ```
- Don't make an effect depend on a `computed()` that returns a fresh object (`computed()?.id` re-runs
  on every upstream change). If that effect writes back to state, it loops and freezes the tab. Key
  effects on primitive signals.

## Shared surfaces

- `BoardState` is route-scoped and consumes workspace-level list events plus board-level card events.
- The Board and Global Work pages share card, filter and realtime patterns. When you change one,
  check the other.
- `BoardTableViewComponent` is the only table, used for both boards and Global Work. Its file comments
  explain the `sourceBoards`, `hostGroupBy`/`hostSortBy` and `TABLE_CARD_STORE` contracts; read them
  before changing it. Add a write to `TABLE_CARD_STORE` only if it changes where or how a row
  renders; everything else converges on the realtime echo.
- `CardDetailComponent` owns the live comment panel. Attachments behave the same across the
  description, comments, the attachment list and activity rows: images, video, audio and PDFs open in
  the shared lightbox, and anything else downloads. Change and test all four surfaces together.

## Design language

- Follow shadcn/ui's look without importing it: neutral colours, subtle borders, consistent radius,
  clean type, minimal decoration.
- Use only Tabler icons: `<i class="ti ti-icon-name"></i>`. Ask before adding an inline SVG icon.
- Never write "changes save automatically" or similar copy. The `k-autosave-status` chip is the whole
  contract.
- Full-width panels should fill their width. Reshape the data instead of enlarging the marks.

## Small screens and PWA

Phones, tablets and the installed PWA are first-class, so design for them up front.

- Touch targets key on the pointer, not the viewport:
  `@media (hover: none), (pointer: coarse), (any-pointer: coarse)` gets 44px targets. In TS, use
  `hasCoarsePointer()` from `core/browser/input-modality.ts`.
- Dense tables make an explicit, commented choice between stacking into cards and scrolling sideways.
  Precedents are `.work-table` vs `.portfolio-table` in `global-work.page.scss`.
- Touch suppresses `contextmenu` (it collides with CDK drag), so every right-click affordance needs a
  visible button. Hover-revealed controls stay visible on coarse pointers.
- Anchored panels become bottom sheets via `ANCHORED_SHEET_STYLES`. Use `dvh`, not `vh`, and
  `max(8px, calc(env(safe-area-inset-bottom) + 8px))` for safe areas.
- Breakpoints in use: 480, 640, 720, 768, 1024. Reuse them.

## CSS traps

These look like rendering bugs but are specificity or sizing problems.

- **Global resets in `styles.scss`.** `button` is pinned to `height: 36px` with an accent background,
  hover and focus ring. `input` is pinned to `width: 100%; height: 36px`, and `textarea` has
  `min-height: 64px`. Angular's scoping attribute leaves a plain `.my-btn` rule at lower specificity
  than `button:hover:not(:disabled)`, so custom buttons flood with accent on hover. Fixes:
  - Restate the background inside your own `:hover:not(:disabled)`.
  - Reset `height: auto` on container-style buttons and `justify-content: flex-start` on row buttons.
  - Give checkboxes `width: 16px; flex: none`.
  - Use a compound selector (`.row input.my-input`) for small inputs.
  - Set `min-height: 0` on content-sized textareas.

  See `.sg-btn` in `shared/segmented.component.ts` for a worked example.
- **`kAnchoredPanel` owns placement.** Style only appearance on an anchored panel. Any
  `position`/`top`/`left`/`z-index` in component styles out-specifies the directive and parks the
  panel off-screen while it still reports visible.
- **Grid children need `min-width: 0`** down their whole flex chain, or wide content pushes the shell
  column past its track and off the viewport.
- **Rows in a flex column need `flex: none`** (and so do sticky headings), or they shrink to
  `min-height` and their text renders outside the box, so hover highlights the wrong thing.
- **Inline `styles: [...]` are CSS in a template literal.** `//` comments break the build, and a
  backtick inside a comment ends the string with baffling TS/NG errors. Use `/* */` and write
  property names bare. Shared CSS consts imported into `styles` do work.
