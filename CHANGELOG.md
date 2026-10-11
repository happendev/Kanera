# Changelog

All notable changes to Kanera are documented here.

## [Unreleased]

### Changed

- Hosted subscription payment analytics are recorded against the organisation creator, so PostHog's first-touch acquisition properties attribute revenue.
- Cards with unread activity now stand out on busy boards: alongside the bold title and dot, the tile gets a faint accent tint and an accent ring.

### Fixed

- Default avatars now pick colours that suit the active theme, so near-black ones no longer vanish on dark themes and pale ones on light themes.
- @mention chips are now clearly tinted in each person's colour, and the palette no longer has near-identical neighbours (blue/indigo, teal/cyan), so different people's mentions are easier to tell apart.

## [1.9.0] - 2026-10-11

Ships alongside **CLI 2.1.0** and **MCP 4.1.0**.

### Added
- **Prebuilt self-host images:** releases publish amd64 and arm64 Docker images and attach a standalone Compose file plus example environment files.
- **Card reminders:** remind yourself about any card from card detail or its right-click menu, with quick picks (in an hour, tomorrow morning, next Monday) or any date and time within 8 weeks. Reminders are private, arrive once as a notification, email, push or personal channel, show as an alarm on the card tile, and are listed on Home. The board filter has a **Reminder set** quick filter, and completing a card clears its reminders.
- **Storage management:** Settings → Organisation → Storage shows usage by card attachments, notes, personal files and workspace. Admins can find large or old files, including those on archived cards, and delete up to 100 at a time. Hosted organisations get a warning email at 80% of their allowance; self-hosted deployments choose local disk or S3 here.
- **User profiles:** click a person's avatar for a profile card with their details and recent activity.
- **Hide Portfolio:** organisation admins can turn Portfolio off for the whole organisation.
- **Organisation AI agent policy (hosted):** admins set agent access to Off, Read only, or Read and write under Settings → Organisation → Security. It covers MCP connections and personal API keys, including board guests.
- **Agent Workflow template:** Backlog, Agent Working, Waiting on Me, Review and Done lists that AI agents move cards through as their runs start, block, resume and finish.
- **My day for agents:** MCP `work.my_day` and CLI `kanera my-day` return your overdue, due-this-week and stale cards across every board plus your "Up next" queue. A weekday-morning `my_day.ready` MCP event lets agents act on it unprompted.
- **Quick capture:** tell an agent "remind me to…" and it adds a task to your scratchpad Inbox (MCP `scratchpad.capture`, CLI `kanera capture`).
- **Reminders and watching for agents:** MCP `cards.set_reminder`, `cards.set_watching`, `reminders.list` and a `reminder.due` event, with matching CLI commands, SDK methods and public API routes.
- **Bulk card creation:** MCP `cards.bulk_create` (public API, SDK) creates up to 50 cards in one validated call. `workspaces.create` and `boards.create_standalone` accept seed `cards`, and `boards.create` can start a standalone board from a template.
- **Notification inbox for polling agents:** MCP `notifications.list` (CLI `kanera inbox`, SDK `cards.pollNotifications`) lets a local agent pick up replies and @mentions without a webhook.
- **Attachments for agents:** agents can read images and text-based attachments (`cards.get_attachment`) and upload local files through a single-use link (`cards.create_upload_link`, CLI `kanera card upload-link`).
- **Natural dates for agents:** MCP accepts "tomorrow 1pm" or "next friday", resolved in your time zone.
- **Copyable MCP setup snippets** for Claude Code, Cursor, VS Code / Copilot, Codex and Gemini CLI under Settings → API Keys.

