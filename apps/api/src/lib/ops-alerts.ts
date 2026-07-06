import type { FastifyBaseLogger } from "fastify";
import { env, type Env } from "../env.js";

// slow_request is intentionally not an alert type: request latency is alerted on in aggregate by
// Grafana (p95 rule) and the per-request detail lives in the "slow request" log line (shipped to Loki).
// Duplicating it as a per-request webhook was noisy overlap. See DEPLOY.md "Monitoring".
type AlertType = "startup" | "error";
export type AlertService = "api" | "public-api" | "worker" | "admin-api";
type Severity = "info" | "error";

interface BaseAlert {
  service: AlertService;
  type: AlertType;
  timestamp?: Date;
  throttleKey?: string;
}

export interface StartupAlert extends BaseAlert {
  type: "startup";
  port: number;
}

export interface ErrorAlert extends BaseAlert {
  type: "error";
  requestId?: string;
  method?: string;
  url?: string;
  statusCode?: number;
  error: unknown;
}

export type OpsAlert = StartupAlert | ErrorAlert;

interface SendOpsAlertOptions {
  env?: Pick<Env, "NODE_ENV" | "OPS_ALERTS_ENABLED" | "OPS_ALERT_THROTTLE_MS" | "ALERT_WEBHOOK_URL">;
  fetch?: typeof fetch;
  log?: FastifyBaseLogger;
  now?: () => number;
}

const throttleUntilByKey = new Map<string, number>();
let testDefaults: SendOpsAlertOptions | null = null;

// The destination is a single Slack-compatible incoming webhook. Slack accepts the payload natively,
// and so do Zulip's slack_incoming integration, Mattermost, Discord, etc., so one payload format works.
function alertWebhookUrl(config: SendOpsAlertOptions["env"] = env): string | undefined {
  if (!config.OPS_ALERTS_ENABLED) return undefined;
  return config.ALERT_WEBHOOK_URL;
}

function alertTitle(alert: OpsAlert): string {
  if (alert.type === "startup") return "service started";
  return "Unhandled API error";
}

function severity(alert: OpsAlert): Severity {
  if (alert.type === "startup") return "info";
  return "error";
}

function severityLabel(alert: OpsAlert): string {
  return severity(alert).toUpperCase();
}

function severityIndicator(alert: OpsAlert): string {
  if (severity(alert) === "error") return `🔴 ${severityLabel(alert)}`;
  return `🔵 ${severityLabel(alert)}`;
}

function severityColor(alert: OpsAlert): string {
  if (alert.type === "startup") return "#0f766e";
  return "#dc2626";
}

function errorSummary(error: unknown): string {
  if (Error.isError(error)) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

function truncate(value: string, maxLength = 500): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}

function fields(alert: OpsAlert, nodeEnv: string): Array<[string, string]> {
  const base: Array<[string, string]> = [
    // Zulip's Slack-compatible webhook renders attachment fields but can omit the top-level text.
    // Lead with severity and event identity so the notification is glanceable on every destination.
    [severityIndicator(alert), alertTitle(alert)],
    ["Service", alert.service],
    ["Environment", nodeEnv],
    ["Time", (alert.timestamp ?? new Date()).toISOString()],
  ];

  if (alert.type === "startup") {
    return [...base, ["Port", String(alert.port)]];
  }

  return [
    ...base,
    ...(alert.method && alert.url ? [["Request", `${alert.method} ${alert.url}`] as [string, string]] : []),
    ...(alert.statusCode ? [["Status", String(alert.statusCode)] as [string, string]] : []),
    ...(alert.requestId ? [["Request ID", alert.requestId] as [string, string]] : []),
    ["Error", truncate(errorSummary(alert.error))],
  ];
}

// Classic Slack "attachment" format (color bar + title/value fields). Deliberately NOT Slack Block Kit:
// Block Kit renders only in Slack, whereas classic attachments render in Slack and in every
// Slack-compatible endpoint (Zulip's slack_incoming, Mattermost, Discord). One payload, every destination.
function alertPayload(alert: OpsAlert, nodeEnv: string): unknown {
  const text = `${severityIndicator(alert)} — Kanera ${alertTitle(alert)} (${alert.service})`;
  return {
    text,
    attachments: [
      {
        color: severityColor(alert),
        title: text,
        fallback: text,
        fields: fields(alert, nodeEnv).map(([title, value]) => ({
          title,
          value,
          short: value.length <= 40,
        })),
        footer: "Kanera operational alert",
      },
    ],
  };
}

function defaultThrottleKey(alert: OpsAlert): string {
  if (alert.type === "startup") return `${alert.service}:startup`;
  const summary = errorSummary(alert.error);
  return `${alert.service}:error:${alert.method ?? ""}:${alert.url ?? ""}:${summary}`;
}

function shouldThrottle(alert: OpsAlert, throttleMs: number, now: number): boolean {
  if (throttleMs === 0) return false;
  // One throttle per alert so the same alert does not spam the channel.
  const key = alert.throttleKey ?? defaultThrottleKey(alert);
  const throttledUntil = throttleUntilByKey.get(key) ?? 0;
  if (throttledUntil > now) return true;
  throttleUntilByKey.set(key, now + throttleMs);
  return false;
}

function safeUrlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return "[invalid-url]";
  }
}

export function resetOpsAlertThrottleForTests(): void {
  throttleUntilByKey.clear();
}

export function configureOpsAlertsForTests(options: SendOpsAlertOptions | null): void {
  testDefaults = options;
  throttleUntilByKey.clear();
}

export async function sendOpsAlert(alert: OpsAlert, options: SendOpsAlertOptions = {}): Promise<void> {
  const mergedOptions = { ...(testDefaults ?? {}), ...options };
  const config = mergedOptions.env ?? env;
  const url = alertWebhookUrl(config);
  if (!url) return;

  const now = mergedOptions.now?.() ?? Date.now();
  if (shouldThrottle(alert, config.OPS_ALERT_THROTTLE_MS, now)) return;

  const fetchImpl = mergedOptions.fetch ?? fetch;
  const body = JSON.stringify(alertPayload(alert, config.NODE_ENV));

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Kanera-Ops-Alerts/1.0" },
      body,
    });
    if (!response.ok) {
      mergedOptions.log?.warn({
        webhookOrigin: safeUrlLabel(url),
        statusCode: response.status,
      }, "ops alert webhook returned non-success");
    }
  } catch (err) {
    mergedOptions.log?.warn({
      err,
      webhookOrigin: safeUrlLabel(url),
    }, "ops alert webhook delivery failed");
  }
}
