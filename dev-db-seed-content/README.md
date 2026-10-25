# Dev DB Seed Content

This directory contains original software-themed sample attachments and card content for Kanera development.

It also supports the built-in dev seed flow:

```bash
pnpm dev:db:reset:seed
```

That command resets the local development database, reapplies migrations, and seeds one organisation with three populated workspaces, boards, cards, notes, comments, attachments, and card cover images.

## Seeded Login Accounts

These accounts are development-only fixtures. Use the email address as the username. All seeded accounts currently share this password:

```text
Abc12345
```

| Email | Name | Org Role | Workspace Roles |
|---|---|---|---|
| `amelia@kanera.test` | Amelia Hart | `owner` | `Development: owner`, `Marketing: observer`, `DevOps: owner` |
| `marcus@kanera.test` | Marcus Cole | `admin` | `Development: admin`, `Marketing: owner` |
| `priya@kanera.test` | Priya Nair | `member` | `Development: admin`, `DevOps: observer` |
| `ben@kanera.test` | Ben Ortega | `member` | `Development: member`, `Marketing: observer` |
| `nina@kanera.test` | Nina Park | `member` | `Development: member` |
| `zoe@kanera.test` | Zoe Mitchell | `member` | `Development: observer`, `Marketing: admin` |
| `leo@kanera.test` | Leo Santos | `member` | `Marketing: member` |
| `omar@kanera.test` | Omar Ibrahim | `member` | `Development: member`, `DevOps: member` |
| `grace@kanera.test` | Grace Liu | `member` | `Development: observer`, `DevOps: admin` |
| `henry@kanera.test` | Henry Walsh | `member` | `DevOps: member` |

Seeded workspaces:

- `Development Team`
- `Marketing & Creative`
- `DevOps`

Seeded standalone boards (owned by Amelia):

- `Launch Checklist`
- `Northstar — Client Feedback` and `Northstar Internal`: a client-to-internal one-way sync.
- `Customer Portal Revamp`: built from the Agent Workflow template; start actual runs through the application when demonstrating agent work.

## Demonstrating one-way client board sync

The seed adds **Northstar — Client Feedback** and **Northstar Internal**, leaving all
existing boards in place. Launch Checklist and Platform Delivery remain independent, with no
sync between them. Sign in as Amelia to see the new client/internal pair. Maya is the Northstar
contact and can access the client board only; Grace and Nina collaborate there. Priya, Omar,
Ben, Grace and Nina can access the internal board.

Run the API, web and **worker** (`pnpm dev`). The worker performs the initial sync from the
real seeded relationship and then follows future changes. The internal board contains six
synced client cards plus two internal engineering tasks once the initial sync finishes.

| Client list | Internal list |
|---|---|
| New requests | Not synced: still being scoped |
| Approved for development | Backlog |
| In delivery | In Progress |
| Client review | Ready for QA |
| Accepted | Done |

For a recording:

1. Open **Northstar — Client Feedback**. The billing-export bug (NS-241) has a screenshot,
   reproduction notes, an acceptance checklist and a conversation between Maya and Grace.
2. Open its synced copy on **Northstar Internal** to show the same discussion and files.
   The saved-report feature (NS-238) also includes an agreed scope document.
3. Keep the internal copy open, then add a comment or upload a new file on the source in
   another tab. Watch it arrive on the internal copy without copying anything manually.
4. Add an engineering comment on the internal copy. It stays internal; the relationship
   runs from the client board to the delivery board. Source content remains authoritative
   for synced titles, descriptions, lists and other synced content.
5. Move the shared-report request from **New requests** to **Approved for development**
   to bring newly approved work into the internal Backlog.

The mobile-menu bug is waiting for client review, and the invoice-email improvement is
accepted/completed on both sides. The two unsynced discovery requests and two internal-only
engineering tasks make the boundaries visible. The client-board data uses the same demo
organisation; no production account or guest arrangement is needed to demonstrate syncing.
These fixtures work in self-hosted mode and in the hosted demo's Pro plan.
The original screenshot fixture is rendered from `sources/northstar-billing-export.html`.

## Demonstrating notifications

Every seed/reset leaves Amelia's inbox with two overdue cards and the **Build the launch
measurement sheet** conversation: Ben's complete comment, a Campaign field change, and an
assignment. The comment and card changes share the second previous working day, at separate
London clock times. Overdue notices belong to the previous working day. Other fixture history
stays read, so the opening inbox is useful without a burst of new actions or “just now” timestamps.
The dates follow the seed reference date automatically, including weekend and daylight-saving resets.

