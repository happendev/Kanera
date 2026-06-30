import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { sendEmail } from "./smtp.js";

test("SMTP delivery uses sender domain for EHLO and Message-ID", async () => {
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

async function withSmtpServer(run: (port: number) => Promise<void>): Promise<{ commands: string[]; message: string }> {
  const commands: string[] = [];
  let message = "";
  let dataMode = false;
  let buffer = "";

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("220 smtp.test ESMTP\r\n");
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
            socket.write("250 queued\r\n");
          } else {
            message += `${line}\r\n`;
          }
        } else {
          commands.push(line);
          if (line.startsWith("EHLO ")) socket.write("250-smtp.test\r\n250 OK\r\n");
          else if (line === "DATA") {
            dataMode = true;
            socket.write("354 send data\r\n");
          } else if (line === "QUIT") {
            socket.write("221 bye\r\n");
            socket.end();
          } else {
            socket.write("250 OK\r\n");
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
