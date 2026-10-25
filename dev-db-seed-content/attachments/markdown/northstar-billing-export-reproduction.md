# NS-241 — Duplicate invoices in the billing export

Reported by Maya Chen, Northstar operations.

## Reproduce
1. Open an account with two billing contacts in the customer portal.
2. Open Billing → Invoices and select Last month.
3. Download the CSV and filter invoice_number to NS-1048.

Expected: one invoice row, net 1,200.00, tax 240.00, gross 1,440.00 GBP.
Actual: two identical rows, one for each billing contact. Summing the CSV doubles all three totals.

The invoice page and invoice PDF show the correct amount. No duplicate payment was taken.
A single-contact account exports correctly. The issue also reproduces with three contacts.

## Acceptance
- Each invoice number appears once, regardless of contact count.
- CSV net, tax and gross totals match the invoice page for the selected period.
- Customer/contact exports continue to include every contact.
