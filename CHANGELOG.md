# Changelog

All notable changes to Kanera are documented here.

## [Unreleased]

### Added

- **Mentions tab in notifications:** once someone has @-mentioned you, the notifications drawer gets a **Mentions** tab (with its unread count) listing every comment that mentions you, read or unread. On phones the drawer's Group, Board and User menus now share one row.
- **Agents filter in card activity:** cards an AI agent has commented on get an **Agents** tab beside All and Comments, showing only the comments and changes connected agents made and how their runs ended.
- **Richer card creation:** the public API, MCP, SDK and CLI accept custom-field values by ID and an external reference in single and bulk card creation. Each card, its values and its reference are saved atomically.

- **Timeline view:** a Gantt-style board view with one bar per card from its start date to its due date, grouped by list, assignee or label. Zoom smoothly from days to years with the zoom buttons, the slider, Ctrl + scroll or a trackpad pinch, **Fit all** to show every scheduled card at once (how the chart opens until you pick a zoom of your own), and drag the chart's background to pan. Each row shows the card's labels in full on a line under its title, so a blocking bug is visible without regrouping; drag the edge of the names column to widen it for long titles (double-click to reset). Drag a bar to reschedule it keeping its working-day length, pull an end to change its length, click an empty lane to place an unscheduled card, and drag from a bar's end onto another card to make it wait on the first. **Critical path** highlights the chain with no slack and shows how far each other card could slip; prerequisites planned to finish after their dependents start are flagged as scheduling conflicts. Keyboard shortcut `7`.
- **My overview:** My Cards has an **Overview** display like Team Cards', for just your own work: what you have in progress and for how long, what you recently touched, the head of your Up next, the rest of your open cards and what you finished in the last 7 days. The stats open each set of cards in full.
- **Timeline on My Cards and Team Cards:** the Timeline view is also a display on My Cards and Team Cards, over every board in scope. Rows group by board until you choose another grouping; dependency wires and the critical path follow chains within each workspace, and a card can be rescheduled or linked wherever you can edit its board.
- **Start dates:** cards can carry a planned start date next to the due date, shown in card detail with the working-day length, in a hidden-by-default **Start date** table column and sort, in exports and activity. A start can never sit after its due date: moving a due date earlier pulls the start along.
- **Automations:** new **Start date arrives**, **Scheduling conflict appears** and **Critical path slips** triggers, and `{{card.startDate}}`, `{{schedule.blocker}}` and `{{schedule.days}}` in comment templates. The scheduling triggers fire once per boundary: a card that gains its first conflict, or a critical-path card whose slip moves the board's projected finish.
- **Planning features on or off:** organisation and workspace admins can switch off **dependencies**, **start dates and the Timeline**, and **time in progress** (Organisation settings and workspace Settings → General, all on by default) for teams that don't need them. A feature that's off disappears everywhere at once, live on open boards, and is closed to MCP, the CLI, SDK and public API too (`DEPENDENCIES_DISABLED`, `TIMELINE_DISABLED`, `IN_PROGRESS_DISABLED`), with its automations and events paused. Nothing is deleted: turning it back on restores relations, start dates and recorded time.
- **AI agents and integrations:** start dates through MCP (`cards.create`, `cards.update`, `cards.bulk_create`, `cards.dependency_graph`), the CLI, SDK and public API; relative dates such as "next Monday" work for starts too. A new **`work.schedule`** tool (`kanera schedule`, `POST /api/v1/cards/schedule`) returns the Timeline's schedule for a board or workspace: planned bars, slack, critical path, conflicts, projected finish and slip against the latest due date. `work.my_day` adds the user's cards with scheduling conflicts and their critical-path cards, Portfolio rollups carry schedule health per board, and agents can subscribe to `schedule.conflict_detected`, `schedule.conflict_resolved` and `schedule.critical_path_slipped` events.
- **Timeline notifications:** assignees hear when a card's start date changes (one notification per edit; a due date that drags the start along names both). A card's assignees and watchers are told once when it first becomes planned to start before one of its blockers finishes, never when the conflict was their own edit, and not again until it clears and recurs; the conflict is also recorded in the card's activity. The daily digest and `work.my_day` list your cards that missed their planned start without going in progress.
- **Example automations reworked:** the automations Examples menu now offers rules real teams run, modelled on the workspace templates and matched to your own list, label and field names: label work by the list it lands in, set a response target for new requests, send finished checklists to review, escalate overdue work, flag stalled or over-estimate work as at risk, move ticked-off cards to Done, and a new **Planning** group for start dates, unblocked work and scheduling conflicts. Examples whose planning feature is switched off are not offered, and an example the workspace cannot build sensibly is shown greyed out with what it needs instead of guessing.
- **In-progress limits for automations:** **Card in progress too long** can use its own limit in hours or days, or a number field such as an estimate, firing when a card's tracked working time passes it (a working day is 8 hours). It fires once per card; raising an estimate runs it again only when the card passes that too. Cards already past the limit when a rule is turned on are skipped unless **Include cards already past the limit** is on.
- **Editor shortcuts:** in descriptions, comments, notes and the scratchpad, Ctrl + backtick toggles inline code on selected text (including keyboards where backtick is a dead key), Ctrl+K inserts or edits a link, and Ctrl+backslash clears inline formatting while preserving text, headings and lists. Command equivalents are also supported on Mac. Strikethrough now stays visible in rendered descriptions, comments and notes after saving.
- **GitHub pull requests on cards:** with the GitHub App connected, a pull request whose branch, title or description names a card key (such as `KAN-123`) appears in that card's new **Pull requests** section and activity, and its state stays current as it moves from draft to open, merged or closed. Pull requests from forks are ignored. **Copy branch name** in card detail and the card menu gives a branch that links itself. Self-hosted deployments set `GITHUB_APP_WEBHOOK_SECRET` and the App's webhook URL (see DEPLOY.md).

