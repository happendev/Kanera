import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { sendEmail } from "./smtp.js";

void test("SMTP delivery uses sender domain for EHLO and Message-ID", async () => {
  const received = await withSmtpServer(async (port) => {
    await sendEmail({
      config: {
        host: "127.0.0.1",
        port,
        security: "none",
        fromEmail: "noreply@example.com",
        fromName: "Kanera",
      },
      to: "ada@example.net",
      subject: "Delivery test",
      text: "Hello from Kanera",
    });
  });

  assert.equal(received.commands[0], "EHLO example.com");
  assert.match(received.message, /Message-ID: <[^>]+@example\.com>/);
  assert.doesNotMatch(received.commands.join("\n"), /kanera\.local/);
  assert.doesNotMatch(received.message, /kanera\.local/);
});

void test("HTML delivery writes extra headers and cannot be used to inject more", async () => {
  const received = await withSmtpServer(async (port) => {
    await sendEmail({
      config: { host: "127.0.0.1", port, security: "none", fromEmail: "noreply@example.com" },
      to: "ada@example.net",
      subject: "Header test",
      html: "<p>Hello</p>",
      headers: {
        "List-Unsubscribe": "<https://kanera.test/api/email/unsubscribe/one-click?token=t>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click\r\nBcc: attacker@example.com",
        "Bad Name": "ignored",
      },
    });
  });

  assert.match(received.message, /^List-Unsubscribe: <https:\/\/kanera\.test\/api\/email\/unsubscribe\/one-click\?token=t>\r$/m);
  assert.match(received.message, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click Bcc: attacker@example\.com\r$/m);
  assert.doesNotMatch(received.message, /^Bcc:/m);
  assert.doesNotMatch(received.message, /Bad Name/);
});

// Protocol fragmentation and read wakeups are invisible to a browser: a successful UI email flow
// also passes with the old per-response 25ms polling. Assert the mechanism alongside real TCP I/O.
// Event-driven reads can miss buffered greetings, accept incomplete multiline replies, leak read
// listeners/timeouts, or wait for the full timeout after disconnection; each can break real delivery.
void test("SMTP consumes split multiline replies without polling timers", async (t) => {
  const delays: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (...args: Parameters<typeof setTimeout>) => {
    delays.push(args[1] ?? 0);
    return originalSetTimeout(...args);
  });
  const received = await withSmtpServer(async (port) => {
    await sendEmail({
      config: { host: "127.0.0.1", port, security: "none", fromEmail: "noreply@example.com" },
      to: "ada@example.net", subject: "Fragmented replies", text: "The complete message",
    });
  }, true);
  assert.ok(received.commands.includes("QUIT"));
  assert.ok(received.message.includes(Buffer.from("The complete message").toString("base64")));
  assert.equal(delays.includes(25), false, "responses must wake on bytes, not 25ms polling");
});

void test("SMTP rejects a disconnected response promptly and closes the socket", { timeout: 2_000 }, async () => {
  const server = net.createServer((socket) => {
    socket.write("220 smtp.test ESMTP\r\n");
    socket.once("data", () => socket.end("250-incomplete multiline response\r\n"));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    await assert.rejects(sendEmail({
      config: { host: "127.0.0.1", port: address.port, security: "none", fromEmail: "noreply@example.com" },
      to: "ada@example.net", subject: "Disconnected server", text: "Must not hang",
    }), /closed before a complete response/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

async function withSmtpServer(run: (port: number) => Promise<void>, splitReplies = false): Promise<{ commands: string[]; message: string }> {
  const commands: string[] = [];
  let message = "";
  let dataMode = false;
  let buffer = "";

  const server = net.createServer((socket) => {
    const respond = (reply: string) => {
      if (!splitReplies) return socket.write(reply);
      // Split both inside a status code and across a multiline reply's terminator.
      socket.write(reply.slice(0, 2));
      setImmediate(() => {
        socket.write(reply.slice(2, -1));
        setImmediate(() => socket.write(reply.slice(-1)));
      });
    };
    socket.setEncoding("utf8");
    respond("220 smtp.test ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const rawLine = buffer.slice(0, newlineIndex + 1);
        buffer = buffer.slice(newlineIndex + 1);
        const line = rawLine.replace(/\r?\n$/, "");

        if (dataMode) {
          if (line === ".") {
            dataMode = false;
            respond("250 queued\r\n");
          } else {
            message += `${line}\r\n`;
          }
        } else {
          commands.push(line);
          if (line.startsWith("EHLO ")) respond("250-smtp.test\r\n250 OK\r\n");
          else if (line === "DATA") {
            dataMode = true;
            respond("354 send data\r\n");
          } else if (line === "QUIT") {
            respond("221 bye\r\n");
            if (!splitReplies) socket.end();
          } else {
            respond("250 OK\r\n");
          }
        }

        newlineIndex = buffer.indexOf("\n");
      }
    });
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    await run(address.port);
    return { commands, message };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}
