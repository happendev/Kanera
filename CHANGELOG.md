# Changelog

All notable changes to Kanera are documented here.

## [Unreleased]

### Added

- **Card dependencies:** mark a card as **blocked by** or **blocking** another card, or simply **related** to it, from the new Dependencies section in card detail (search for the card by title or key). A blocked card shows a **Blocked** chip on its tile until every blocker is completed or archived, and the chip clears live, even when the blocker is on another board in the workspace. Add the **Blocked** quick filter to see only waiting work. If a blocker is on a board you can't open, you still see that the card is blocked, but not what blocks it. Loops (A blocks B blocks A) are refused. AI agents and integrations can do the same with the MCP `cards.set_relations` tool, `kanera card block` / `unblock` / `relate`, and the SDK's `cards.addRelation` / `removeRelation`; `cards.get` returns a card's relations.
  - Set dependencies straight from a card's right-click menu (**Dependencies…**) on the board and in the table, without opening the card.
  - Each dependency shows the other card's labels, assignees, board and list. At the top of card detail, beside the time in progress, chips say plainly whether the card is still blocked ("Blocked by 1 active card") or ready ("No active blockers"), and what it blocks or relates to; click one to jump to the Dependencies list.
  - Each time a blocker is added to a card, its assignees and watchers are notified, and the blocker's watchers hear that it now holds up other work. Each person is told once. When a blocker is reopened or restored and the card is blocked again, its assignees and watchers hear that too. A completed card cannot be added as a blocker, and only someone who can edit a card may mark it as blocked. Turn email, push and personal channels on or off under Profile settings → Notifications ("Card blocked, blocking or ready to start").
  - **Handoff when work is ready:** when the last active blocker on a card is completed, archived or removed, by a person or by an automation, the card's assignees and watchers get one inbox notification, email and push each saying it is ready to start, and the card's activity shows who cleared the last blocker. Whoever closed the blocker isn't notified about their own handoff, and a blocker on a board an assignee can't open is named by key only. The same "Card blocked, blocking or ready to start" setting controls these channels.
  - A card moved to another board keeps its **Blocked** chip for everyone watching that board.
  - The Dependencies section re-reads when a related card is renamed, relabelled, reassigned, moved to another list or board, completed, reopened, archived or deleted, even when that card is on a board you aren't viewing. Archiving a whole list hands off the cards those cards were blocking, exactly as archiving them one by one does.
  - Notifications follow the card's real state: a card that an automation completes the moment it becomes ready is not announced as ready to start, and adding a blocker to a card that is already completed tells nobody. The card's activity still records what happened.
  - **Card blocked automation:** run actions when an active card gains its first open blocker, including reopening or restoring a blocker. MCP subscribers can watch `card.blocked` and `card.unblocked` transitions, including integration, automation and mirrored changes, even without a configured automation rule.
  - A new **Card unblocked** automation trigger runs when someone completes or archives a card's last open blocker. It also runs when the last dependency is removed or an automation clears it, with each dependent processed at most once per transaction to prevent loops.
  - Dependency panels refresh live when blockers complete, reopen or are archived, including changes from the public API. Search scopes and excludes existing links before limiting results, and relationship removal appears in both cards’ histories.
  - Ready-to-start handoffs and automations follow actual blocked-to-ready transitions, including link removal, board/list deletion and mirrored changes. Archiving an already completed blocker does not repeat the handoff.
  - The **Blocked** quick filter is also in Global Work, so you can find held-up work across every board you can see. Agents and integrations get the same with `blockedOnly` on MCP `work.query_cards`, the public API's work query and the SDK's work filters.
  - Dependencies belong to the original cards: copying a card or several cards does not copy them, board exports do not include them, and a mirrored copy starts without them. A dependency added to a mirrored copy is kept, and when the mirror completes or reopens that copy, cards waiting on it are handed off like any other.
  - MCP and CLI dependency batches report successful additions or removals alongside any per-card refusals. If a later operation or the final read fails, including rate limits, the result still names the cards whose dependencies were changed.
  - Dependency and ready-to-start emails and pushes respect current access, including organisation suspension or removal. Cards on archived boards do not run dependency automations or send blocked/ready-to-start handoffs.
  - Notifications and API responses describe a card as it is after the automations a dependency change triggered: a card that a **Card blocked** automation completes is not announced as blocked, and the inbox entry for a card that a **Card unblocked** automation moved opens in its new list. Adding a dependency that already exists is accepted even when that blocker has since been completed.
  - When a mirrored copy's completion or reopening hands off the cards waiting on it, the handoff is recorded as Kanera's and reaches everyone assigned, including the person who set up the mirror. This also applies to downstream handoffs through automation chains.
  - Deleting a list or board while a card is being moved into it still hands off the cards that card was blocking, and a blocked card moved to another board shows its **Blocked** chip there immediately. Relabelling, reassigning or moving two related cards in one bulk action refreshes what each shows about the other.
  - Completing blocked work offers **Cancel** or **Complete anyway**, with an optional **Don’t warn again this session** checkbox. This warning also covers bulk completion and priority queues; API completion remains available without a prompt.
  - **Dependencies view:** a new view on every board, and in My Cards and Team Cards, that maps each blocking chain left to right in steps, so you can see what can start now and what waits on what. Chains follow blockers across boards in the workspace (cards from other boards are outlined dashed), and a board can switch between **This board** and its whole **Workspace**. Counts at the top double as filters: **Blocked**, **At risk** (a blocker is overdue or due after the card it blocks; those links turn amber), **Start here** (unblocked cards other work waits on) and **Ready** (every blocker done). The biggest bottleneck is called out by name. Cards show their labels and the custom fields your board shows on cards; turn on **Slim cards** to see just keys and titles when a map gets big. Hover a card to trace everything up and down its chain, show **Related** links on demand, turn on **Critical path** to highlight the longest run of open work in each chain, switch to **Timeline** to place cards by the week they are due on one calendar shared by every chain, so a week lines up from chain to chain and they scroll sideways together (a blocker due after the card it blocks points backwards in amber, and a dashed line marks weeks with nothing due that were left out), and switch to **Steps** for a numbered list of the same chain: on a wide screen each card's blockers, due date, people and status line up in columns, and on a phone they stack under its title. Search and filters apply, the map updates live, and blockers on boards you can't open are counted without being named. Edit dependencies right on the map: drag from the **+** handle on a card's edge to the card it blocks (or tap the handle, then the card, on a phone or with the keyboard), and select a connector to **Remove** it. Every add or remove can be taken back with **Ctrl+Z** (**⌘Z** on a Mac) and put back with **Ctrl+Shift+Z** (**⌘⇧Z**), or from the Undo and Redo buttons on the toast that confirms it. Cards you can't block, such as ones already upstream, are dimmed while you drag.
  - AI agents and integrations can read the same map: the MCP `cards.dependency_graph` tool answers "what is blocking this card", "what does it unblock" and "what is held up on this board or workspace" in one call, and is also available as `kanera deps`, the SDK's `cards.dependencyGraph` and `POST /api/v1/cards/dependency-graph` in the public API. Each board in the response says whether the caller may change its cards' dependencies (`canEdit`). They see exactly what the person they act for would see: cards on boards that person can't open are only counted, and a workspace key sees nothing outside its workspace.
