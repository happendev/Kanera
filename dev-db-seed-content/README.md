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

## Layout

- `attachments/images`: downloaded JPEG files
- `attachments/pdfs`: downloaded PDF files
- `attachments/docx`: downloaded DOCX files
- `attachments/logos`: original SVG logo files

## Redistribution Notes

The checked-in binary attachments are intended to be redistributable sample fixtures. Do not add customer data, private documents, production exports, or third-party files whose redistribution rights are unclear.

Image provenance:

- `attachments/images/checking-out-venus.jpg`: NASA/JPL-Caltech image PIA21117, "Checking Out Venus".
- `attachments/images/pixls-nightlight.jpg`: NASA/JPL-Caltech image PIA24095, "PIXL's Nightlight".

NASA media is generally usable under NASA's media usage guidelines when used without implying endorsement and with NASA acknowledged as the source.
