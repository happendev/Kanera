# Kanera PostHog guide for Marketing

Last verified against the implementation: 4 August 2026  
Event contract version: `1` for versioned events

This is the handoff for building Kanera dashboards, funnels, cohorts, and campaign reporting in PostHog. It documents what is emitted today, what every property means, how events should be counted, and the caveats that can otherwise create misleading results.

## The question this instrumentation is designed to answer

> Are users failing to upgrade because they have not experienced enough value, or because they do not understand the reason to pay?

The commercial journey is measured in four stages:

1. **Value experienced:** `meaningful_work_created`, `collaboration_started`, and `premium_feature_used`.
2. **A reason to pay appears:** `premium_feature_attempted`, `plan_limit_reached`, `upgrade_modal_viewed`, and `downgrade_impact_viewed`.
3. **The offer is considered:** `pricing_viewed_in_app`, `upgrade_modal_dismissed`, and `checkout_started`.
4. **The commercial outcome:** `checkout_abandoned`, `subscription_started`, `trial_converted`, `subscription_payment_succeeded`, and `subscription_cancelled`.

## Read this before building reports

### Use the `organization` group for B2B funnels

Every server event is linked to a PostHog group of type `organization`. Authenticated browser events are also linked to the signed-in user's organization.

Use **unique `organization` groups**, rather than unique persons, for:

- invitation and collaboration funnels;
- trial, paywall, pricing, checkout, and subscription funnels;
- account conversion, retention, and churn reporting.

