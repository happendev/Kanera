import type { SmtpConfig } from "@kanera/shared/schema";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { env } from "../env.js";
import { smtpTestEmail } from "./email-templates/index.js";

const REDACTED = "***";
const DIGICERT_GLOBAL_ROOT_CA = readFileSync(
  new URL("./certificates/digicert-global-root-ca.pem", import.meta.url),
  "utf8",
);

export function smtpConfigFromEnv(): SmtpConfig | null {
  if (!env.SMTP_HOST || !env.SMTP_FROM_EMAIL) return null;
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT ?? (env.SMTP_SECURITY === "tls" ? 465 : 587),
    security: env.SMTP_SECURITY,
    ...(env.SMTP_USER ? { username: env.SMTP_USER } : {}),
    ...(env.SMTP_PASSWORD ? { password: env.SMTP_PASSWORD } : {}),
    fromEmail: env.SMTP_FROM_EMAIL,
    ...(env.SMTP_FROM_NAME ? { fromName: env.SMTP_FROM_NAME } : {}),
  };
}

export function redactSmtpConfig(config: SmtpConfig | null): SmtpConfig | null {
  if (!config) return null;
  return {
    ...config,
    ...(config.username ? { username: REDACTED } : {}),
    ...(config.password ? { password: REDACTED } : {}),
  };
}

export function mergeSmtpPassword(incoming: SmtpConfig, existing: SmtpConfig | null): SmtpConfig {
  return {
    ...incoming,
    ...(incoming.username === REDACTED && existing?.username ? { username: existing.username } : {}),
    ...(incoming.password === REDACTED && existing?.password ? { password: existing.password } : {}),
  };
}

export async function testSmtpConfig(config: SmtpConfig, to: string): Promise<void> {
  const client = new SmtpProbe(config);
  await client.connect();
  try {
    await client.ehlo();
    if (config.security === "starttls") {
      await client.command("STARTTLS", [220]);
      await client.upgradeToTls();
      await client.ehlo();
    }
    if (config.username || config.password) {
      if (!config.username || !config.password || config.password === REDACTED) throw new Error("SMTP username and password are required for authentication.");
      const auth = Buffer.from(`\u0000${config.username}\u0000${config.password}`).toString("base64");
      await client.command(`AUTH PLAIN ${auth}`, [235]);
    }
    await client.sendMail(to, buildTestMessage(config, to));
    await client.command("QUIT", [221]).catch(() => undefined);
  } finally {
    client.close();
  }
}

function buildTestMessage(config: SmtpConfig, to: string): string {
  const from = formatAddress(config.fromEmail, config.fromName);
  // Send the same HTML layout used by real notifications so the test verifies
  // logo, colours, and button rendering in the recipient's actual mail client.
  const html = smtpTestEmail({
    recipientEmail: to,
    appUrl: env.WEB_ORIGIN,
    sentAtLabel: new Date().toUTCString(),
  });
  return buildMimeMessage({ from, to, subject: "Kanera SMTP test", html });
}

function encodeBase64Body(content: Buffer | string): string {
  const buffer = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  // SMTP requires lines of at most 998 chars; 76 keeps us well within and is the
  // conventional base64 line length.
  return buffer.toString("base64").replace(/(.{76})/g, "$1\r\n");
}

function buildTextMessage({ from, to, subject, text }: { from: string; to: string; subject: string; text: string }): string {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?utf-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${messageIdDomain(from)}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodeBase64Body(text),
  ].join("\r\n");
}

function buildMimeMessage({ from, to, subject, html }: { from: string; to: string; subject: string; html: string }): string {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?utf-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${messageIdDomain(from)}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodeBase64Body(html),
  ].join("\r\n");
}