- **Notification sounds:** choose the original chime, three new gentle Kanera sounds (Ripple, Bloom and Pebble), or None in Profile settings → Notifications.
- **Time in progress:** mark lists as **In progress** and each card in them tracks working time (09:00–17:00 weekdays), shown on the card, in card detail, the table and Work done. Cards in progress too long turn amber, notify their watchers and can trigger automations; admins can correct a card's time.
- **Team overview:** a new Team Cards display with one panel per teammate showing what they have in progress (longest-running first), what they recently worked on, the head of their Up next, their other open cards by due date, and what they finished in the last 7 days. Open, In progress, Overdue and Done 7d counts expand into the full list, in-progress work with no assignee gets its own panel, and quiet teammates fold into one row.
- **React to and comment on uploads:** when someone attaches a file, such as a screenshot of what they've built, the activity row now has a thumbs-up and a Comment button right under it. Comment starts a reply that links the file and mentions whoever uploaded it.
- **Thumbs-up notifications:** when someone gives your comment or uploaded file a thumbs-up, you now get an inbox notification and a push notification. Email is off by default; turn it on under Profile settings → Notifications ("Thumbs-up on your comment or file"). Removing the thumbs-up takes the notification back. Duplicated cards keep the thumbs-ups on their copied files.
- **Kanera speaks your language:** the whole app, including onboarding, boards, cards, notifications, settings, emails and push notifications, is now available in English (US), English (UK), Spanish, Brazilian Portuguese, French, German, Japanese, Dutch, Norwegian Bokmål, Simplified Chinese and Traditional Chinese. Choose a language under Profile settings → Language (or from the sign-in page). It is saved to your account, so every device and every email follows it.

