import type {
  ChatDeliveryPayload,
  ChatDestinationProvider,
  WebhookEndpoint,
} from "@kanera/shared/schema";
import { env } from "../env.js";
import { badRequest } from "./errors.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { assertWebhookUrlAllowed } from "./ssrf.js";

export type ChatDestinationConfig =
  | { webhookUrl: string }
  | { botToken: string; chatId: string; threadId: number | null };

export function validateChatDestinationConfig(
  provider: ChatDestinationProvider,
  config: ChatDestinationConfig,
): void {
  if (provider === "telegram") {
    if (!("botToken" in config) || !config.botToken.trim() || !config.chatId.trim()) {
      throw badRequest("telegram requires a bot token and chat id");
    }
    return;
  }
  if (!("webhookUrl" in config)) throw badRequest(`${provider} requires a webhook url`);
  assertWebhookUrlAllowed(config.webhookUrl);
  const parsed = new URL(config.webhookUrl);
  const host = parsed.hostname.toLowerCase();
  if (provider === "slack") {
    if (!(["hooks.slack.com", "hooks.slack-gov.com"] as string[]).includes(host) || !parsed.pathname.startsWith("/services/")) {
      throw badRequest("invalid Slack incoming webhook url");
    }
  } else if (provider === "discord") {
    const discordHosts = ["discord.com", "www.discord.com", "discordapp.com"];
    if (!discordHosts.includes(host) || !parsed.pathname.startsWith("/api/webhooks/")) {
      throw badRequest("invalid Discord webhook url");
    }
  }
  // Zulip Cloud and self-hosted installations use arbitrary public hosts; the shared SSRF
  // policy is the meaningful validation boundary for their generated integration URLs.
}

export function encryptChatDestinationConfig(
  provider: ChatDestinationProvider,
  config: ChatDestinationConfig,
): string {
  validateChatDestinationConfig(provider, config);
  return encryptSecret(JSON.stringify(config));
}

export function decryptChatDestinationConfig(endpoint: WebhookEndpoint): ChatDestinationConfig {
  if (!endpoint.encryptedConfig || endpoint.provider === "generic") {
    throw new Error("chat destination configuration is missing");
  }
  return JSON.parse(decryptSecret(endpoint.encryptedConfig)) as ChatDestinationConfig;
}

export function chatDestinationConnectionSummary(endpoint: WebhookEndpoint): string {
  if (endpoint.provider !== "telegram") return "Webhook configured";
  const config = decryptChatDestinationConfig(endpoint);
  if (!("chatId" in config)) return "Telegram configured";
  const visible = config.chatId.length <= 8
    ? config.chatId
    : `${config.chatId.slice(0, 4)}…${config.chatId.slice(-4)}`;
  return config.threadId ? `Chat ${visible} · topic ${config.threadId}` : `Chat ${visible}`;
}

