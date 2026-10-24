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
- `Customer Portal Revamp`: built from the Agent Workflow template, with live Claude agent runs on the cards in Agent Working, Waiting on Me, and Review. Live runs stall 15 minutes after seeding.

## Demonstrating Timeline and dependencies

Sign in as Amelia (`amelia@kanera.test`) to see all boards, then choose **Timeline**
in a board's view switch. Dates are relative to the seed/reset date and stay fixed until
the next reset. Dependency handoffs use Monday–Friday working days, including when the
seed runs on a weekend. These fixtures work in both self-hosted and hosted demo seeds.

- **Platform Delivery:** the onboarding QA pass waits on reconnect fixes and attachment
  cleanup. Cleanup is intentionally planned to finish too late: QA would need to start
  three working days later. The Timeline shows one scheduling conflict; open the QA
  card to see both prerequisites. Move cleanup earlier to demonstrate resolving it.
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
demonstration (this deletes the local development database). The read-only seed regression
test uses its own isolated database: `pnpm test:e2e -- seed-timeline seed-time-tracking`.

## Marketing content handoff

The Core changes from the 24 October 2026 handoff are permanent seed fixtures. The CSV's
audited live UUIDs are not seed identities. The existing 119 card numbers are preserved;
the email-scheduling card is allocated last as card 120 and placed on Autumn Campaign Launch.

- Launch readiness names the actual generated package-approval key. Messaging, graphics and
  schedule are checked (3/4); landing-page tracking remains unchecked. Messaging is signed off,
  and completed graphics sit in Done with their original agent completion and Nina assignment.
- The launch attachment remains available without a card cover. Existing comments and agent
  history are retained. Messaging and schedule checklist ticks use the seed execution timestamp.
- The customer-onboarding email request remains in Ideas & Requests, with no assignee.
  Grace retains 18 Marketing cards and Ben retains 17. The older audit's 18 for Ben assumed
  he owned the explainer; the approved Timeline cast keeps Nina as its owner.
- Marketing budgets remain sparse. Use Platform Delivery's Billing Hours for the numeric demo;
  the existing recruitment-brochure Budget stays 2400. No rehearsal clone is seeded.

Deadlines use the handoff's calendar-day offsets from its 24 October baseline, relative to
the seed's UTC date. They stay fixed until the next seed. All seven are date-only
(`dueDateSlot: null`, `dueDateTimezone: Europe/London`):

| Card | Deadline from seed day |
| --- | --- |
| Prepare the launch-week social schedule (9) | -1 day (overdue) |
| Draft the autumn product-update changelog post (73) | +4 days |
| Assemble the webinar follow-up sequence (91) | +6 days |
| Finalise the campaign tracking and UTM plan (11) | +4 days |
| Approve the customer announcement email (13) | +5 days |
| Schedule the launch-day customer email (120) | +6 days, blocked by card 13 |
| Refresh the customer onboarding email sequence (102) | +2 days |

These are the approved Core edits; the newer Timeline schedule and its other owners/dates are
preserved rather than replaced by the older filming snapshot. The PDF's live-account edits,
temporary automation clone, inline-number filming actions and notification targets are not run
by the seed. Verify the fixtures with `pnpm test:e2e -- seed-marketing seed-timeline seed-time-tracking`.

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
