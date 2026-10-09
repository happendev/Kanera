# Changelog

All notable changes to Kanera are documented here.

## [1.9.0] - Unreleased

### Added
- **Agent Workflow template:** a workspace template with Backlog, Agent Working, Waiting on Me, Review and Done lists. AI agents using the Kanera skill, MCP or CLI move cards through these lists as their runs start, block, resume and succeed, and keep the run summary current.
- **MCP `work.my_day` and CLI `kanera my-day`:** one call returns your overdue, due-this-week, overdue-checklist and stale assigned cards across every board, plus the top of your "Up next" queue.
- **MCP `boards.create` with a template:** pass `templateId` instead of `workspaceId` to create a standalone board seeded from a workspace template, such as Agent Workflow.
- **MCP `my_day.ready` event:** agents can subscribe to a weekday-morning ping, sent at your daily digest hour in your time zone while the digest email is on, and respond by fetching your day with `work.my_day`.
- **Kanera MCP:** when you have not picked a board template, agents now suggest a few that fit and ask which you want, rather than choosing silently.

### Changed
- **Workspace team notes:** every workspace member can now create and edit team notes, not just workspace admins. Board team notes still need board editor access.
- **Hosted Free plan:** AI agents (Claude, ChatGPT, Cursor, the CLI), MCP, and personal API keys are now included, with read and write access to Free-plan boards. Workspace API keys, unattended service agents, and webhooks remain Pro-only. Downgrading to Free now revokes only workspace API keys; personal keys keep working.
- **Public API and MCP rate limits** are now per user, per second and per minute, at the plan limits of the organisation that owns the board being accessed: a Free organisation's boards allow 5 requests per second and 60 per minute by default, a Pro organisation's 20 and 400. A user in both gets each organisation's limits on its own boards. Bursts over the per-second limit wait in a queue of 10 and are served in the following second; requests beyond the queue, or over the per-minute limit, receive `429`.

### Fixed
- **Kanera MCP:** tools declare OAuth scopes and return a reauthorization challenge when a tool encounters an expired or revoked credential. The plugin submission bundle includes the five positive and three negative review cases.
- Concurrency, card transfer access, and realtime consistency issues.

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
