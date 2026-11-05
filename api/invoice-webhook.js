
import crypto from "node:crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const webhookSecret = process.env.INVOICE_WEBHOOK_SECRET;
  const cronSecret = process.env.CRON_SECRET;

  if (!webhookSecret || !cronSecret) {
    return res.status(500).json({
      error: "Server configuration incomplete"
    });
  }

  const authorization = req.headers.authorization || "";
  const expected = `Bearer ${webhookSecret}`;

  const receivedBuffer = Buffer.from(authorization);
  const expectedBuffer = Buffer.from(expected);

  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const response = await fetch(
      "https://www.baladhikafunrun.com/api/send-invoice-emails",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cronSecret}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      }
    );

    const result = await response.json();

    return res.status(response.status).json(result);
  } catch (error) {
    console.error("Invoice webhook error:", error.message);

    return res.status(500).json({
      error: "Failed to process invoice webhook"
    });
  }
}
