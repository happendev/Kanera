# NS-238 — Personal saved report views

Northstar operations reviews regional accounts every Monday. Each lead currently rebuilds
region, account status and visible-column filters before the meeting.

## Agreed first release
- Save the current region, account-status filters and column selection under a personal name.
- Reopen a saved view from Reports; show the active name beside the filters.
- Keep date ranges relative: Last week must use the current previous week when reopened.
- Rename/delete your own views and reset to the default report.
- Enforce existing account visibility when loading any view.

## Acceptance example
Maya saves “North region — active accounts” with Region=North, Status=Active and the
Account reference, Owner and Balance columns. Reopening it next Monday restores that
selection with fresh data for Last week.

Shared views and permissions for editing another person's view are outside this release.
Grace confirmed this scope with Maya before approval for development.
