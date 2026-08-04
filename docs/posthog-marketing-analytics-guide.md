# Kanera PostHog analytics guide

**Audience:** Marketing, Growth, Product, and Revenue Operations
**Implementation snapshot:** 4 August 2026
**Event schema version:** `1` where `event_version` is present

This is the source-of-truth handoff for the product analytics currently emitted by Kanera. It explains what each event means, which properties are available, how identity and organisation grouping work, and how to assemble reliable PostHog dashboards and funnels.

The main question this instrumentation is designed to answer is:

> Are users failing to upgrade because they have not experienced enough value, or because they do not understand the reason to pay?

## Read this first

1. Use **organisation** as the aggregation unit for B2B activation, trial, upgrade, subscription, and revenue reporting. Kanera attaches authenticated events to the PostHog group type `organization`. Use person aggregation for the anonymous `registration_started` step.
2. Treat **server events as authoritative**. They do not depend on browser consent and only fire after the corresponding product or Stripe write succeeds.
3. Treat **browser events as directional**. They require analytics consent, so their absolute counts will be lower than server-authoritative counts.
4. Use the canonical events in new reporting:
   - `trial_activated`, not `trial_started`
   - `checkout_started`, not `subscription_checkout_created`
   - `pricing_viewed_in_app`, not `upgrade_page_viewed`
5. Do not place `premium_feature_attempted`, `plan_limit_warning_seen`, `plan_limit_reached`, and `upgrade_modal_viewed` as consecutive funnel steps. They are currently emitted together from the same blocked-action/modal impression.