### Changed
- Web bundle size warnings allow room for growth; Angular retains higher error limits, while compressed-size budgets are advisory.
- **Free plan includes AI agents:** Claude, ChatGPT, Cursor, the CLI, MCP and personal API keys now work on Free-plan boards. Workspace API keys, service agents and webhooks remain Pro-only.
- **Per-user API rate limits** apply per second and per minute at the plan of the organisation that owns the board, with a short queue for bursts.
- **You follow your AI agent's work:** cards an agent creates for you are watched automatically, and its activity reaches you as "You via Claude".
- **Leaner MCP:** the tool catalog is a fifth smaller, read-only connections see only read tools, and unknown fields now fail loudly instead of being ignored.
- **Settings reorganised** into **Your account** and **Organisation** tabs; old links still work.
- **Workspace team notes** can be edited by every workspace member.
- **Faster app:** fewer database queries, renders and transport round trips.

### Fixed
- Editor freezes, note saving, and Global Work refresh regressions.
- Organisation invitations could bypass mandatory MFA.
- Subscription handling for late cancellations, with reconciliation.
- Angular concurrency, state sync, invitation, due-date, realtime and integration bugs.
- Cards showing checkbox custom fields incorrectly.
- MCP tools now return a reauthorization challenge on expired or revoked credentials.

## [1.8.0] - 2026-10-07

Ships alongside **CLI 2.0.0** and **MCP 4.0.0**.

### Added
- **MCP:** MCP 2 and MCP events support, batch operations, a list event, a priority-changed event, and updated tools.
- **CLI:** OAuth login flow and an update check.
- Board Overview, replacing Board Health.
- Separators can be added between cards, the same way as new cards.
- More email notification triggers.
- A settings toggle for Notes.
- Better PWA install support.
- Build information shown for both hosted and self-hosted deployments.

### Changed
- Navigation menu has a clearer hierarchy. Guests with access to only one board get a simpler menu without the workspace level.
- Mobile cleanup: keyboard shortcuts are hidden on touch devices, and panels and attachment buttons are tidier.
- Table view: improvements to tabs, saving, and data processing.
- Board setup page puts groups at the bottom.
- Cancelling OAuth now asks for explicit confirmation.
- Mirror icons are updated across components.
- Node.js and service images are updated to the latest patch versions.

### Fixed
- Card-to-card links now work correctly; broken links show a toast.
- The comment editor places the cursor in the right position.
- Pinch-to-zoom works in the lightbox on mobile.
- Notification counts are accurate and aligned correctly.
- Pages no longer flicker on reload when you return to the tab.
- Card actions render above cover media.
- CLI auth route and Angular build warnings are fixed.

### Internal
- E2E test suite with parallel CI shards and reliability fixes.
- Lint cleanups and general project cleanup.

## [1.7.0] - 2026-09-10

### Added
- **Undo** support.
- **Themes:** new themes, accent colours, and theme sync.
- AI agent attribution and new automations.
- Command palette quick actions.
- Calendar: drag and drop to change dates.
- Board: add a new card between existing cards; drag and drop several selected cards to other lists.
- Board background and a compress-cards button.
- Table: sticky header.
- Drag and drop boards in the navigation.
- Leave a board.
- Forms autosave and warn about unsaved work.
- Toasts for bulk actions.
- MCP: separator control.

### Changed
- UX: empty states, loading states, menu primitives, focus trapping, panel positions, and contrast are more consistent.
- Keyboard shortcuts and background colours are refined, and Settings now uses tabs.
- Home page update and better mobile responsiveness.
- Toast system is consolidated, and the toast and notification panel load lazily.
- Shared date formatting.
- Note options are decluttered; the scratchpad and Up Next are tidier.
- Seed data tweaks; demo data no longer counts toward stats.

### Performance
- Faster board API queries, card rendering, and dragging.
- Table loading performance.
- Memory retention fixes.

### Fixed
- Security: SSRF and authorisation fixes.
- Budget limits, admin theme, and offline cache are fixed.
- Separators that aren't needed are hidden while searching or filtering.
- Up Next has an empty state and a loading state.
- New cards in Global Work get their assignee filled in.
- The notification drawer returns focus when it closes.
- The MCP registry description is shorter.
