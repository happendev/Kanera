# Translating the web app

Kanera uses Angular's built-in i18n (`@angular/localize`) in **runtime mode**: one build serves every
language. `src/main.ts` loads the viewer's translations before any application code runs
(`core/i18n/locale.ts`), so changing language reloads the page.

| File | What it is |
| --- | --- |
| `messages.arb` | Source catalog (UK English), generated. Each message's id, text, description and the files that use it. |
| `messages.<locale>.json` | One language, `{ locale, translations: { id: text } }`, the shape `loadTranslations()` reads. |
| `GLOSSARY.md` | Agreed product terms per language. Read it before translating. |
| `../../scripts/i18n.mjs` | Extract, check, list untranslated, merge. |

The supported languages are `LOCALES` in `packages/shared/src/locales.ts`. That one list drives the
database CHECK, the API DTOs, the settings picker and these checks.

## Day-to-day workflow

```bash
pnpm i18n:extract                                   # after changing any user-facing text
node apps/web/scripts/i18n.mjs status               # what's missing per language
node apps/web/scripts/i18n.mjs todo es --limit 100  # untranslated messages, with context, as JSON
node apps/web/scripts/i18n.mjs merge es batch.json  # merge {"id": "translation"}; validates placeholders
pnpm i18n:check                                     # runs in `pnpm lint`; fails on anything stale or missing
pnpm --filter @kanera/web templates:messages        # after editing workspace template content, then extract
```

Message ids are hashes of the English text (plus meaning). **Editing English copy creates a new
message**, so every language needs it translated again. `pnpm i18n:check` will name it.

## Adding a language

1. Add the BCP 47 tag and its native name to `LOCALES` / `LOCALE_NATIVE_NAMES` in
   `packages/shared/src/locales.ts`. Extend `matchLocale` if the region fallback is unusual.
2. Generate a migration (`pnpm db:generate`), since the `users_locale_ck` CHECK lists the tags.
3. Add `messages.<tag>.json` here, with `{ "locale": "<tag>", "translations": {} }`.
4. Add the loader line to `TRANSLATIONS` and Angular's locale data to `ANGULAR_LOCALE_DATA` in
   `src/app/core/i18n/locale.ts`. The type checker names both.
5. Add the server catalog in `apps/api/src/lib/i18n/messages/<tag>.ts`, also enforced by the type
   checker.
6. Add a column to `GLOSSARY.md`, then translate with `todo` / `merge` until `pnpm i18n:check` passes.

## Marking text for translation

All user-visible text is marked, including visible text, `title`, `placeholder`, `aria-label`,
`alt`, toasts, confirm dialogs, validation messages, empty states and page titles. Don't mark
user content, the product name on its own, keyboard key names, code samples, CSS classes, icon
names, analytics event names, storage keys, route paths, enum values sent to the API, or
`console.*` output.

### Templates

```html
<!-- Element text. Use a description when the words alone are ambiguous. -->
<h3 i18n="Settings section heading">Language</h3>

<!-- Attributes. -->
<input placeholder="Search boards" i18n-placeholder />
<button aria-label="Close" i18n-aria-label title="Close" i18n-title>…</button>

<!-- Same English, different translation: add a meaning (it changes the id). The description
     after the pipe is what translators see, so repeat the context there. -->
<span i18n="card state|Card state: not yet completed">Open</span>
<button i18n="verb|Button: open the card">Open</button>

<!-- Text beside an icon: wrap only the words, so translators don't see icon placeholders.
     Angular drops a whitespace-only text node next to <ng-container>, so write the gap as
     &ngsp; (or rely on the button's flex gap). -->
<button><i class="ti ti-plus"></i>&ngsp;<ng-container i18n>Add card</ng-container></button>

<!-- Interpolations: name every placeholder so translators know what it is. -->
<p i18n>Moved to {{ list.name // i18n(ph="list") }} by {{ actor // i18n(ph="person") }}</p>

<!-- Plurals and selects are ICU. Never build plurals with `count === 1 ? '' : 's'`. -->
<span i18n>{ count(), plural, =0 {No cards} =1 {1 card} other {{{ count() }} cards} }</span>
```

- Keep a sentence in one message. Don't split it across elements and concatenate. Inline markup
  (`<b>`, `<a>`) inside an `i18n` element is fine; it becomes a placeholder the translator can move.
- Mark the innermost element that holds the whole sentence. Don't put `i18n` on an element that
  contains `@if`/`@for` blocks or child components; mark the text inside them instead.
- A bound attribute with a literal (`[title]="'Close'"`) can't be marked. Make it static
  (`title="Close" i18n-title`) or move the string into TypeScript with `$localize`.
- `<option>` text, `<label>` text and `<th>` text all need `i18n`.

### TypeScript

```ts
// Plain text. Add a description (`:description:`) when the words alone are ambiguous.
this.toasts.success($localize`Card archived`);
const label = $localize`:Toolbar button that groups cards:Group`;

// Placeholders: always name them with :name: after the expression.
$localize`Moved ${card.title}:card: to ${list.name}:list:`;

// Plurals and selects: put the ICU in the message and evaluate it with icu() from core/i18n/icu.
// Pass user content as icu() values, not ${} placeholders, so a "#" or "{" in a name stays text.
icu($localize`:Toast after archiving:{count, plural, one {# card archived} other {# cards archived}}`, { count });
icu($localize`{count, plural, one {# card} other {# cards}} in {list}`, { count, list: list.name });
```

- `$localize` in a module-level constant is fine. Translations load before any module evaluates.
- Labels kept in lookup tables (`{ value: "todo", label: "To do" }`) are marked where they're
  defined. Keep the `value` untranslated.
- Error text from the API is already translated by the server (the web sends `Accept-Language`).
  Mark only the client-side fallback (`?? $localize\`Something went wrong.\``).
- Don't change English wording while marking. E2E selectors and spec assertions read it.

### Dates, numbers, sorting

- Format every date and time through `shared/date-format.ts`. Don't use Angular's `date` pipe,
  `toLocaleDateString()` or a bare `Intl.DateTimeFormat`.
- Any other `Intl.*` constructor takes `appLocale()` from `core/i18n/locale.ts`, never `undefined`
  or a hard-coded `"en-US"`. The exception is a machine format, such as a parse or a file name,
  that must not vary.
- To sort user-visible text, use `a.localeCompare(b, appLocale())`.

## Installed-app text

`apps/web/scripts/pwa-locales.json` holds manifest descriptions, screenshot labels and shortcut text
for every supported language. `node apps/web/scripts/generate-pwa-manifests.mjs` generates static
standard/Samsung manifests plus the early language selector using the shared locale matcher. It
runs during asset generation; `--check` verifies generated assets without rewriting them.
All variants retain the same app id, scope and start URL. Installed shortcut updates depend on the
browser's manifest refresh schedule.
