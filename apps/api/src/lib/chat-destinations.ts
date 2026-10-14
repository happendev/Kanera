import { SOURCE_LOCALE, type Locale } from "@kanera/shared/locales";
import { chatText } from "./i18n/messages/chat.js";
import type {
  ChatDeliveryPayload,
  ChatDestinationProvider,
  WebhookEndpoint,
} from "@kanera/shared/schema";
import { env } from "../env.js";
import { badRequest } from "./errors.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { assertWebhookUrlAllowed } from "./ssrf.js";
import { escapeHtml } from "./html-escape.js";

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

function decryptChatDestinationConfig(endpoint: WebhookEndpoint): ChatDestinationConfig {
  if (!endpoint.encryptedConfig || endpoint.provider === "generic") {
    throw new Error("chat destination configuration is missing");
  }
  return JSON.parse(decryptSecret(endpoint.encryptedConfig)) as ChatDestinationConfig;
}

export function chatDestinationConnectionSummary(endpoint: WebhookEndpoint, locale: Locale = SOURCE_LOCALE): string {
  if (endpoint.provider !== "telegram") return chatText(locale, "webhookConfigured");
  const config = decryptChatDestinationConfig(endpoint);
  if (!("chatId" in config)) return chatText(locale, "telegramConfigured");
  const visible = config.chatId.length <= 8
    ? config.chatId
    : `${config.chatId.slice(0, 4)}…${config.chatId.slice(-4)}`;
  return chatText(locale, config.threadId ? "topic" : "chat", { chat: visible, topic: config.threadId ?? "" });
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

/** Discord rejects the whole message when embed.title exceeds 256 characters; Kanera titles go to 500. */
const DISCORD_EMBED_TITLE_LIMIT = 256;

function truncateForProvider(value: string, limit: number): string {
  const chars = Array.from(value);
  return chars.length <= limit ? value : `${chars.slice(0, limit - 1).join("")}…`;
}

function escapeSlack(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function actionText(payload: ChatDeliveryPayload): string {
  const locale = payload.locale ?? SOURCE_LOCALE;
  const values = { from: payload.fromValue ?? chatText(locale, "none"), to: payload.toValue ?? chatText(locale, "none") };
  switch (payload.type) {
    case "card_created": return chatText(locale, "created");
    case "status_changed": return chatText(locale, payload.fromValue || payload.toValue ? "statusValues" : "status", values);
    case "priority_changed": return chatText(locale, payload.fromValue || payload.toValue ? "priorityValues" : "priority", values);
    case "title_changed": return chatText(locale, payload.toValue ? "renamedTo" : "renamed", values);
    case "description_changed": return chatText(locale, "description");
    case "comment_created": return chatText(locale, "commented");
    case "chat:test": return chatText(locale, "test");
  }
}

function cardTitle(payload: ChatDeliveryPayload): string {
  return payload.cardTitle ?? chatText(payload.locale ?? SOURCE_LOCALE, payload.type === "chat:test" ? "destination" : "card");
}

function excerpt(payload: ChatDeliveryPayload): string | undefined {
  return payload.type === "chat:test" ? chatText(payload.locale ?? SOURCE_LOCALE, "testBody") : payload.excerpt;
}

function contextText(payload: ChatDeliveryPayload): string {
  return [payload.workspaceName, payload.boardName].filter(Boolean).join(" · ");
}

function plainMessage(payload: ChatDeliveryPayload): string {
  const title = cardTitle(payload);
  return [
    `${payload.actorName} ${actionText(payload)}`,
    title,
    contextText(payload),
    chatContentExcerpt(excerpt(payload)),
    payload.cardUrl,
  ].filter(Boolean).join("\n");
}

export function buildChatRequest(endpoint: WebhookEndpoint, payload: ChatDeliveryPayload): { url: string; init: RequestInit } {
  if (endpoint.provider === "generic") throw new Error("generic endpoint cannot format a chat delivery");
  const config = decryptChatDestinationConfig(endpoint);
  const text = plainMessage(payload);

  if (endpoint.provider === "telegram") {
    if (!("botToken" in config)) throw new Error("invalid Telegram destination configuration");
    const title = escapeHtml(cardTitle(payload));
    const cardLine = payload.cardUrl ? `<a href="${escapeHtml(payload.cardUrl)}">${title}</a>` : `<b>${title}</b>`;
    const html = [
      `<b>${escapeHtml(payload.actorName)}</b> ${escapeHtml(actionText(payload))}`,
      cardLine,
      escapeHtml(contextText(payload)),
      excerpt(payload) ? escapeHtml(chatContentExcerpt(excerpt(payload)) ?? "") : "",
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
            title: truncateForProvider(cardTitle(payload), DISCORD_EMBED_TITLE_LIMIT),
            url: payload.cardUrl,
            description: chatContentExcerpt(excerpt(payload)),
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
          { type: "section", text: { type: "mrkdwn", text: payload.cardUrl ? `<${payload.cardUrl}|${escapeSlack(cardTitle(payload))}>` : `*${escapeSlack(cardTitle(payload))}*` } },
          ...(excerpt(payload) ? [{ type: "section", text: { type: "mrkdwn", text: escapeSlack(chatContentExcerpt(excerpt(payload)) ?? "") } }] : []),
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

export function testChatPayload(workspaceId: string, workspaceName: string, locale: Locale = SOURCE_LOCALE): ChatDeliveryPayload {
  return {
    kind: "chat",
    locale,
    id: crypto.randomUUID(),
    type: "chat:test",
    workspaceId,
    occurredAt: new Date().toISOString(),
    actorName: "Kanera",
    workspaceName,
    excerpt: chatText(locale, "testBody"),
    cardUrl: env.WEB_ORIGIN,
  };
}