### Changed

- **Faster card details:** sections render independently, large collections defer offscreen rendering, and realtime bursts share one offline-cache write. Detail/feed loads are cancellable and deduplicated, unchanged reconnects use conditional requests, and per-card revisions preserve live edits without retrying the initial detail load.

- **Onboarding templates:** lists now start with colors suited to their workflow stages, carried through to workspace and standalone boards.

- **Kanera's own messages:** notifications and card activity from Kanera itself (time-in-progress alerts, automations, scheduling conflicts) now show the Kanera logo mark instead of a generic avatar.

### Fixed

- A card moved into progress outside working hours no longer looks stuck at "<1m": its time-in-progress chip shows a pause icon, card detail says **Paused until** the next working start, and the tooltip explains that only weekday 09:00–17:00 counts. Nothing tracked yet now reads "0m" on the tile and in card detail alike.
- Offline, My Cards and Team Cards now say once that you're looking at a saved copy, in the page's banner, instead of repeating it inside Overview, Timeline, Dependencies and Work done.
- Cards completed by an automation (for example, moving a card to Done) now count as done for their assignees on the My Cards and Team Cards overviews and their Work done timelines, instead of disappearing from **Recently done** and the **Done** count.
- A teammate's change that arrives while you're searching on My Cards or Team Cards now shows up in the overview, Work done and Dependencies straight away, instead of waiting for the next change.
- On a board, a teammate's change made while archived cards, a completed date range or **Clear all** was reloading the board no longer gets reverted on your screen.
- Dragging several selected cards onto **Up next** on My Cards or Team Cards now queues them all where you drop them, in the order the view sorts them, instead of only the card you grabbed.
- The notification read dot now sits in the same spot on every notification, grouped or not, so you can clear the unread list by clicking down it without moving the pointer and accidentally opening a card. The timestamp moves onto the same line, beside the dot.

