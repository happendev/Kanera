import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatDeliveryPayload, WebhookEndpoint } from "@kanera/shared/schema";
import { buildChatRequest, encryptChatDestinationConfig } from "./chat-destinations.js";

function endpoint(provider: "slack" | "discord" | "telegram" | "zulip", encryptedConfig: string): WebhookEndpoint {
  return {
    id: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    createdById: crypto.randomUUID(),
    provider,
    name: "Team updates",
    url: null,
    encryptedSecret: null,
    encryptedConfig,
    priorityFieldId: null,
    eventTypes: ["comment_created"],
    enabled: true,
    ownerApiKeyId: null,
    ownerAgentGrantId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const payload: ChatDeliveryPayload = {
  kind: "chat",
  id: crypto.randomUUID(),
  type: "comment_created",
  workspaceId: crypto.randomUUID(),
  boardId: crypto.randomUUID(),
  cardId: crypto.randomUUID(),
  occurredAt: new Date().toISOString(),
  actorName: "Alex <admin>",
  workspaceName: "Product",
  boardName: "Roadmap",
  cardTitle: "Ship @everyone <script>",
  cardUrl: "https://app.example.test/c/PROJ-1",
  excerpt: `Hello <!channel> ${"x".repeat(600)}`,
};

function requestBody(init: RequestInit): string {
  if (typeof init.body !== "string") throw new TypeError("expected a string request body");
  return init.body;
}

void test("Slack chat requests escape mention markup and truncate excerpts", () => {
  const target = endpoint("slack", encryptChatDestinationConfig("slack", {
    webhookUrl: "https://hooks.slack.com/services/T/B/secret",
  }));
  const request = buildChatRequest(target, payload);
  assert.equal(request.url, "https://hooks.slack.com/services/T/B/secret");
  const body = JSON.parse(requestBody(request.init)) as { text: string; blocks: Array<{ text?: { text?: string } }> };
  assert.doesNotMatch(body.text, /<!channel>/);
  assert.match(body.text, /&lt;!channel&gt;/);
  assert.ok(body.text.length < 900);
  assert.match(body.blocks[0]?.text?.text ?? "", /Alex &lt;admin&gt;/);
});

void test("Discord disables mentions and Telegram includes an optional topic", () => {
  const discord = endpoint("discord", encryptChatDestinationConfig("discord", {
    webhookUrl: "https://discord.com/api/webhooks/123/secret",
  }));
  const discordBody = JSON.parse(requestBody(buildChatRequest(discord, payload).init)) as { allowed_mentions: { parse: string[] } };
  assert.deepEqual(discordBody.allowed_mentions.parse, []);

  const telegram = endpoint("telegram", encryptChatDestinationConfig("telegram", {
    botToken: "123:secret",
    chatId: "-100123",
    threadId: 42,
  }));
  const telegramRequest = buildChatRequest(telegram, payload);
  assert.equal(telegramRequest.url, "https://api.telegram.org/bot123:secret/sendMessage");
  const telegramBody = JSON.parse(requestBody(telegramRequest.init)) as { message_thread_id: number; text: string; parse_mode: string };
  assert.equal(telegramBody.message_thread_id, 42);
  assert.equal(telegramBody.parse_mode, "HTML");
  assert.doesNotMatch(telegramBody.text, /<script>/);
});

void test("Discord embed titles are cut to the provider's 256-character limit", () => {
  // Kanera accepts 500-character titles; Discord rejects the whole message above 256, and retries
  // would resend the same invalid payload. The excerpt and the plain content line are unaffected.
  const discord = endpoint("discord", encryptChatDestinationConfig("discord", {
    webhookUrl: "https://discord.com/api/webhooks/123/secret",
  }));
  const longTitle = "x".repeat(257);
  const body = JSON.parse(requestBody(buildChatRequest(discord, { ...payload, cardTitle: longTitle }).init)) as {
    embeds: { title: string }[];
  };
  assert.equal(Array.from(body.embeds[0]!.title).length, 256);
  assert.ok(body.embeds[0]!.title.endsWith("…"));
  assert.ok(body.embeds[0]!.title.startsWith("x".repeat(255)));

  const exact = JSON.parse(requestBody(buildChatRequest(discord, { ...payload, cardTitle: "y".repeat(256) }).init)) as {
    embeds: { title: string }[];
  };
  assert.equal(exact.embeds[0]!.title, "y".repeat(256));
});