export function chatContentExcerpt(value: string | null | undefined, limit = 500): string | undefined {
  if (!value) return undefined;
  const plain = value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/```[\s\S]*?```/g, " code ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return undefined;
  const chars = Array.from(plain);
  return chars.length <= limit ? plain : `${chars.slice(0, limit - 1).join("")}…`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function escapeSlack(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function actionText(payload: ChatDeliveryPayload): string {
  switch (payload.type) {
    case "card_created": return "created a card";
    case "status_changed": return `changed status${payload.fromValue || payload.toValue ? ` from ${payload.fromValue ?? "None"} to ${payload.toValue ?? "None"}` : ""}`;
    case "priority_changed": return `changed priority${payload.fromValue || payload.toValue ? ` from ${payload.fromValue ?? "None"} to ${payload.toValue ?? "None"}` : ""}`;
    case "title_changed": return payload.toValue ? `renamed a card to ${payload.toValue}` : "renamed a card";
    case "description_changed": return "updated a card description";
    case "comment_created": return "commented on a card";
    case "chat:test": return "sent a test notification";
  }
}

function contextText(payload: ChatDeliveryPayload): string {
  return [payload.workspaceName, payload.boardName].filter(Boolean).join(" · ");
}

function plainMessage(payload: ChatDeliveryPayload): string {
  const title = payload.cardTitle ?? (payload.type === "chat:test" ? "Kanera chat destination" : "Card");
  return [
    `${payload.actorName} ${actionText(payload)}`,
    title,
    contextText(payload),
    chatContentExcerpt(payload.excerpt),
    payload.cardUrl,
  ].filter(Boolean).join("\n");
}

export function buildChatRequest(endpoint: WebhookEndpoint, payload: ChatDeliveryPayload): { url: string; init: RequestInit } {
  if (endpoint.provider === "generic") throw new Error("generic endpoint cannot format a chat delivery");
  const config = decryptChatDestinationConfig(endpoint);
  const text = plainMessage(payload);

  if (endpoint.provider === "telegram") {
    if (!("botToken" in config)) throw new Error("invalid Telegram destination configuration");
    const title = escapeHtml(payload.cardTitle ?? (payload.type === "chat:test" ? "Kanera chat destination" : "Card"));
    const cardLine = payload.cardUrl ? `<a href="${escapeHtml(payload.cardUrl)}">${title}</a>` : `<b>${title}</b>`;
    const html = [
      `<b>${escapeHtml(payload.actorName)}</b> ${escapeHtml(actionText(payload))}`,
      cardLine,
      escapeHtml(contextText(payload)),
      payload.excerpt ? escapeHtml(chatContentExcerpt(payload.excerpt) ?? "") : "",
    ].filter(Boolean).join("\n");
    return {
      url: `https://api.telegram.org/bot${config.botToken}/sendMessage`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Kanera-Chat/1.0" },
        body: JSON.stringify({
          chat_id: config.chatId,
          text: html,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...(config.threadId ? { message_thread_id: config.threadId } : {}),
        }),
      },
    };
  }

  if (!("webhookUrl" in config)) throw new Error(`invalid ${endpoint.provider} destination configuration`);
  if (endpoint.provider === "discord") {
    return {
      url: config.webhookUrl,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Kanera-Chat/1.0" },
        body: JSON.stringify({
          content: `${payload.actorName} ${actionText(payload)}`,
          embeds: [{
            title: payload.cardTitle ?? (payload.type === "chat:test" ? "Kanera chat destination" : "Card"),
            url: payload.cardUrl,
            description: chatContentExcerpt(payload.excerpt),
            footer: { text: contextText(payload) },
          }],
          allowed_mentions: { parse: [] },
        }),
      },
    };
  }

  const slackText = escapeSlack(text);
  const body = endpoint.provider === "slack"
    ? {
        text: slackText,
        unfurl_links: false,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `*${escapeSlack(payload.actorName)}* ${escapeSlack(actionText(payload))}` } },
          { type: "section", text: { type: "mrkdwn", text: payload.cardUrl ? `<${payload.cardUrl}|${escapeSlack(payload.cardTitle ?? "Card")}>` : `*${escapeSlack(payload.cardTitle ?? "Card")}*` } },
          ...(payload.excerpt ? [{ type: "section", text: { type: "mrkdwn", text: escapeSlack(chatContentExcerpt(payload.excerpt) ?? "") } }] : []),
          { type: "context", elements: [{ type: "mrkdwn", text: escapeSlack(contextText(payload)) }] },
        ],
      }
    : { text: slackText };
  return {
    url: config.webhookUrl,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Kanera-Chat/1.0" },
      body: JSON.stringify(body),
    },
  };
}

export function testChatPayload(workspaceId: string, workspaceName: string): ChatDeliveryPayload {
  return {
    kind: "chat",
    id: crypto.randomUUID(),
    type: "chat:test",
    workspaceId,
    occurredAt: new Date().toISOString(),
    actorName: "Kanera",
    workspaceName,
    excerpt: "Your chat destination is connected and ready to receive workspace updates.",
    cardUrl: env.WEB_ORIGIN,
  };
}