- **Mark all read** on the notifications Agent tab now clears only agent notifications, leaving the rest of your unread inbox alone.

- Saving unchanged card titles, descriptions, checklist titles/items or custom fields no longer inflates activity change counts or updates saved timestamps. Repeated empty clears are ignored, and unchanged custom fields do not retrigger automations.

- Adding checklist items in quick succession no longer lets an earlier save response erase the next item's draft.

- Deleting a cover attachment hides the card header immediately, with Undo restoring it. Original upload activity now indicates when the attachment has since been deleted.

- **OAuth setup:** malformed authorization and client-registration requests return validation errors instead of internal server errors.

- **Scratchpad:** text you were editing could be replaced by an older copy and the cursor thrown to the end of the page when the scratchpad reloaded in the background (switching back to the tab, or the connection dropping and returning), especially on slow connections or on pages with images.

- **Notifications:** deleting a comment now removes the comment, mention and reaction notifications it produced, instead of leaving an empty "commented" entry in people's inboxes.
- **Offline use:** Timeline, Dependencies, Work done, Team overview and personal or teammate Up next queues retain their last saved data across boards, My Cards, Team Cards, Home and the drawer. Cached content stays readable, with edits, dragging, undo and online-only account/navigation actions disabled until reconnecting. Reconnecting refreshes the data and restores controls. The offline notice no longer blocks taps on the phone account menu.
- Keyboard shortcuts respect open dialogs, Tab stays in search above a card, and E focuses the card title for editing. Navigation sequences no longer consume text after focus changes, and unavailable redo no longer falls through to undo.
- Toolbar and header buttons keep their text labels whenever their row has room, at any screen size, instead of turning icon-only below a fixed width. Space runs out in steps: the board's member avatars compact first, then labels drop one at a time from the end of the row. On a 320px phone every board view now fits on the view switch.


## [1.10.0] - 2026-10-24

Ships alongside **CLI 2.2.0** and **MCP 4.2.0**.

### Added

- **Card dependencies:** link cards as **blocked by**, **blocking** or **related**, including across boards in the same workspace. Manage links from card detail or the right-click menu, see blocked status live, use the **Blocked** filter on boards, My Cards and Team Cards, and see Blocked and At risk counts in the board overview and Portfolio.
  - **Dependencies view:** explore blocking chains across boards with a visual map, Timeline or Steps. Spot bottlenecks, at-risk work and the critical path; add or remove dependencies directly on the map with undo and redo. Works offline from your last saved copy.
  - **Notifications and handoffs:** assignees and watchers hear when work becomes blocked or ready to start, with configurable inbox, email and push notifications.
  - **Automations:** use the new **Card blocked** and **Card unblocked** triggers to act when work gets held up or becomes ready. Completing blocked work shows a warning you can override.
  - **AI agents and integrations:** manage dependencies, query blocking chains and filter blocked work through MCP, the CLI, SDK and public API.