## Demonstrating Timeline and dependencies

Sign in as Amelia (`amelia@kanera.test`) to see all boards, then choose **Timeline**
in a board's view switch. Dates are relative to the seed/reset date and stay fixed until
the next reset. Dependency handoffs use Monday–Friday working days, including when the
seed runs on a weekend. These fixtures work in both self-hosted and hosted demo seeds.

- **Platform Delivery:** the onboarding QA pass waits on reconnect fixes and attachment
  cleanup. QA starts at B+6 after cleanup finishes at B+5 and is due B+8. Open the QA
  card to see both prerequisites.
- **Autumn Campaign Launch:** explainer video → package approval → launch is a healthy
  three-card chain. Turn on **Dependencies** and **Critical path** to see the wires
  and the work with no slack. Final product messaging is completed: its relationship
  remains visible, while package approval is the launch's one active blocker.
- **Mobile Experience:** upload-progress copy → attachment QA is a healthy same-board
  handoff. The iOS reminder investigation also blocks push-preference controls on
  Platform Delivery, demonstrating a cross-board prerequisite in the shared workspace.
- On **Mobile Experience**, **Prepare tablet layout for board overview** has a start
  without a committed deadline, **Backfill biometric auth telemetry** has a deadline
  without a planned start, and **Prototype swipe actions for list cards** has neither
  date and appears under **Unscheduled**. The first two render as points.
- The completed **Refresh engineering branching guide** still links to **Write migration
  rollback guide for customer imports**, but no longer blocks it. Completed cards have
  historical start/due dates alongside their completion activity. Active implementation
  and review work has already started; future work and overdue work remain visible too.

After experimenting, reset the local fixtures with `pnpm dev:db:reset:seed` to restore the
demonstration (this deletes the local development database).

## Repeatable delivery demo

Calendar screenshot captures select the busiest week from the board's actual active due
dates and verify at least five cards across three days. This keeps reruns focused on
scheduled work when the current month would put the deadlines below the image crop.

The demo seed uses one London reference date for the entire reset. `B+0` is the first
weekday on or after that date; `B+n` skips weekends. `P+n` is the nth weekday strictly
before it. Holidays are deliberately not modelled. All card deadlines are date-only in
`Europe/London`. The review automation still uses **two calendar days** and its existing
end-of-work-day slot; the business-day helper does not change that rule.

For an **empty local development database**, run:

```bash
pnpm db:seed:local --reference-date 2026-10-25
```

Omit `--reference-date` for a fresh reset anchored to the run's start date. This command
refuses a populated database. It is not a live-data migration and does not patch existing
demo tenants. The deployed admin demo reset captures its reference date before purging
its reserved demo tenants. No connected Kanera account is used by local validation.

Seed output includes actual allocated IDs/keys, the complete card-key → offset map and
missing-asset warnings. Original Marketing numbers 1–119 retain their allocation order.
The email-scheduling task is allocated next, followed by the three delivery tasks and the
separate automation rehearsal. No hardcoded live UUID is used.

- Twelve ideas are recoverably archived; all twelve main-organisation boards remain.
- Permanent Marketing work has **111 unarchived cards: 82 active and 29 completed**.
  Card 7 remains incomplete in Waiting on Others: the checked-in review-wall bitmap
  does not supply the final desktop/mobile hero, email header, three social formats
  and partner lockup exports. Verify those assets before completing the card. That
  would produce the intended 81 active / 30 completed result.
- The temporary campaign-overview automation card adds one more active card. Nina is
  its only owner, with no due date, cover or dependencies. A later application move
  to Review must produce Amelia's assignment, the real +2-calendar-day deadline and
  a genuine execution. Nothing pre-seeds a successful automation execution.
- Permanent In Progress work is 14 cards: Ben 3, Grace 2, Leo 3, Nina 2, Omar 1, Zoe 3.
  The temporary automation card is excluded from that total. Ben owns the explainer
  video, as required by the specified WIP and Budget example; this supersedes the
  older fixture's Nina assignment. His three existing active launch cards (5/10/14)
  have planned Budget allocations 600/2400/blank, totalling EUR 3000. The new publishing
  task is separately visible in Ready to Start, with no budget. No EUR 2600 filming edit
  is seeded. The recruitment-brochure allocation remains EUR 2400.