export function formatAddress(email: string, name?: string): string {
  if (!name) return email;
  const escaped = name.replace(/["\\]/g, "\\$&");
  return `"${escaped}" <${email}>`;
}

export interface SendEmailOptions {
  config: SmtpConfig;
  to: string;
  subject: string;
  html?: string;
  text?: string;
}

/**
 * Send an email via SMTP. Builds a MIME message with proper headers and
 * delivers it using the same low-level SmtpProbe used for SMTP config testing.
 */
export async function sendEmail({ config, to, subject, html, text }: SendEmailOptions): Promise<void> {
  const from = formatAddress(config.fromEmail, config.fromName);
  if (html === undefined && text === undefined) throw new Error("email html or text body is required");
  const message = text !== undefined && html === undefined
    ? buildTextMessage({ from, to, subject, text })
    : buildMimeMessage({ from, to, subject, html: html! });

  const client = new SmtpProbe(config);
  await client.connect();
  try {
    await client.ehlo();
    if (config.security === "starttls") {
      await client.command("STARTTLS", [220]);
      await client.upgradeToTls();
      await client.ehlo();
    }
    if (config.username || config.password) {
      if (!config.username || !config.password) throw new Error("SMTP username and password are required for authentication.");
      const auth = Buffer.from(`\u0000${config.username}\u0000${config.password}`).toString("base64");
      await client.command(`AUTH PLAIN ${auth}`, [235]);
    }
    await client.sendMail(to, message);
    await client.command("QUIT", [221]).catch(() => undefined);
  } finally {
    client.close();
  }
}

class SmtpProbe {
  private socket!: net.Socket | tls.TLSSocket;
  private buffer = "";

  constructor(private readonly config: SmtpConfig) { }

  async connect() {
    this.socket = await new Promise<net.Socket | tls.TLSSocket>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      const socket =
        this.config.security === "tls"
          ? tls.connect({ host: this.config.host, port: this.config.port, ...smtpTlsTrust(this.config.host) }, () => resolve(socket))
          : net.connect({ host: this.config.host, port: this.config.port }, () => resolve(socket));
      socket.setTimeout(10000, () => socket.destroy(new Error("SMTP connection timed out.")));
      socket.once("error", onError);
    });
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => {
      this.buffer += chunk;
    });
    await this.read([220]);
  }

  async upgradeToTls() {
    this.socket.removeAllListeners("data");
    this.buffer = "";
    this.socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const socket = tls.connect({ socket: this.socket, ...smtpTlsTrust(this.config.host) }, () => resolve(socket));
      socket.once("error", reject);
    });
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => {
      this.buffer += chunk;
    });
  }

  async ehlo() {
    await this.command(`EHLO ${smtpIdentityDomain(this.config)}`, [250]);
  }

  async command(command: string, expected: number[]) {
    this.socket.write(`${command}\r\n`);
    return this.read(expected);
  }

  async sendMail(to: string, message: string) {
    await this.command(`MAIL FROM:<${this.config.fromEmail}>`, [250]);
    await this.command(`RCPT TO:<${to}>`, [250, 251]);
    await this.command("DATA", [354]);
    this.socket.write(`${escapeData(message)}\r\n.\r\n`);
    await this.read([250]);
  }

  close() {
    this.socket.destroy();
  }

  private async read(expected: number[]): Promise<string> {
    const line = await this.waitForResponse();
    const code = Number(line.slice(0, 3));
    if (!expected.includes(code)) throw new Error(`SMTP server returned ${line}`);
    return line;
  }

  private waitForResponse(): Promise<string> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        const response = this.consumeResponse();
        if (response) {
          resolve(response);
          return;
        }
        if (Date.now() - started > 10000) {
          reject(new Error("SMTP server did not respond."));
          return;
        }
        setTimeout(tick, 25);
      };
      tick();
    });
  }

  private consumeResponse(): string | null {
    const lines = this.buffer.split(/\r?\n/);
    if (lines.length < 2) return null;
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i]!)) {
        const response = lines.slice(0, i + 1).join("\n");
        this.buffer = lines.slice(i + 1).join("\n");
        return response;
      }
    }
    return null;
  }
}

function smtpTlsTrust(host: string): Pick<tls.ConnectionOptions, "servername" | "ca"> {
  // Microsoft 365 Direct Send still chains through DigiCert Global Root CA. Some
  // Node/Alpine image combinations omit it from both available stores, so keep the
  // verified public root alongside them without weakening certificate validation.
  return {
    servername: host,
    ca: [...new Set([
      ...tls.getCACertificates("default"),
      ...tls.getCACertificates("bundled"),
      DIGICERT_GLOBAL_ROOT_CA,
    ])],
  };
}

function escapeData(message: string): string {
  return message.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
}

function smtpIdentityDomain(config: SmtpConfig): string {
  return normalizeSmtpDomain(env.SMTP_IDENTITY_DOMAIN) ?? domainFromEmail(config.fromEmail) ?? config.host;
}

function messageIdDomain(from: string): string {
  return normalizeSmtpDomain(env.SMTP_IDENTITY_DOMAIN) ?? domainFromAddress(from) ?? "localhost";
}

function domainFromEmail(email: string): string | null {
  return normalizeSmtpDomain(email.split("@").at(-1));
}

function domainFromAddress(address: string): string | null {
  const match = /@([^>\s]+)>?$/.exec(address);
  return normalizeSmtpDomain(match?.[1]);
}

function normalizeSmtpDomain(value: string | undefined): string | null {
  const domain = value?.trim().toLowerCase().replace(/\.$/, "");
  if (!domain || domain === "localhost" || domain.endsWith(".local")) return null;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain) ? domain : null;
}