- **Getting started checklist:** a guided checklist on Home that teaches cards, filters, notes, team setup and agents, ticking each step off as you do it. Hide it to your account menu or remove it for good; it retires itself after 35 days. Replaces the old "First steps" card.
- **Notification sounds:** choose the original chime, three new gentle Kanera sounds (Ripple, Bloom and Pebble), or None in Profile settings → Notifications.
- **Time in progress:** mark lists as **In progress** and each card in them tracks working time (09:00–17:00 weekdays), shown on the card, in card detail, the table and Work done. Cards in progress too long turn amber, notify their watchers and can trigger automations; admins can correct a card's time.
- **Team overview:** a new Team Cards display with one panel per teammate showing what they have in progress (longest-running first), what they recently worked on, the head of their Up next, their other open cards by due date, and what they finished in the last 7 days. Open, In progress, Overdue and Done 7d counts expand into the full list, in-progress work with no assignee gets its own panel, and quiet teammates fold into one row.
- **React to and comment on uploads:** when someone attaches a file, such as a screenshot of what they've built, the activity row now has a thumbs-up and a Comment button right under it. Comment starts a reply that links the file and mentions whoever uploaded it.
- **Thumbs-up notifications:** when someone gives your comment or uploaded file a thumbs-up, you now get an inbox notification and a push notification. Email is off by default; turn it on under Profile settings → Notifications ("Thumbs-up on your comment or file"). Removing the thumbs-up takes the notification back. Duplicated cards keep the thumbs-ups on their copied files.
- **Work done report:** Work done has a new **Report** layout on boards, My Cards and Team Cards: a plain-language summary of the period, the key counts with changes against the previous period, a daily flow chart, where open work sits, what needs attention right now with the cards named, activity and workload per person, and breakdowns by workspace, board, label, select field and checklist. Sections appear only when there is something to show.
- **Board counts in workspace settings:** the Boards list in workspace settings now shows, under each board's name, its done share as a thin bar, open and overdue counts, checklist progress, the next due date, when it was last updated and who is on it. The counts respect assigned-only access and match the Portfolio.
- **Date range presets:** the completed-cards, table and Work done date pickers now offer This week, Last week, This month, Last month and Last quarter alongside the Last N days shortcuts.
- **Picker shortcuts:** label, member and select pickers support arrow keys, Home/End and Enter, highlight the text you searched for, and workspace admins can create a missing label straight from the card's label picker.
- **Plan usage meters (hosted):** Account Plan settings show live usage of boards, members or seats, active automations and this month's automation executions against your plan, with a warning as you near a limit.
- **Kanera speaks your language:** the whole app, including onboarding, boards, cards, notifications, settings, emails and push notifications, is now available in English (US), English (UK), Spanish, Brazilian Portuguese, French, German, Japanese, Dutch, Norwegian Bokmål, Simplified Chinese and Traditional Chinese. Choose a language under Profile settings → Language (or from the sign-in page). It is saved to your account, so every device and every email follows it.

### Changed

- **Home:** restructured and showing blocked
- Adding checklist items in card detail now shows in the card's activity. Items you add to one checklist in quick succession are grouped into a single "added N checklist items" entry.

- **Appearance and visual polish:** new Comfortable and Compact density options, theme previews and accent swatches; clearer list icons and colours across calendars, activity and reports; consistent shadows, status tints and drawer motion; and tidier board icons and activity grouping.
- **Performance:** faster boards, tables, card details, global views, navigation, search, notifications and settings, with quicker member menus and fewer requests when returning to an open tab. Sorting, time formatting and progress chips do less repeated work; smaller parallel API query groups limit database contention, while AI-agent reads, realtime delivery and background jobs also run more efficiently.
- **More reliable agent handoffs:** Kanera skills, CLI setup instructions and MCP guidance now make live runs, outcome comments, verification and appropriate list moves part of carrying out a card, including boards with custom workflows.

- Account settings now have a Security page for two-factor authentication and password changes, and a Preferences page for Card Keys and Scratchpad visibility, with links to both guides.

- Plain text attachments (.txt, .log) now open in the preview viewer like images, PDFs and Markdown instead of downloading.

- Table view on tablets now stays a real table, with column headers and a pinned Title column you scroll sideways from, instead of stacking every row into a card. Only phones stack.
- On phones and tablets the board header keeps New card and the board menu beside the title; Board overview and Watch move into the board menu.
- Cards with unread activity now stand out on busy boards: alongside the bold title and dot, the tile gets a faint accent tint and an accent ring.
- Emails now show dates in the recipient's language and its date order, with the month named (for example "12 Oct 2026" in UK English), instead of US month-first order for everyone.

### Fixed

- Reordering inline images in descriptions, comments, notes and scratchpad no longer uploads a duplicate image.
- Calendar tiles no longer cut off the due time beside the card key; assignees sit top right in the label row so the title and its details get the full width.

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
