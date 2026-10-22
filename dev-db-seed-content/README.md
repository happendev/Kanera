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

- `Development`
- `Marketing`
- `DevOps`

Seeded standalone boards (owned by Amelia):

- `Launch Checklist`
- `Customer Portal Revamp`: built from the Agent Workflow template, with live Claude agent runs on the cards in Agent Working, Waiting on Me, and Review. Live runs stall 15 minutes after seeding.

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
