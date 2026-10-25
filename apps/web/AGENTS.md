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

## Translation

All visible text is marked for Angular i18n (`i18n` attributes, `$localize`, `icu()` for plurals
in TS); dates and numbers go through `shared/date-format.ts` / `appLocale()`. Follow
[`src/locale/README.md`](src/locale/README.md) and use the terms in
[`src/locale/GLOSSARY.md`](src/locale/GLOSSARY.md). Don't change English copy casually: a new id
needs every language translated again before `pnpm lint` passes.

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
  Precedents: `.work-table` in `global-work.page.scss` stacks; `BoardTableViewComponent` scrolls sideways.
- Touch suppresses `contextmenu` (it collides with CDK drag), so every right-click affordance needs a
  visible button. Hover-revealed controls stay visible on coarse pointers.
- Anchored panels stay anchored to their trigger on phones too (no bottom sheets); placement clamps
  them to the viewport. Use `dvh`, not `vh`, and `env(safe-area-inset-*)` for safe areas.
- Breakpoints in use: 480, 640, 720, 768, 1024. Reuse them.

## Scale tokens

`styles.scss` defines the scale; new styles use it rather than a literal, and a value off the scale
needs a comment. Type: `--text-xs/sm/base/md/lg`. Control heights: `--h-xs/sm/md/lg` (22/26/30/36).
Text tiers: `--text` → `--text-3` (card meta, secondary cells) → `--text-muted` (hints, labels) →
`--text-4` (placeholders only). Rows inside a list or sheet divide with `--divider`, not `--border`.
Toolbar controls come from `shared/toolbar-styles.scss` (`.k-toolbar-btn`, `.k-toolbar-icon-btn`,
`.k-toolbar-trigger`, `.k-toolbar-clear`); don't invent a per-view button.
Elevation by role: `--shadow-card` / `--shadow-card-hover` (tiles, with the element's own 1px border as
the ring), `--shadow-pop` (menus, popovers, pickers), `--shadow-drag` (CDK previews); `--shadow-sm` and
`--shadow` remain for chrome. Status washes: `--accent-soft`, `--success-soft`, `--danger-soft`,
`--warning-soft`, never an inline `color-mix(... 10%, transparent)`. Motion: `--motion-fast` for colour,
`--dur` for transforms, `--motion-base` + `--ease-drawer` for panels and drawers, `--spring` for small
pops only. Card keys use the `card-key` mixin in `shared/_card-key.scss` (`--text-xs`,
`--text-3`); add layout on top, never retype it. A list named anywhere (status cell, run header,
calendar tile, activity row) wears the `list-chip` mixin from `shared/_list-chip.scss` with
`--list-color` set to its hue; a board's identity is `k-board-icon` (tinted tile), not a bare glyph.
Density: `DensityService` stamps `[data-density="compact"]` on `<html>` (per device, never on the
account). Branch on it with `:host-context([data-density="compact"])` and change sizing only — never
colour, contrast or the 44px coarse-pointer floor. Theme previews come from `k-theme-picker`: an
element with its own `data-theme` / `data-accent` resolves the real tokens, so never hardcode a
theme's hexes for a swatch.

## CSS traps

These look like rendering bugs but are specificity or sizing problems.

- **Global resets in `styles.scss`.** `button` is pinned to `height: var(--h-lg)` (36px) with an accent
  background, hover and focus ring. `input` is pinned to `width: 100%; height: var(--h-lg)`, and `textarea` has
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