- Queues, Campaign classifications, separators, note schedules and descriptions use
  the same plan. Historical completed classifications and original comments remain;
  editable schedule notes retain their images and links. Budget means planned
  allocation in EUR, not actual spend.
- Separators divide cards between groups; they do not head lists. Marketing has six
  boundaries between groups, and single-group lists have none. Development retains
  its two separators between implementation cards and completed work.
- Work Done's campaign delivery example uses the previous calendar week's Monday–Friday,
  with five completed cards, moves and checklist sign-offs. Screenshot helpers read the
  actual completion dates to select that week, rather than assuming the latest week is
  the example. Move steps are spaced beyond timestamp jitter so their workflow stays ordered.
- Exactly eight active cards are intentionally overdue: MARKETINGC-9, LAUNCHCHEC-1/-2,
  DEVELOPMEN-1/-4/-13 and DEVOPS-1/-13. All other dated active work uses explicit
  B+0…B+15 offsets. Start-only and undated backlog fixtures remain undated.
- Development Billing Hours remain DEVELOPMEN-1 = 12.75 and DEVELOPMEN-11 = 4.5.
  Billing Month and the database-vacuum month name derive from the same reference date.
- Launch Checklist's five open cards belong to Marcus. Its mirror configuration is
  retained and the real worker reconciles ownership from the source; no mirror is
  severed to suppress duplicate-looking work.
- Fresh resets do not manufacture successful agent runs or unread inbox entries.
  Ordinary historical human activity is synthetic fixture content. Genuine Claude
  records are not available in the local source and are never claimed to be imported.
  Create fresh activity and notifications through real application actions.

The complete declared offset tables live in `apps/api/src/scripts/seed-calendar.ts`.
Marketing delivery and reporting specifications live in `seed-demo-enhancements.ts`.
Portfolio's rolling completion window and stored unarchived totals describe different
scopes. Do not force either to the old audit's counts; read both again after reseeding.
Marketing appears first through its authored workspace creation order; its board order
is Launch, Website, Content, Brand, Events, Requests. Existing account-specific sidebar
preferences can still override the default presentation.

## Layout

- `attachments/images`: redistributable JPEG and PNG card-cover fixtures, including generated demo artwork
- `attachments/pdfs`: downloaded PDF files
- `attachments/docx`: downloaded DOCX files
- `attachments/logos`: original SVG logo files
- `avatars/female` and `avatars/male`: generated WebP portraits selected to match each seed user's configured gender

## Redistribution Notes

The checked-in binary attachments and generated avatars are intended to be redistributable sample fixtures. Do not add customer data, private documents, production exports, or third-party files whose redistribution rights are unclear.

Image provenance:

- Generated demo artwork in `attachments/images` is original fixture content created for Kanera.
- `attachments/images/checking-out-venus.jpg`: NASA/JPL-Caltech image PIA21117, "Checking Out Venus".
- `attachments/images/pixls-nightlight.jpg`: NASA/JPL-Caltech image PIA24095, "PIXL's Nightlight".

NASA media is generally usable under NASA's media usage guidelines when used without implying endorsement and with NASA acknowledged as the source.

## Recording Work done

After reseeding, open **Autumn Campaign Launch → Work done**, or choose that board in
**Team Cards → Work done → All boards**. Use the previous calendar week’s Monday–Friday
relative to the seed date (UTC). A reset on October 22, 2026 gives **October 12–16, 2026**.
The range stays fixed until the next seed/reset; it does not advance as you browse.

That board has two visible rows per weekday: one completion plus a checklist tick on
Monday, Tuesday and Thursday, or a card move on Wednesday and Friday. The rest of the
board’s history sits before the recording week. Wednesday, Thursday and Friday’s work
fits together in a desktop screenshot without collapsing days. Select the exact Monday
and Friday endpoints in the picker (Last week also includes the weekend).
Switch to **Report**, then select the same range again to show completions and checklist
progress (switching layouts currently resets the selected period).
Use Amelia's account and All teammates to include the whole cast.

For local development, `pnpm dev:db:reset:seed` recreates the fixtures (and deletes the
local development database). For the deployed demo, deploy this seed change and use the
existing admin demo reset; existing demo data does not change merely by deploying code.