PostHog recommends starting funnels with the simplest required path and avoiding optional steps that would exclude valid conversions. See the official [funnels guide](https://posthog.com/docs/product-analytics/funnels#how-to-create-a-funnel). PostHog [group analytics](https://posthog.com/docs/product-analytics/group-analytics#using-groups-in-posthog) is the relevant aggregation model for organisation-level onboarding and conversion.

## Measurement model

### Collection channels

| Channel | Meaning | Consent dependency | Best use |
|---|---|---:|---|
| Server | Captured after a committed API, database, milestone, or Stripe webhook boundary | No browser consent dependency | Activation, collaboration, premium value, checkout, subscription, and revenue truth |
| Browser | Captured from a visible page or user interaction | Requires analytics consent | Intent, friction, paywall comprehension, modal response, and navigation |

Both channels are active only for the hosted product. Browser collection is production-only. Server collection is enabled in hosted staging and production when PostHog is configured.

Analytics is suppressed for support sessions and for organisations marked `analyticsExcluded`. Product actions remain successful if PostHog is unavailable.

### Identity and organisation grouping

| Data | Implementation |
|---|---|
| Authenticated person ID | Kanera user ID |
| Anonymous acquisition ID | PostHog browser distinct ID, copied into `registration_started.anonymous_id` |
| Group type | `organization` |
| Group key | Kanera organisation/client ID |
| Behavioural event distinct ID | Usually the acting Kanera user ID |
| Commercial lifecycle distinct ID | `organization:<organisation-id>` |

All server events include the organisation group. Authenticated browser sessions call `group("organization", organizationId)`, so subsequent browser events are also associated with the organisation.

Board page views made by cross-organisation guests are explicitly grouped to the organisation that owns the board, rather than the guest's home organisation.

**Important:** a person-level funnel will not reliably join user-distinct behavioural events to organisation-distinct commercial events. For example, `premium_feature_used` is normally attached to an acting user, while `checkout_started` and `subscription_started` use the organisation as their distinct ID. Use `organization` group aggregation for end-to-end commercial funnels. PostHog group analytics is a paid PostHog capability; if it is unavailable, use HogQL grouped by the event's organisation group key instead.

### Common PostHog event envelope

In addition to the business properties listed later, PostHog events retain a small provider-managed envelope:

| Property | Use |
|---|---|
| `distinct_id` | Person or organisation lifecycle identity described above |
| `$groups.organization` | Organisation group key on authenticated/grouped events |
| `$current_url` | Origin plus privacy-safe route template, without entity IDs or query strings |
| `$device_id`, `$session_id`, `$window_id` | Pseudonymous browser/session continuity when PostHog supplies them |
| `$lib`, `$lib_version` | Capturing SDK metadata |
| `$insert_id`, `$time`, `$sent_at` | Provider ingestion, ordering, and deduplication metadata |

Server events set `$process_person_profile` to `false`: they join already identified browser users and organisation groups without creating or enriching person profiles on their own. Treat the provider envelope as operational context, not part of the versioned Kanera business-event contract.

### Person properties

The identified PostHog person profile may contain:

| Property | Meaning |
|---|---|
| `name` | User display name |
| `email` | User email address |
| `$initial_utm_source`, `$initial_utm_medium`, `$initial_utm_campaign`, `$initial_utm_content`, `$initial_utm_term` | First-touch attribution supplied by PostHog when available |
| `$utm_source`, `$utm_medium`, `$utm_campaign`, `$utm_content`, `$utm_term` | Current/latest attribution supplied by PostHog when available |
| `$initial_referring_domain`, `$referring_domain` | Referrer attribution supplied by PostHog when available |

Names and emails are restricted to identified person profiles. They are stripped from ordinary product events.

PostHog may show SDK protocol events such as `$identify` and `$groupidentify` while maintaining these profiles. They are identity plumbing, not Kanera product outcomes, and should not be used as dashboard or funnel steps.

### Organisation group properties

The app currently populates these properties on the `organization` group:

| Property | Meaning |
|---|---|
| `deployment_mode` | Always `cloud` for captured hosted-app groups |
| `name` | Organisation name; also makes group reports readable in PostHog |
| `owner_name` | Organisation owner's display name, populated from an owner session |
| `owner_email` | Organisation owner's email, populated from an owner session |
| `owner_user_id` | Organisation owner's Kanera user ID, populated from an owner session |

The analytics contract also reserves `plan`, `billing_interval`, `trial_status`, `member_count_band`, `workspace_age_band`, and `has_imported_board`, but the application does **not currently populate them on group profiles**. Do not build dashboards that depend on those reserved fields until their emission is implemented and verified in PostHog.

## Canonical event catalog

There are 31 captured product/navigation event names: 20 server events, 10 custom browser events, and manual `$pageview`.

### Acquisition and registration

| Event | Channel | Fires when | Properties | Notes |
|---|---|---|---|---|
| `registration_started` | Browser | A locally valid signup form is submitted for the first time in that page instance | `anonymous_id`, `source`, `medium`, `campaign`, `landing_page`, `event_version` | Consent-dependent. A cross-site marketing cookie can suppress a duplicate event already captured before the user reached the app. |
| `registration_completed` | Server | The user and organisation/invitation signup transaction has committed | `user_id`, `source`, `medium`, `campaign`, `event_version` | Includes both new-organisation signup and invite-based registration. This is the authoritative completed-signup event. |

Acquisition fallbacks are:

| Property | Resolution order |
|---|---|
| `source` | Marketing attribution cookie → `utm_source` → referring hostname → `direct` |
| `medium` | Marketing attribution cookie → `utm_medium` → `referral` when a referrer exists → `none` |
| `campaign` | Marketing attribution cookie → `utm_campaign` → `none` |
| `landing_page` | Marketing attribution cookie → current path |

UTM values read directly on signup are limited to 120 characters. `landing_page` is available on `registration_started`, but not on `registration_completed`.

### Workspace, board, import, and work creation

| Event | Channel | Fires when | Properties | Notes |
|---|---|---|---|---|
| `workspace_created` | Server | A workspace creation has committed | `user_id`, `workspace_id`, `plan_code`, `event_version` | A workspace can also create an initial board, which produces its own `board_created`. |
| `board_created` | Server | A board creation has committed | `user_id`, `workspace_id`, `board_count_band`, `event_version` | Includes an initial board created with a workspace. `board_count_band` is the active board count in that workspace after creation. |
| `card_created` | Server | A card is successfully created through the normal web, public API, or official MCP path | `user_id`, `workspace_id`, `creation_source`, `event_version` | Imported cards and system-created board-mirror copies do not each emit this event. Cross-organisation guest work is attributed to the board-owning organisation. |
| `import_started` | Browser | A Trello, Kanera, or supported import submission begins | `import_source` | Intent signal; it can be followed by failure or abandonment. |
| `board_imported` | Server | A Trello or Kanera board import finishes successfully | `user_id`, `workspace_id`, `import_source_category`, `event_version` | Authoritative import completion. Imported cards can still contribute to `meaningful_work_created`. |
| `meaningful_work_created` | Server | A workspace reaches three real cards for the first time | `workspace_id`, `threshold_version`, `days_since_signup`, `event_version` | Durable once-per-workspace milestone. Current threshold is `three_real_cards_v1`. Includes web, import, public API, and MCP cards; excludes starter-template seeds and mirror copies. |

### Invitations and collaboration

| Event | Channel | Fires when | Properties | Notes |
|---|---|---|---|---|
| `member_invited` | Server | A collaboration invitation is created | `workspace_id`, `member_count_band`, `days_since_signup`, `event_version` | One event per invitation scope, not one per workspace. Directly adding an existing member is not an invitation. |
| `invitation_accepted` | Server | An invitation or guest invitation is accepted | `workspace_id`, `member_count_band`, `days_since_signup`, `event_version` | Direct member additions do not emit this event. |
| `collaboration_started` | Server | At least two distinct users perform qualifying work in the same workspace within a rolling seven-day window | `workspace_id`, `active_member_band`, `days_since_signup`, `event_version` | Durable once-per-workspace milestone. Qualifying activity includes card create/move/complete/attachment and comment creation; starter-template activity is excluded. |

For `member_invited` and `invitation_accepted`, `workspace_id` has scope-sensitive semantics:

- A single-workspace invitation contains the actual workspace ID.
- A multi-workspace or organisation-wide invitation contains the organisation ID so that one invitation creates one event.

### Trial lifecycle

| Event | Channel | Fires when | Properties | Notes |
|---|---|---|---|---|
| `trial_activated` | Server | A new hosted organisation signup commits and its internal Pro trial begins | `workspace_id`, `plan_code`, `billing_period`, `event_version` | Canonical trial-entry event. Not emitted for a user registering through an invitation. Despite the field name, `workspace_id` contains the organisation ID. |
| `trial_started` | Server | The same boundary as `trial_activated` | `workspace_id`, `plan_code`, `billing_period`, `event_version` | Legacy alias retained for continuity. Do not use both aliases as separate funnel steps or add their counts together. |
| `trial_converted` | Server | A paid subscription starts while the organisation's previous billing state was trialing | `workspace_id`, `plan_code`, `billing_period`, `event_version` | Emitted with `subscription_started`. One conversion event for the committed transition. |
| `trial_ended` | Server | The expiry sweep changes an unconverted internal trial to Free | `workspace_id`, `plan_code`, `cancellation_category`, `event_version` | Durable once per organisation. `plan_code` is `pro_trial`; `cancellation_category` is `trial_expired`. |

At trial activation, `plan_code` is `pro_trial` and `billing_period` is `not_selected`.

### Premium value and plan-limit intent

| Event | Channel | Fires when | Properties | Notes |
|---|---|---|---|---|
| `premium_feature_used` | Server | A premium feature action has committed for a trial or paid organisation | `workspace_id`, `premium_feature`, `plan_code`, `current_usage`, `event_version` | The main authoritative **value experienced** signal. It is deliberately not emitted for Free blocked attempts. |
| `premium_feature_attempted` | Browser | A non-paid user attempts an action that opens the upgrade prompt | `premium_feature` plus all limit-context properties | The main **value sought but blocked** signal. Consent-dependent. |
| `plan_limit_warning_seen` | Browser | The blocked-action upgrade prompt opens | All limit-context properties | Currently the same impression as `plan_limit_reached`; it is not an earlier warning threshold. |
| `plan_limit_reached` | Browser | The blocked-action upgrade prompt opens | All limit-context properties | Indicates an enforced gate, not merely high usage. |

#### Instrumented `premium_feature_used` actions

| `premium_feature` | Committed action currently measured | `current_usage` |
|---|---|---:|
| `boards` | An active board is created and the organisation's board total is above the Free allowance | Organisation active-board total |
| `members` | An invitation is accepted and active organisation members are above the Free allowance | Active organisation-member total |
| `automation_rules` | An enabled automation is created/enabled and the organisation's enabled-rule total is above the Free allowance | Enabled automation total |
| `guests` | A paid guest collaboration grant/invitation is created or applied | `1` unless a caller supplies another usage value |
| `api` | A personal or workspace API key is created | `1` |
| `integrations` | A webhook or chat destination is created | `1` |

`automation_executions` is a valid premium feature value for blocked browser attempts, but successful premium automation executions are **not currently emitted as `premium_feature_used`**. Treat that as a known measurement gap.

### Upgrade journey

| Event | Channel | Fires when | Properties | Notes |
|---|---|---|---|---|
| `upgrade_modal_viewed` | Browser | A blocked action opens the upgrade prompt | `premium_feature` plus all limit-context properties | Same impression and property snapshot as attempted/reached/warning. |
| `upgrade_modal_dismissed` | Browser | The user explicitly dismisses the open upgrade prompt | `premium_feature` plus all limit-context properties | Clicking through to Account Plan closes the dialog but does not count as dismissal. |
| `pricing_viewed_in_app` | Browser | The Account Plan page component loads | `plan_code`, `trial_days_remaining`, `upgrade_source` | Canonical in-app pricing view. Currently `upgrade_source` is always `account_plan` on this event. |
| `upgrade_page_viewed` | Browser | The same Account Plan page component loads | `source_surface` | Legacy alias retained for continuity. `source_surface` is always `account_settings`. |
| `downgrade_impact_viewed` | Browser | The Home page shows a trial downgrade preview with at least one affected board, member, or feature | `affected_board_count`, `affected_member_count`, `affected_feature_count`, `trial_days_remaining`, `upgrade_source` | Not emitted when the preview has zero total impact. `upgrade_source` is `home`. |

The upgrade modal can currently originate from these surfaces:

| `upgrade_source` | Surface |
|---|---|
| `home` | Home page board/workspace creation gate and trial downgrade preview |
| `app_shell` | App-shell workspace or standalone-board creation gate |
| `workspace_settings` | Workspace board, automation, guest, API, or integration settings |
| `organisation_users` | Organisation member invitation gate |
| `account_plan` | Account Plan pricing and checkout surface |

`upgrade_source` describes the local surface that emitted each event; it is not persisted as a cross-step attribution value. In particular, `pricing_viewed_in_app` and `checkout_started` currently report `account_plan`, even if an earlier modal was opened from `home` or `workspace_settings`. When breaking down a funnel by source, use the **first upgrade-intent step's** `upgrade_source`.

### Checkout, subscription, and revenue

| Event | Channel | Fires when | Properties | Notes |
|---|---|---|---|---|
| `checkout_started` | Server | Stripe returns a valid hosted Checkout URL after the organisation chooses billing period and seats | `workspace_id`, `plan_code`, `billing_period`, `seat_band`, `upgrade_source`, `event_version` | Canonical checkout-entry event. Server-authoritative and emitted before redirect. `upgrade_source` is currently `account_plan`. |
| `subscription_checkout_created` | Server | The same boundary as `checkout_started` | `workspace_id`, `plan_code`, `billing_period`, `seat_band`, `event_version` | Legacy alias retained for continuity. Do not add its count to `checkout_started`. |
| `checkout_abandoned` | Server | Stripe reports `checkout.session.expired` | `workspace_id`, `plan_code`, `billing_period`, `seat_band`, `upgrade_source`, `event_version` | Delayed abandonment signal, not an immediate cancel-button or browser-close signal. Stripe event IDs prevent duplicate capture. |
| `subscription_started` | Server | Stripe first confirms the organisation in an active paid subscription state | `workspace_id`, `plan_code`, `billing_period`, `seat_band`, `currency`, `event_version` | Durable for the current subscription. After a completed cancellation, a later win-back can emit a fresh start. |
| `subscription_payment_succeeded` | Server | A positive subscription invoice is paid | `workspace_id`, `plan_code`, `billing_period`, `seat_band`, `revenue`, `currency`, `billing_reason`, `event_version` | Includes initial payments, renewals, and positive prorations. `revenue` is in the currency's minor unit, such as cents. |
| `subscription_cancelled` | Server | Stripe confirms a previously paid subscription has reached the canceled state | `workspace_id`, `plan_code`, `cancellation_category`, `tenure_band`, `event_version` | A request to cancel at period end is not counted until the subscription actually becomes canceled. |

Commercial events use `workspace_id` for the organisation/client ID because billing is organisation-scoped.

### Navigation

| Event | Channel | Fires when | Properties | Notes |
|---|---|---|---|---|
| `$pageview` | Browser | A tracked Angular route is viewed | `route_pattern`, `page_category`, `is_authenticated` | Manual, privacy-safe page view. Raw entity IDs and query strings are not sent. Board/card pages wait for authorised data so guest views are grouped to the board owner's organisation. |

`page_category` values are:

| Value | Route meaning |
|---|---|
| `authentication` | Login, signup, password recovery, reset, and board-invite routes |
| `onboarding` | Onboarding |
| `workspace` | Home, global work, notes, and other workspace-level routes not assigned below |
| `board` | Board and board-card routes |
| `team` | Member and guest settings |
| `settings` | Non-team, non-billing settings |
| `billing` | The root `/settings` route or any route pattern containing `billing` |

`route_pattern` contains templates such as `/b/:boardId`, `/b/:boardId/c/:cardId`, `/my-cards`, and `/w/:workspaceId/settings/automations`, never a raw customer entity ID or query string.

The current Account Plan route is `/settings/account-plan`, so its `$pageview.page_category` is `settings`, not `billing`. Use `pricing_viewed_in_app` for pricing-page reporting rather than relying on the page category.

## Property dictionary

### Limit-context contract

Every `premium_feature_attempted`, `plan_limit_warning_seen`, `plan_limit_reached`, `upgrade_modal_viewed`, and `upgrade_modal_dismissed` event contains the following snapshot:

| Property | Type | Meaning |
|---|---|---|
| `limit_type` | enum | The constrained resource: `members`, `boards`, `automation_rules`, `automation_executions`, `guests`, `api`, or `integrations` |
| `current_usage` | integer | Usage at the moment of the blocked action |
| `plan_limit` | integer | The effective entitlement limit at that moment; use this value rather than hard-coding plan limits in a dashboard |
| `member_count` | integer | Organisation members not removed, including suspended members |
| `active_member_count` | integer | Organisation members who are neither removed nor suspended |
| `board_count` | integer | Active, non-archived boards across active, non-archived organisation workspaces |
| `trial_days_remaining` | integer | Whole days remaining, rounded up and floored at `0` |
| `upgrade_source` | enum | `home`, `app_shell`, `workspace_settings`, `organisation_users`, or `account_plan` |

The five events share one immutable snapshot for a given modal interaction, preventing usage totals from drifting between the attempted action and the impression/dismissal events.

For qualitative gates such as guests, API, and integrations, `plan_limit` is currently `0`; `current_usage` generally falls back to the same limit unless a caller supplies a more specific value. Use `limit_type` and `premium_feature` for those analyses rather than interpreting a `0 / 0` ratio as consumption.

### Enumerations and bands

| Property | Values |
|---|---|
| `plan_code` | `free`, `pro_trial`, `pro` |
| `billing_period` | `monthly`, `annual`, `not_selected` |
| `creation_source` | `web`, `public_api`, `mcp` |
| `import_source` / `import_source_category` | `trello`, `kanera`, `csv`, `other` |
| `premium_feature` / `limit_type` | `members`, `boards`, `automation_rules`, `automation_executions`, `guests`, `api`, `integrations` |
| `billing_reason` | `subscription_create`, `subscription_cycle`, `subscription_update`, `subscription_threshold`, `other` |
| `cancellation_category` for paid subscriptions | `customer_requested`, `payment_disputed`, `payment_failed`, `other` |
| `cancellation_category` for trial expiry | `trial_expired` |

Count-band definitions:

| Band property | Buckets |
|---|---|
| `board_count_band`, `member_count_band`, `active_member_band` | `0`, `1`, `2_3`, `4_10`, `11_plus` |
| `seat_band` | `1`, `2_4`, `5_10`, `over_10` |
| `tenure_band` | `under_30d`, `30_89d`, `90_179d`, `180_364d`, `365d_plus` |

### Remaining event properties

| Property | Meaning |
|---|---|
| `user_id` | Acting/registered Kanera user ID; duplicated as an explicit event property for analysis |
| `workspace_id` | Normally a Kanera workspace ID; for organisation-scoped invites and all commercial events it contains the organisation ID |
| `days_since_signup` | Full elapsed days from organisation creation to the event |
| `threshold_version` | Versioned activation definition; currently `three_real_cards_v1` |
| `affected_board_count` | Boards identified by the trial downgrade preview |
| `affected_member_count` | Members identified by the trial downgrade preview |
| `affected_feature_count` | Premium feature categories identified by the trial downgrade preview |
| `currency` | Uppercase ISO currency code, for example `EUR` or `USD` |
| `revenue` | Paid invoice amount in the currency's minor unit |
| `event_version` | Analytics contract version; currently `1` |

## Recommended funnels

Build the following as **organisation-group funnels** unless the recipe explicitly says person-level. The anonymous registration-start event is the exception because it occurs before an organisation group is known.

### 1. Acquisition to first value

Build two connected views:

- Person funnel: `registration_started` → `registration_completed`
- Organisation funnel: `registration_completed` → `workspace_created` → `meaningful_work_created`

- Use a 14- or 30-day conversion window.
- Break down either registration event by `source`, `medium`, or `campaign`.
- The person funnel depends on browser consent and PostHog's anonymous-to-identified person merge. The organisation funnel is server-only.
- Treat `meaningful_work_created` as the primary activation outcome.

### 2. Activated workspace to collaboration

`workspace_created` → `meaningful_work_created` → `member_invited` → `collaboration_started`

- A strict funnel may omit `member_invited`, because collaborators can be added through routes that are not invitations.
- Recommended primary version: `workspace_created` → `meaningful_work_created` → `collaboration_started`.
- Use `member_invited` and `invitation_accepted` as supporting trends and invite sub-funnels.

### 3. Trial value to paid conversion

`trial_activated` → `premium_feature_used` → `checkout_started` → `subscription_started`

- `premium_feature_used` is optional in a strict conversion funnel because a customer can buy before using a premium-only action. Keep two versions: one with the value step and one without it.
- Break down `premium_feature_used` by `premium_feature`.
- Compare organisations that did and did not record `meaningful_work_created` or `collaboration_started` before checkout.

### 4. Limit pressure to conversion

`premium_feature_attempted` → `pricing_viewed_in_app` → `checkout_started` → `subscription_started`

- Break down the first step by `limit_type`, `upgrade_source`, `current_usage`, or `trial_days_remaining`.
- Do not add `plan_limit_reached` and `upgrade_modal_viewed` between the first and pricing steps; they currently represent the same impression.
- Add a companion trend for `upgrade_modal_dismissed / upgrade_modal_viewed`.

### 5. Checkout completion

`checkout_started` → `subscription_started`

- Break down by `billing_period` and `seat_band`.
- Track `checkout_abandoned` separately as an explicit Stripe-expiry outcome.
- Do not calculate abandonment only as `checkout_started - subscription_started`: open sessions may still convert, and expired sessions can be followed by a later successful checkout.

### 6. Invite acceptance

`member_invited` → `invitation_accepted` → `collaboration_started`

- Use a 14- or 30-day window.
- Analyse organisation-wide/multi-workspace invitations separately if needed by comparing whether `workspace_id` equals the organisation group key in HogQL.

## Dashboard blueprint

### Dashboard A: Acquisition and activation

| Insight | Definition |
|---|---|
| Completed registrations | Unique organisations with `registration_completed`, weekly |
| Registration completion | `registration_started` → `registration_completed`, by `source` and `campaign` |
| Workspace creation rate | `registration_completed` → `workspace_created` |
| Meaningful work rate | `workspace_created` → `meaningful_work_created` |
| Median time to value | Time from `registration_completed` or `workspace_created` to `meaningful_work_created` |
| Activation by creation path | `card_created` trend broken down by `creation_source` plus `board_imported` trend by `import_source_category` |

### Dashboard B: Value versus monetisation

| Insight | Definition |
|---|---|
| Trial cohort size | Unique organisations with `trial_activated` |
| Core-value activation | Share reaching `meaningful_work_created` during trial |
| Collaborative activation | Share reaching `collaboration_started` during trial |
| Premium value experienced | Share with `premium_feature_used`, broken down by `premium_feature` |
| Premium value sought | `premium_feature_attempted`, broken down by `limit_type` and `upgrade_source` |
| Trial conversion | `trial_activated` → `subscription_started`; validate with `trial_converted` trend |
| Trial expiry | Unique organisations with `trial_ended` |

### Dashboard C: Upgrade comprehension and friction

| Insight | Definition |
|---|---|
| Blocked actions | `premium_feature_attempted` by `limit_type` |
| Modal dismissal rate | Unique organisations with `upgrade_modal_dismissed` divided by those with `upgrade_modal_viewed` |
| Pricing click-through | `premium_feature_attempted` → `pricing_viewed_in_app` |
| Pricing-to-checkout | `pricing_viewed_in_app` → `checkout_started` |
| Limit-to-paid | `premium_feature_attempted` → `subscription_started` |
| Downgrade impact exposure | `downgrade_impact_viewed` by affected board/member/feature counts and days remaining |

### Dashboard D: Checkout and revenue

| Insight | Definition |
|---|---|
| Checkout starts | Unique organisations with `checkout_started`, by billing period and seat band |
| Checkout conversion | `checkout_started` → `subscription_started` |
| Expired checkout sessions | Unique organisations with `checkout_abandoned` |
| New subscriptions | Unique organisations with `subscription_started` |
| Payments | Sum `subscription_payment_succeeded.revenue`, split by `currency` before any currency conversion |
| Payment mix | Payment count/revenue by `billing_reason` |
| Cancellations | `subscription_cancelled` by `cancellation_category` and `tenure_band` |

Do not sum revenue across currencies. Create separate insights per `currency`, or transform the data into a common reporting currency outside this event contract.

## Answering the critical question

Use mutually understandable diagnostic segments rather than one overloaded funnel.

### Segment 1: Insufficient experienced value

Organisations that activated a trial but did not reach any of:

- `meaningful_work_created`
- `collaboration_started`
- `premium_feature_used`

before `trial_ended` or the analysis window closed.

Interpretation: these organisations likely did not experience enough of the product's core or premium value. Prioritise onboarding, templates/import, first-board/card success, and collaboration invitations.

### Segment 2: Value experienced, reason to pay not understood

Organisations that recorded `premium_feature_used` or `meaningful_work_created`, then recorded a blocked attempt/modal view, but did not reach `pricing_viewed_in_app` or `checkout_started`.

Interpretation: value exists, but the upgrade message, price framing, or call to action may not be connecting that value to the paid plan. Break down by `premium_feature`, `limit_type`, and the first step's `upgrade_source`.

### Segment 3: Reason understood, checkout friction

Organisations that reached `pricing_viewed_in_app` or `checkout_started` but did not reach `subscription_started`, especially those with `checkout_abandoned`.

Interpretation: investigate price, seat quantity, billing-period choice, payment mechanics, or buyer authority. Break down by `billing_period` and `seat_band`.

### Segment 4: Healthy conversion

Organisations that reached core value, used or attempted a premium feature, and then emitted `subscription_started`.

Interpretation: use these organisations to identify the strongest premium feature, activation path, acquisition source, and time-to-value pattern.

### Suggested scorecard

Report these rates by signup week and acquisition source:

1. `% reaching meaningful_work_created`
2. `% reaching collaboration_started`
3. `% recording premium_feature_used`
4. `% recording premium_feature_attempted`
5. `% of attempted organisations viewing pricing`
6. `% of pricing-view organisations starting checkout`
7. `% of checkout organisations starting a subscription`
8. `% of trials ending without conversion`

The sequence separates product value creation, premium demand, pricing comprehension, and payment completion.

## Known interpretation caveats

1. **Browser consent creates undercounting.** Never use a browser event as the denominator for a server event without labelling the metric as consented-browser behaviour.
2. **Aliases are duplicates, not extra behaviour.** `trial_started`/`trial_activated`, `subscription_checkout_created`/`checkout_started`, and `upgrade_page_viewed`/`pricing_viewed_in_app` share trigger boundaries.
3. **Four limit events currently share one impression.** `premium_feature_attempted`, `plan_limit_warning_seen`, `plan_limit_reached`, and `upgrade_modal_viewed` are emitted together. `plan_limit_warning_seen` is not yet a pre-limit warning.
4. **Checkout abandonment is delayed.** It means Stripe expired the session, not that the user immediately closed or canceled Checkout.
5. **`workspace_id` is overloaded.** For organisation-scoped invitations and commercial lifecycle events, it contains the organisation ID.
6. **`upgrade_source` is not carried across steps.** Break down an upgrade funnel using the first intent event's source.
7. **`premium_feature_used` is action-specific.** It only covers the committed actions listed in this guide; absence does not prove that no premium value was experienced.
8. **Milestones are durable.** `meaningful_work_created` and `collaboration_started` fire once per workspace, so use unique workspaces/organisations rather than raw event volume.
9. **Subscription starts are lifecycle starts.** A canceled organisation that later re-subscribes can produce a new `subscription_started` event.
10. **Revenue is minor-unit and currency-specific.** `9900` means 99.00 in a two-decimal currency, not 9,900 major currency units.

## Privacy and intentionally unavailable data

Kanera uses explicit allowlists at the browser and server provider boundaries. The implementation does not send card titles, descriptions, comments, notes, list/board/workspace names, attachments, search queries, authentication tokens, invitation tokens, raw routes, or raw URLs with query strings as product-event properties.

Browser PostHog configuration also disables:

- Autocapture
- Automatic pageview and page-leave capture
- Exception capture
- Heatmaps
- Performance capture
- Session recording
- Surveys
- External dependency loading
- IP capture

Do-not-track is respected. Text and element attributes are masked. Manual `$pageview` uses route templates only.

This means dashboards should be built from the explicit catalog in this document, not from assumed PostHog autocapture events or DOM data.

## PostHog build checklist for marketing

1. Confirm the project contains recent events before publishing each insight.
2. Set the funnel aggregation type to `organization` for B2B lifecycle reporting.
3. Use canonical event names and exclude their legacy aliases from new totals.
4. Set a deliberate conversion window: usually 14 or 30 days for activation and trial funnels, shorter for pricing/checkout.
5. Break down acquisition funnels on first-step acquisition properties.
6. Break down upgrade funnels on the first intent event's `limit_type`, `premium_feature`, and `upgrade_source`.
7. Keep browser-dependent and server-only dashboards visibly labelled.
8. Use unique organisations for conversion rates; use total event volume only when measuring repeated attempts or repeated feature usage.
9. Filter or split by `event_version` when a future schema version is introduced.
10. Add descriptions to every saved insight with the exact event sequence, aggregation unit, conversion window, and caveats.

PostHog dashboards are intended for recurring metrics, while ad hoc investigations are better suited to notebooks or temporary insights. See the official [dashboards guide](https://posthog.com/docs/product-analytics/dashboards).

## Engineering source contracts

Marketing should use this document rather than code for day-to-day work. When an implementation audit is needed, the strict event/property contracts live in:

- Browser event contract: `apps/web/src/app/core/analytics/analytics-events.ts`
- Browser provider-boundary allowlist: `apps/web/src/app/core/analytics/analytics-property-sanitizer.ts`
- Browser identity, grouping, pageview, and privacy behavior: `apps/web/src/app/core/analytics/analytics.service.ts`
- Server event contract and allowlist: `apps/api/src/lib/product-analytics.ts`
- Activation and collaboration milestones: `apps/api/src/lib/analytics-milestones.ts`
- Checkout, subscription, and revenue lifecycle: `apps/api/src/lib/billing.ts`

When any contract changes, update this guide in the same change so dashboard definitions do not drift from production behavior.
