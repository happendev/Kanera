# Import cards from CSV

Kanera's CSV importer accepts exports from project-management tools and spreadsheets, even when their columns do not match Kanera. Open workspace or board settings, choose **Import**, select **CSV**, and map each source column before anything is created.

## File format and limits

CSV files may use commas, semicolons, tabs, or pipes as the column delimiter. Quoted values may contain delimiters and line breaks. Kanera reads UTF-8, UTF-16 little- or big-endian files, and falls back to Windows-1252 when a file is not valid UTF-8. The analysis preview shows the detected encoding and delimiter so you can re-export the source if they look wrong.

An import is limited to 20 MB, 20,000 rows, and 200 columns. Blank rows are ignored; shorter rows are padded and reported in the preview.

## Map columns

Confirm whether the first row contains headers, then map exactly one column to **Title**. Other columns are optional:

- Card data: description, list or status, due date, completed, archived, and created date.
- Multiple values: labels, assignees, comments, and checklist items.
- Custom fields: text, number, checkbox, select, date, or URL.
- Card ID / group: combine several rows into one card.
- Ignore: leave a source column out of the import.

Mappings are tied to column positions, so repeated headers such as Jira's multiple `Labels` or `Comment` columns remain separate and can all feed the same card property. Choose the separator used inside multi-value cells: comma, semicolon, pipe, or a new line.

When **Card ID / group** is mapped, rows with the same non-empty ID become one card. The first row supplies single-value properties, while labels, assignees, comments, and checklist items accumulate across the grouped rows and across repeated mapped columns. Without a group column, every data row becomes a card.

## Dates and timezones

The importer recognizes ISO dates and timestamps, `YYYY/MM/DD`, `YYYY.MM.DD`, numeric day/month or month/day dates, named months such as `1 Jan 2025` and `Jan 1, 2025`, Jira dates such as `01/Jan/25 1:30 pm`, and Excel serial dates. Two-digit years use 70 as the pivot.

If numeric dates such as `01/02/2025` could mean either 1 February or January 2, choose a day/month order before continuing. Floating dates are interpreted in the browser's timezone. Card due dates are imported as date-only, `anyTime` due dates; the source time of day is not retained.

## Source export hints

- Jira: include Summary, Issue key, Status, Labels, Assignee, Due date, Comments, and any custom fields you need. Repeated Jira columns are supported.
- Asana: export the project as CSV and map Name to Title, Section or Column to List, and Assignee to Assignees.
- Trello: use Trello's JSON export when you need attachment links or uploaded files; use CSV for a simpler cards-only migration.
- Spreadsheets: keep one header row and one card per row unless you deliberately use a Card ID column to group rows.

CSV imports do not include attachments, priority, start dates, or original comment authors. Imported comments are attributed to the person running the import. The import creates a new board in a workspace, or appends cards to the sole board when run from standalone-board settings.
