const webhookUrl = process.env.ALERT_WEBHOOK_URL;
const alertsEnabled = process.env.OPS_ALERTS_ENABLED !== "false";

if (webhookUrl && alertsEnabled) {
  const timestamp = new Date().toISOString();
  const title = "🔵 INFO — Kanera deployment ready";
  const payload = {
    text: title,
    attachments: [{
      color: "#0f766e",
      title,
      fallback: title,
      fields: [
        { title: "🔵 INFO", value: "all core services are healthy", short: true },
        { title: "Environment", value: process.env.KANERA_ENVIRONMENT ?? "production", short: true },
        { title: "Time", value: timestamp, short: true },
      ],
      footer: "Kanera operational alert",
    }],
  };

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Kanera-Ops-Alerts/1.0" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) console.warn(`deployment-ready webhook returned HTTP ${response.status}`);
  } catch (error) {
    // Notification delivery must not turn an otherwise healthy deployment into a failed deployment.
    console.warn("deployment-ready webhook delivery failed", error);
  }
}
