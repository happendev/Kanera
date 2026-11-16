# Release notes

Each Kanera release has one Markdown file here. These files are the source of the public
changelog at <https://www.kanera.app/changelog> and of the GitHub release description, so write
them for people who use Kanera, not for people who build it. `CHANGELOG.md` stays the complete,
technical record; a release note is the edited story of the same release, with screenshots.

```text
release-notes/
  unreleased.md          the next release, written as work lands
  1.11.0.md              one file per published release
  media/1.11.0/*.jpg     screenshots used by that release
```

`pnpm release` refuses to run while `unreleased.md` is missing or invalid. It stamps the chosen
version and today's date into the front matter, renames the file to `<version>.md`, moves
`media/unreleased/` to `media/<version>/`, and commits them with the version bump. Check every
note at any time with:

```bash
pnpm release-notes:check
```

## Format

```markdown
---
title: Timeline, start dates and a one-command install
summary: One sentence for search results, feeds and link previews.
shipsWith: CLI 2.3.0, MCP 4.3.0
---

![The Timeline view grouped by list, with the critical path highlighted](media/1.11.0/timeline.jpg "wide")

The lead: two or three short paragraphs about the most important change.

## Plan by date on the Timeline

![Alt text describing exactly what the screenshot shows](media/1.11.0/timeline-conflict.jpg "medium")

Paragraphs about one highlight. Use **bold** for the names of buttons, menus and settings.

## New features

- [Timeline] A Gantt-style board view with drag-to-reschedule

## Improvements

- [Performance] Card activity opens faster on busy boards

## Bug fixes

- [Cards] Undo after Archive all cards restores the cards

## Self-hosting

- The web app now listens on `127.0.0.1:4200`; set `WEB_BIND_PORT` before upgrading if that port is taken.
```

Front matter:

| Key | Required | Notes |
| --- | --- | --- |
| `title` | yes | The release's headline, in sentence case, naming its biggest changes. |
| `summary` | yes | One plain sentence, at most 200 characters. |
| `version` | published notes | Written by `pnpm release`; leave it out of `unreleased.md`. |
| `date` | published notes | `YYYY-MM-DD`, written by `pnpm release`. |
| `shipsWith` | no | Independently versioned packages released alongside, such as `CLI 2.3.0, MCP 4.3.0`. |

Body:

- Text before the first `##` heading is the lead. Every other `##` heading starts a highlight,
  except the reserved list headings **New features**, **Improvements**, **Bug fixes** and
  **Self-hosting**, which must come after the highlights in that order. Each is optional, but a
  note needs a lead or at least one highlight, and at least one list item.
- List items are one line each, start with an area in square brackets, and say what changed in at
  most about 15 words. Reuse an area below where one fits.
- **Self-hosting** is for operators: new required settings, changed ports, manual upgrade steps.
  Its items have no area. A self-hosted deployment can skip several releases, so say exactly what
  to do.
- Inline formatting is limited to `**bold**`, `` `code` `` and `[links](https://...)`.
- An image is a paragraph of its own: `![alt](media/<version>/<file>.jpg "size")`, placed
  directly under the lead's start or a highlight heading. `size` is `wide` (full width),
  `medium` (most screenshots) or `compact` (tall panels, menus and phone captures).

Areas: Boards, Cards, Table, Calendar, Timeline, Dependencies, My Cards, Team Cards, Home,
Up next, Work done, Notifications, Comments, Notes, Scratchpad, Automations, Reporting, Import,
Integrations, AI agents, MCP, CLI, SDK, API, Organisations, Members, Guests, Security, Settings,
Billing, Self-hosting, Mobile, Offline, Performance, Languages, Appearance, Onboarding, Editor.

## Writing

- UK English, second person, plain and specific: say what changed, where to find it and what it
  does for the reader. No marketing adjectives ("powerful", "seamless", "blazing").
- Every claim must match the product as released. Check the code or the docs before writing it.
- Mark Kanera Cloud-only features with "On Kanera Cloud," and self-hosting-only ones with
  "Self-hosted deployments". Leave out internal tooling, admin portals, analytics and test-only
  changes.

## Screenshots

Screenshots must be real captures of the product (see the Kanera-site capture scripts and its
`AGENTS.md`), in dark mode, without development banners, tooltips or private data. Use JPEG,
at the capture scripts' default scale. Screenshots are optional: use up to four, only where seeing the feature helps.
Alt text describes what the screenshot visibly shows. The site converts them to responsive
AVIF and WebP with content-hashed names, so a recaptured image never serves stale.