This matters because the person who creates an invitation is not the person who accepts it, and the server-authoritative checkout and subscription events use an organization identity. A person-level funnel will therefore break valid journeys. PostHog documents this setup in [Group analytics](https://posthog.com/docs/product-analytics/group-analytics#using-groups-in-posthog) and its general funnel controls in [Funnels](https://posthog.com/docs/product-analytics/funnels#how-to-create-a-funnel).

Use person-level reporting only where the individual journey is the question, especially `registration_started` to `registration_completed`.

### Browser and server events have different coverage

| Capture path | Events | Reliability and coverage |
| --- | --- | --- |
| Browser | `$pageview`, signup start, import start, limit/paywall, pricing, downgrade impact | Requires analytics consent. Ad blockers, browser shutdown, or consent refusal can reduce counts. Runs only in the hosted production web app, not localhost or self-hosted deployments. |
| Server | Completed signup, creation, milestones, invitations, trial, checkout, premium use, subscription, revenue, cancellation | Captured after the authoritative write or Stripe event. Does not depend on browser consent. Runs only in hosted production or staging when analytics is enabled. |

All analytics is suppressed for support sessions and organizations marked as excluded from analytics. Product writes never fail because PostHog is unavailable.

Server events do not currently include an environment property. If staging uses the same PostHog project key as production, its server events cannot be cleanly separated in a standard event-property filter. Keep staging in a separate PostHog project or exclude its organizations from analytics.

### Three pairs are compatibility aliases, not separate funnel steps

| Current event | Legacy event emitted at the same boundary | Guidance |
| --- | --- | --- |
| `trial_activated` | `trial_started` | Use `trial_activated` in new reporting. Never put both in one funnel. |
| `checkout_started` | `subscription_checkout_created` | Use `checkout_started` in new reporting. Never add the event totals together. |
| `pricing_viewed_in_app` | `upgrade_page_viewed` | Use `pricing_viewed_in_app`; it has the useful plan, trial, and source context. |

In addition, `premium_feature_attempted`, `plan_limit_reached`, `plan_limit_warning_seen`, and `upgrade_modal_viewed` are emitted together from one immutable usage snapshot when a blocking upgrade prompt opens. They describe different interpretations of the same moment, not four sequential steps. Do not place all four consecutively in a funnel.

## Event catalog

### Acquisition and signup

| Event | Trigger | Properties | Notes |
| --- | --- | --- | --- |
| `registration_started` | A valid signup form is submitted in the browser, before the signup API request. Deduplicated in the page session and against the marketing-site cookie. | `anonymous_id`, `source`, `medium`, `campaign`, `landing_page`, `event_version` | Consent-dependent. Not emitted if PostHog has no anonymous ID. |
| `registration_completed` | The user and organization have been committed successfully by the server. | `user_id`, `source`, `medium`, `campaign`, `event_version` | Server-authoritative. Includes invite acceptances that create a new user. |
| `trial_activated` | A new hosted organization is created outside an invitation flow. | `workspace_id`, `plan_code`, `billing_period`, `event_version` | `workspace_id` is the organization ID here. Emitted at the same time as `trial_started`. |
| `trial_started` | Same committed signup boundary as `trial_activated`. | `workspace_id`, `plan_code`, `billing_period`, `event_version` | Legacy alias. |

Acquisition values use the first available source in this order: Kanera marketing cookie, signup-page UTM parameter, referring hostname, then a direct/default value. Defaults are `source = direct`, `medium = none`, and `campaign = none`. `landing_page` is available on `registration_started` only.

### Workspace, board, card, import, and activation

| Event | Trigger | Properties | Notes |
| --- | --- | --- | --- |
| `workspace_created` | A workspace has been committed successfully. | `user_id`, `workspace_id`, `plan_code`, `event_version` | Server-authoritative. |
| `board_created` | A board has been committed successfully, including the initial board created with a workspace. | `user_id`, `workspace_id`, `board_count_band`, `event_version` | `board_count_band` is the active board count inside that workspace after creation. |
| `card_created` | A non-replayed card creation has committed through the web app, public API, or official MCP client. | `user_id`, `workspace_id`, `creation_source`, `event_version` | System-created board-mirror copies do not emit it. |
| `import_started` | A user submits a selected Trello or Kanera board file for analysis in the browser. | `import_source` | Consent-dependent. The type allows `csv` and `other`; the current import UI emits `trello` or `kanera`. |
| `board_imported` | The imported board and its contents have committed successfully. | `user_id`, `workspace_id`, `import_source_category`, `event_version` | Server-authoritative. Current routes emit `trello` or `kanera`; `csv` and `other` remain recognized categories. |
| `meaningful_work_created` | A workspace reaches three real created cards for the first time. | `workspace_id`, `threshold_version`, `days_since_signup`, `event_version` | Durable once per workspace. Imported, public API, and MCP cards count. Starter-template seeds and system mirror copies do not. Current threshold is `three_real_cards_v1`. |

### Invitations and collaboration

| Event | Trigger | Properties | Notes |
| --- | --- | --- | --- |
| `member_invited` | A qualifying workspace, multi-workspace, or organization-wide invitation is created. | `workspace_id`, `member_count_band`, `days_since_signup`, `event_version` | One event per invitation, not one per workspace. No event is emitted when the invitation grants no collaboration scope. |
| `invitation_accepted` | An invitation or guest invitation is accepted. | `workspace_id`, `member_count_band`, `days_since_signup`, `event_version` | Directly adding an existing member is not an invitation acceptance. Build this funnel by organization, not person. |
| `collaboration_started` | Two distinct human users perform approved work in the same workspace during the same rolling seven-day window. | `workspace_id`, `active_member_band`, `days_since_signup`, `event_version` | Durable once per workspace. Approved work includes card creation, movement, completion, attachment addition, and comment creation. Template seeds do not count. |

For `member_invited` and `invitation_accepted`, `workspace_id` is a real workspace ID for a single-workspace invitation. For multi-workspace or organization-wide invitations it is the organization ID so the invitation still produces only one event.

### Value, limits, and upgrade education

| Event | Trigger | Properties | Notes |
| --- | --- | --- | --- |
| `premium_feature_used` | A committed Pro/trial-only action succeeds. | `workspace_id`, `premium_feature`, `plan_code`, `current_usage`, `event_version` | Server-authoritative. Free-plan attempts are excluded. This is a repeatable usage event, not a once-only milestone. |
| `premium_feature_attempted` | A free or trial user attempts an action that opens the blocking upgrade prompt. | All limit-context properties, plus `premium_feature` | Same moment as `plan_limit_reached` and `upgrade_modal_viewed`. Best general event for attempted demand by feature. |
| `plan_limit_reached` | The blocking upgrade prompt opens for an attempted action. | All limit-context properties | Best event for cap-pressure reporting. |
| `plan_limit_warning_seen` | The same blocking upgrade prompt opens. | All limit-context properties | Currently not a separate pre-limit warning; treat as a compatibility interpretation of the same hard-limit moment. |
| `upgrade_modal_viewed` | The blocking upgrade prompt opens and is rendered. | All limit-context properties, plus `premium_feature` | Use for modal response rates. |
| `upgrade_modal_dismissed` | The user closes, escapes, clicks the backdrop, chooses “Stay free,” or acknowledges a non-owner prompt. | All limit-context properties, plus `premium_feature` | Not emitted when an eligible admin clicks through to review Pro/pricing. |
| `pricing_viewed_in_app` | The Account Plan page initializes with plan data. | `plan_code`, `trial_days_remaining`, `upgrade_source` | Current `upgrade_source` is `account_plan`. Emitted with legacy `upgrade_page_viewed`. |
| `upgrade_page_viewed` | Same page initialization as `pricing_viewed_in_app`. | `source_surface` | Legacy event; `source_surface` is always `account_settings`. |
| `downgrade_impact_viewed` | An organization admin with 10 or fewer trial days sees a non-empty downgrade preview on Home. | `affected_board_count`, `affected_member_count`, `affected_feature_count`, `trial_days_remaining`, `upgrade_source` | `upgrade_source` is `home`. No event is emitted if the preview has no affected items. |

`premium_feature_used` is currently wired to these successful value moments:

| `premium_feature` | Successful action measured | `current_usage` |
| --- | --- | --- |
| `boards` | Creating a board after organization-wide active boards exceed the free allowance | Organization-wide active board count |
| `members` | Accepting an invitation after active organization members exceed the free allowance | Active organization member count |
| `automation_rules` | Creating/enabling rules after enabled organization rules exceed the free allowance | Enabled organization rule count |
| `guests` | Adding or inviting a cross-organization guest | `1` |
| `api` | Creating a personal or workspace API key | `1` |
| `integrations` | Creating a webhook or chat destination | `1` |
| `automation_executions` | Reserved premium-feature vocabulary | No successful-use capture is currently wired; limit attempts are tracked. |

### Checkout, trial outcome, subscription, and revenue

| Event | Trigger | Properties | Notes |
| --- | --- | --- | --- |
| `checkout_started` | The server successfully creates a Stripe Checkout session with a URL. | `workspace_id`, `plan_code`, `billing_period`, `seat_band`, `upgrade_source`, `event_version` | Organization-scoped. `workspace_id` is the organization ID; `plan_code` is `pro`; `upgrade_source` is `account_plan`. |
| `subscription_checkout_created` | Same Stripe session creation boundary as `checkout_started`. | `workspace_id`, `plan_code`, `billing_period`, `seat_band`, `event_version` | Legacy alias. |
| `checkout_abandoned` | Stripe reports `checkout.session.expired`. | `workspace_id`, `plan_code`, `billing_period`, `seat_band`, `upgrade_source`, `event_version` | Delayed until Stripe expires the session; it is not an immediate browser-close event. Deduplicated by Stripe event ID. |
| `subscription_started` | Stripe first moves an organization into an active paid subscription. | `workspace_id`, `plan_code`, `billing_period`, `seat_band`, `currency`, `event_version` | Durable/idempotent for a subscription lifecycle. A later win-back after cancellation emits a new start. |
| `trial_converted` | `subscription_started` occurs while the previous Kanera billing state was trialing. | `workspace_id`, `plan_code`, `billing_period`, `event_version` | Emitted alongside `subscription_started`. |
| `trial_ended` | The trial expiry sweep reverts an unconverted trial to free. | `workspace_id`, `plan_code`, `cancellation_category`, `event_version` | `workspace_id` is the organization ID. Category is `trial_expired`. Durable once per trial. |
| `subscription_payment_succeeded` | A positive Stripe subscription invoice is paid. | `workspace_id`, `plan_code`, `billing_period`, `seat_band`, `revenue`, `currency`, `billing_reason`, `event_version` | Includes initial, renewal, update/proration, and threshold invoices. Deduplicated by Stripe event ID. |
| `subscription_cancelled` | A previously paid subscription reaches a terminal canceled state. | `workspace_id`, `plan_code`, `cancellation_category`, `tenure_band`, `event_version` | Scheduled cancellation is measured when cancellation becomes effective, not when it is requested. |

## Property dictionary

### Limit context

Every limit event carries the same usage snapshot:

| Property | Type | Meaning |
| --- | --- | --- |
| `limit_type` | enum | The blocked capability: `members`, `boards`, `automation_rules`, `automation_executions`, `guests`, `api`, or `integrations`. |
| `current_usage` | number | Usage immediately before the attempted action. For binary Pro-only features it is normally `0`; for usage-capped features it is the authoritative count. |
| `plan_limit` | number | The numeric allowance for the current plan. Binary Pro-only gates intentionally use `0`. |
| `member_count` | number | Organization members that have not been removed, including suspended members. |
| `active_member_count` | number | Organization members that have neither been removed nor suspended. |
| `board_count` | number | Active, non-archived boards across the organization. |
| `trial_days_remaining` | number | Whole days remaining, rounded up and floored at `0`. It is `0` outside an active trial. |
| `upgrade_source` | enum | UI surface that opened or displayed the upgrade journey: `home`, `app_shell`, `workspace_settings`, `organisation_users`, or `account_plan`. |

`premium_feature` uses the same vocabulary as `limit_type`. On attempted/view/dismiss events, the two properties should match.

### Plans and billing

| Property | Values / unit | Meaning |
| --- | --- | --- |
| `plan_code` | `free`, `pro_trial`, `pro` | Effective commercial plan at the event boundary. `past_due` is categorized as `pro`. |
| `billing_period` | `monthly`, `annual`, `not_selected` | Chosen Stripe interval, or no interval yet. |
| `seat_band` | `1`, `2_4`, `5_10`, `over_10` | Purchased/requested seat quantity bucket. |
| `revenue` | integer in minor currency units | Stripe amount paid. For example, `14500` with `currency = EUR` means EUR 145.00. Never sum different currencies together. |
| `currency` | uppercase currency code | For example `EUR`. |
| `billing_reason` | `subscription_create`, `subscription_cycle`, `subscription_update`, `subscription_threshold`, `other` | Why Stripe generated the paid invoice. |
| `cancellation_category` | `trial_expired`, `customer_requested`, `payment_disputed`, `payment_failed`, `other` | Normalized trial/subscription terminal reason. |
| `tenure_band` | `under_30d`, `30_89d`, `90_179d`, `180_364d`, `365d_plus` | Paid tenure at terminal cancellation. |

### Counts, sources, and timing

| Property | Values / unit | Meaning |
| --- | --- | --- |
| `board_count_band` | `0`, `1`, `2_3`, `4_10`, `11_plus` | Active boards in the workspace after board creation. |
| `member_count_band` | `0`, `1`, `2_3`, `4_10`, `11_plus` | Active people in the resolved invitation scope after the event. |
| `active_member_band` | `0`, `1`, `2_3`, `4_10`, `11_plus` | Distinct human collaborators in the qualifying rolling seven-day window. |
| `days_since_signup` | whole days | Full elapsed days since organization signup, floored at zero. |
| `creation_source` | `web`, `public_api`, `mcp` | Channel that created the card. |
| `import_source`, `import_source_category` | `trello`, `kanera`, `csv`, `other` | Import type selected or successfully committed. |
| `source`, `medium`, `campaign` | bounded strings | Signup acquisition attribution. Missing values use `direct`, `none`, and `none`. |
| `landing_page` | path | Initial marketing/signup landing path; available only on `registration_started`. |
| `event_version` | currently `1` | Contract version. Present on all server events and `registration_started`; not currently attached to other browser events. |

### IDs and scope

| Property / identity | Meaning |
| --- | --- |
| `user_id` | Kanera user UUID responsible for the server event. Product reports should normally use PostHog person identity rather than filtering on this raw property. |
| `anonymous_id` | PostHog anonymous browser identity at signup start. PostHog identification after signup links the anonymous and authenticated journey when browser analytics is available. |
| `workspace_id` | Usually the Kanera workspace UUID. For organization-scoped commercial events, trials, personal API keys, and multi-workspace/org-wide invitations, it intentionally contains the organization UUID. Use the PostHog `organization` group as the stable account scope. |
| PostHog distinct ID | User ID for most user-driven events; `organization:<organization-id>` for server commercial lifecycle events. This is why commercial funnels must aggregate by `organization`. |

## Pageviews and profiles

### `$pageview`

Kanera uses manual, privacy-safe pageviews. Each event includes:

| Property | Meaning |
| --- | --- |
| `route_pattern` | A route template such as `/b/:boardId`, not a real entity ID or query string. Card routes are also templated. |
| `page_category` | `authentication`, `onboarding`, `workspace`, `board`, `team`, `settings`, or `billing`. |
| `is_authenticated` | Whether the route is considered authenticated. |

Board pageviews made by cross-organization guests are explicitly assigned to the organization that owns the board. Raw URLs, entity IDs, and search query strings are not sent.

### Person profile

After authentication and consent, the person profile may contain:

- `name`
- `email`
- PostHog initial/current UTM properties and referring domain

Names and emails are allowed only on the person profile, not on ordinary product events.

PostHog may show the corresponding provider event as `$identify`. It is identity plumbing, not a product action, and should not be used as a funnel step.

### Organization profile

The browser currently populates:

- `deployment_mode = cloud`
- `name`
- `owner_name`, `owner_email`, and `owner_user_id` when an owner session is available

The analytics contract also permits `plan`, `billing_interval`, `trial_status`, `member_count_band`, `workspace_age_band`, and `has_imported_board`, but the current application does not populate those organization-profile fields. Do not build reports that depend on them yet; use event properties instead.

PostHog may show organization updates as `$groupidentify`. This is profile enrichment, not a Kanera product action.

## Recommended dashboards and funnels

### 1. Acquisition to first value

Use two connected views because the first event has no organization yet:

- **Person funnel:** `registration_started` → `registration_completed`.
- **Organization funnel:** `registration_completed` → `workspace_created` → `board_created` → `meaningful_work_created`.

Break down by `source`, `medium`, or `campaign`. Use a 14-day conversion window for first-value reporting, then compare 1-day, 3-day, 7-day, and 14-day conversion.

Useful companion trends:

- median `days_since_signup` on `meaningful_work_created`;
- `card_created` by `creation_source`;
- `board_created` by `board_count_band`;
- `import_started` → `board_imported` → `meaningful_work_created`, with the first two broken down by their import-source property.

### 2. Team activation

Build an organization funnel:

`member_invited` → `invitation_accepted` → `collaboration_started`

Use a 14- or 30-day conversion window. Break down invitation trends by `member_count_band`, and monitor median `days_since_signup` for all three events.

### 3. Trial value to paid conversion

Build an organization funnel using only one event from each moment:

`trial_activated` → `premium_feature_used` → `premium_feature_attempted` → `pricing_viewed_in_app` → `checkout_started` → `subscription_started`

`premium_feature_used` and `premium_feature_attempted` are not mandatory for every valid customer journey, so also keep shorter funnels:

- `trial_activated` → `meaningful_work_created` → `subscription_started`
- `trial_activated` → `collaboration_started` → `subscription_started`
- `trial_activated` → `pricing_viewed_in_app` → `checkout_started` → `subscription_started`

Break down by `premium_feature`, `limit_type`, `upgrade_source`, `trial_days_remaining`, `billing_period`, and `seat_band`. Start with a 30-day conversion window so the full trial can mature.

### 4. Paywall comprehension and urgency

Create these organization-level rates:

- **Pricing click-through:** organizations with `pricing_viewed_in_app` after `upgrade_modal_viewed` / organizations with `upgrade_modal_viewed`.
- **Dismissal:** organizations with `upgrade_modal_dismissed` / organizations with `upgrade_modal_viewed`.
- **Checkout intent:** organizations with `checkout_started` after `pricing_viewed_in_app` / organizations with `pricing_viewed_in_app`.
- **Purchase:** organizations with `subscription_started` after `checkout_started` / organizations with `checkout_started`.

Break all four down by `limit_type` or `premium_feature`, and use `upgrade_source` where it is present. Do not use `plan_limit_warning_seen`, `plan_limit_reached`, and `upgrade_modal_viewed` as sequential steps because they currently share a timestamp and trigger.

### 5. Checkout and revenue

Use an organization funnel:

`checkout_started` → `subscription_started`

Track `checkout_abandoned` as a separate outcome trend, not as a mandatory funnel step. It is delayed until Stripe session expiry, and an organization can abandon one session but later start another.

For revenue:

- trend the sum of `revenue` on `subscription_payment_succeeded`;
- filter or split by `currency` before converting minor units;
- break down by `billing_reason`, `billing_period`, and `seat_band`;
- use `subscription_started` for new logos, not invoice count.

### 6. Trial expiry and churn

Use organization trends for:

- `trial_converted` versus `trial_ended`;
- `downgrade_impact_viewed` → `pricing_viewed_in_app` → `subscription_started`;
- `subscription_cancelled` by `cancellation_category` and `tenure_band`;
- win-backs: a new `subscription_started` after `subscription_cancelled`.

## Interpreting the core question

| Observed organization behavior | Most likely diagnosis | What to investigate |
| --- | --- | --- |
| No `meaningful_work_created`, `collaboration_started`, or `premium_feature_used` before trial end | Insufficient value experienced | Onboarding, time-to-first-board/card, import completion, and collaboration setup |
| Value milestone occurs, but no `premium_feature_attempted`, `plan_limit_reached`, or pricing view | Value exists but no upgrade urgency or feature discovery | Limit placement, discovery of premium capabilities, trial reminders |
| `premium_feature_attempted` / modal view occurs, then dismissal with no pricing view | Reason to pay or buyer path may be unclear | Modal message, relevance by feature, admin authority, value proof, price preview |
| Pricing is viewed but checkout is not started | Price, packaging, seat quantity, or buying authority friction | Billing-period and seat-band patterns; owner versus non-owner journey |
| Checkout starts and later expires | Checkout or payment friction | Billing interval, seat band, Stripe completion flow, retry behavior |
| Repeated `premium_feature_used` followed by paid conversion | Users understand and repeatedly receive premium value | Identify the premium features most predictive of conversion and retention |

Treat these as hypotheses to test, not automatic causal conclusions. Compare cohorts and inspect conversion timing before changing messaging or packaging.

## Suggested first PostHog board

Create one board named **Marketing — Acquisition, Value & Upgrade** with:

1. Signup completion funnel by `source`.
2. Registration-to-meaningful-work organization funnel.
3. Import completion and imported-work activation.
4. Invitation-to-collaboration organization funnel.
5. Trial value-to-paid funnel.
6. Premium feature use: unique organizations and total events by `premium_feature`.
7. Limit demand: unique organizations by `limit_type` and `upgrade_source`.
8. Upgrade modal pricing click-through and dismissal rates.
9. Pricing-to-checkout-to-subscription funnel.
10. Checkout abandonment by `billing_period` and `seat_band`.
11. New subscription count and paid invoice revenue, split by currency.
12. Trial outcomes and subscription cancellation reasons.

For `premium_feature_used`, show both **unique organizations** (reach) and **total events** (frequency). The event is intentionally repeatable, so total count alone will overrepresent heavy users.

## Data-quality and privacy caveats

- Browser event totals will be lower than server totals because browser capture requires consent and can be blocked. Do not interpret that difference as product drop-off by itself.
- `registration_started` may be absent for a valid `registration_completed` event. Build completion metrics with that expected coverage gap in mind.
- `checkout_abandoned` is a Stripe expiry signal, not a real-time “closed checkout tab” signal.
- Binary feature gates (`guests`, `api`, and `integrations`) intentionally report `plan_limit = 0`; their `current_usage` can also be `0` on the attempted-action snapshot.
- New reports should filter versioned events to `event_version = 1` unless a later contract version is deliberately being compared.
- Product event allowlists prevent card titles, descriptions, comments, board/workspace names, attachment data, search queries, raw URLs, and tokens from being sent.
- Autocapture, session recording, heatmaps, surveys, automatic pageviews, page-leave capture, exception capture, and performance capture are disabled.
- IP capture is disabled and Do Not Track is respected.
- Marketing may see names and emails on identified person/organization profiles; those fields are not present on ordinary product events and should be handled as personal data.

## Implementation sources

The authoritative event contracts are:

- Browser events: `apps/web/src/app/core/analytics/analytics-events.ts`
- Browser privacy allowlist: `apps/web/src/app/core/analytics/analytics-property-sanitizer.ts`
- Browser capture/privacy configuration: `apps/web/src/app/core/analytics/analytics.service.ts`
- Upgrade prompt capture boundary: `apps/web/src/app/shared/upgrade-prompt.service.ts`
- Server events and property allowlist: `apps/api/src/lib/product-analytics.ts`
- Activation/collaboration milestones: `apps/api/src/lib/analytics-milestones.ts`
- Checkout/subscription/Stripe events: `apps/api/src/lib/billing.ts`

If an event or property is changed, this guide and the corresponding PostHog dashboard definitions should be updated in the same release.