### Changed

- Account settings now have a Security page for two-factor authentication and password changes, and a Preferences page for Card Keys and Scratchpad visibility, with links to both guides.

- Plain text attachments (.txt, .log) now open in the preview viewer like images, PDFs and Markdown instead of downloading.

- Table view on tablets now stays a real table, with column headers and a pinned Title column you scroll sideways from, instead of stacking every row into a card. Only phones stack.
- On phones and tablets the board header keeps New card and the board menu beside the title; Board overview and Watch move into the board menu.
- **Faster boards and global views:** large boards open with less server work, while My Cards and Team Cards refresh around 65% faster with over 40% less API CPU in large-workload benchmarks.
- **More efficient realtime and background processing:** notifications and emails arrive sooner under load, with less repeated work and fewer processing pauses across automations, push delivery, webhooks, daily digests and cleanup.
- **Faster card reads for AI agents:** opening a card with many links (the API's card detail and the MCP `cards.get` tool) no longer slows down while background link repair runs, cutting typical response time from about 24–32 ms to 7 ms in benchmarks.
- Hosted subscription payment analytics are recorded against the organisation creator, so PostHog's first-touch acquisition properties attribute revenue.
- Cards with unread activity now stand out on busy boards: alongside the bold title and dot, the tile gets a faint accent tint and an accent ring.
- Emails now show dates in the recipient's language and its date order, with the month named (for example "12 Oct 2026" in UK English), instead of US month-first order for everyone.
- Tabs left open, or returned to after a while, renew their sign-in just before it lapses instead of first having a request rejected, so counts and priorities refresh in one round-trip.

### Fixed

- Closing a profile while it is still loading no longer causes an Angular error when the response arrives.
- Board mirrors now copy attachments uploaded by guests from another organisation, instead of failing to find the file and retrying the card indefinitely. A card that still can't sync (for example, its source file is gone) stops retrying after about a day and resumes when the source card changes or the mirror is resumed; one broken card no longer holds up the rest of the mirror.
- Emails to reserved test domains (`.test`, `.example`, `example.com` and similar) are no longer sent from production, and a recipient the mail server permanently refuses is marked failed straight away instead of being retried.
- Self-hosted monitoring: Alloy no longer re-sends old container logs that Loki rejects after a restart, and a new alert catches log entries Loki rejects (4xx) or Alloy drops, which the 5xx alert missed.

- Clarified translated card deselection, upcoming deadlines, assignment activity and copied email addresses; corrected Japanese relative time and the French purple colour label.

- Shared chat destinations now have a message language setting. Validation details, import warnings, note draft recovery messages and installed-app descriptions and shortcuts now follow the selected language.

- Deleting a note, board or workspace now removes the files attached to its notes from storage instead of leaving them behind. Files a duplicated note still shows are kept.
- Duplicated cards, duplicated notes and mirrored cards now own their images: inline images in the copy's description, note body, comments and checklist item details point at the copy's own files, so they keep working after the original's attachment or note is deleted. Duplicating a note now copies its attachments too.

- Copy card link now includes the organisation key, so links copied from card detail open the correct card.

- The import wizard now fits narrow screens, and the CSV import names its detected delimiter.
- On phones, pickers and menus (assignees, labels, dates, boards and others) now open right beside the button you tapped instead of at the bottom of the screen, leaving a gap.
- Tapping a push notification on Android now opens the card again, instead of leaving Kanera in the background.
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
