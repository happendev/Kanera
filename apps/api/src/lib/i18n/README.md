# Server-side translations

Everything the API writes to a person outside a request/response cycle, meaning every email and
every push or personal-channel notification (ntfy, Gotify, webhook), is rendered in the
**recipient's** language. The web app has its own catalogs (`apps/web/src/locale/`). Product terms
and the voice for each language are in [`apps/web/src/locale/GLOSSARY.md`](../../../../web/src/locale/GLOSSARY.md).

Supported tags live in `@kanera/shared/locales` (`LOCALES`, `SOURCE_LOCALE = "en-GB"`).

## Layout

| File | Purpose |
| --- | --- |
| `messages/types.ts` | `ServerMessages`: every string, grouped by email template (`email.*`), push (`push.*`), the email chrome (`layout`), shared bits (`common`) and the notification action lines (`activity`, shared with the web drawer). |
| `messages/en-GB.ts` | Source catalog. Its output is what the committed email previews show. |
| `messages/index.ts` | `serverMessages(locale)`. A `Record<Locale, ServerMessages>`, so a tag without a catalog fails type-checking. |
| `format.ts` | `formatDate`, `formatLocalDate`, `formatNumber`, `formatBytes`, all `Intl`-based and in the recipient's locale. Machine formatting (keys, comparisons) uses `wallClockParts` in `../date-time-formatter.ts`, never these. |
| `request-locale.ts` | Locale resolution (below). |

Templates (`../email-templates/`) take `locale` in their params, read all copy from the catalog, and
keep HTML out of it: when a sentence has a bold name or a link inside, the template calls
`richHtml(...)`, which escapes the catalog text and splices the markup in at the named param.

## Adding a language

1. Add the tag to `LOCALES` in `packages/shared/src/locales.ts` (if it is new).
2. Write `messages/<tag>.ts` exporting a default `ServerMessages` object. Translate from
   `en-GB.ts`; keep params, `Kanera`, and plan names (`Free`, `Pro`) as they are. Write plural logic
   inline. Use `count === 1` where that is enough, or `new Intl.PluralRules("<tag>").select(count)`
   for languages with more forms (Japanese has a single form). A regional variant can spread its
   base and override only what differs:

   ```ts
   import enGB from "./en-GB.js";
   import type { ServerMessages } from "./types.js";

   const enUS: ServerMessages = {
     ...enGB,
     layout: { ...enGB.layout, footerLifecycle: "…Kanera organization." },
     // …
   };
   export default enUS;
   ```

   `activity` should match the web drawer's wording for that language.
3. Point the tag at it in `messages/index.ts`, replacing the `TODO(translate)` stand-in.
4. Check the result: `pnpm email:preview -- --locale=<tag>` (or `EMAIL_PREVIEW_LOCALE=<tag>`)
   writes `email-templates/preview/<tag>/`. Only the source-language previews are committed.

## Which language a message uses

Resolved when the message is queued and stored with it (`email_queue.data.locale`), so the subject
and the body agree and a later language change does not rewrite queued mail.

- **Someone with an account:** their stored `users.locale`, through `recipientLocale()`. Null (they
  never chose) means `SOURCE_LOCALE`. Batched mail (daily digest, billing, lifecycle, storage
  warning, invite-accepted, overdue, reminders, mentions, comments, assignments) and push resolve
  this **per recipient**, never once per batch.
- **The account behind the current request** (password reset, welcome, import completed, email
  change code): `accountLocale(stored, req)`, which is the stored choice, else `requestLocale(req)`.
- **No account yet:** signup verification codes use the signup form's `locale` field, else
  `requestLocale(req)`. Board invitations to an address with no account use the **inviter's**
  `requestLocale(req)`. The web app sends its interface language as `Accept-Language`.
- **Tests sent by the person themselves** (SMTP test, push and personal-channel tests):
  `requestLocale(req)`.
- **Weekly admin recap:** the stored locale of the account that owns the configured address, if any.
- **Rows queued before localisation** have no `locale` and render in `SOURCE_LOCALE`.

Staying English on purpose: staff-only mail (`../internal-notification-emails.ts`, ops alerts, the
admin-console invite) and the public inbox API used by MCP and the CLI
(`modules/notifications/inbox.routes.ts`).

## Chat destinations, imports and validation

Shared chat destinations store their own language (`webhook_endpoint.locale`); creation defaults to
`requestLocale(req)`, while existing destinations remain en-GB until changed in Integrations.
Queue payloads snapshot that choice so retries retain their original language. Connection summaries
use the viewing admin's request language. Copy lives in `messages/chat.ts`.

Import warnings are formatted in the commit request's language and saved with the import result;
`messages/imports.ts` owns warnings and failure reasons. User filenames and names stay unchanged.
Validation issue messages use the error catalog for custom refinements and Zod's locale formatters
for built-in checks, without mutating Zod's process-wide locale or changing issue codes/paths.
