
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      message: "Method not allowed"
    });
  }

  const crypto = await import("node:crypto");

  const secret = process.env.EMAIL_TEST_SECRET;
  const provided = req.headers["x-email-test-secret"];

  if (!secret || typeof provided !== "string") {
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }

  const a = Buffer.from(secret);
  const b = Buffer.from(provided);

  if (a.length !== b.length ||
      !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }

  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) {
    return res.status(500).json({
      ok: false,
      message: "Email configuration incomplete"
    });
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL,
        to: ["andiisyafa@gmail.com"],
        subject: "Tes Email BALADHIKA FUN RUN 2026",
        text: "Ini adalah email pengujian resmi BALADHIKA FUN RUN 2026. Sistem pengiriman email berhasil dijalankan. Tidak ada pendaftaran atau pembayaran yang dilakukan."
      })
    });

    const result = await response.json();

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        message: "Resend rejected the email",
        detail: result.message || result.name || "Unknown error"
      });
    }

    return res.status(200).json({
      ok: true,
      message: "Permintaan pengiriman email diterima Resend",
      email_id: result.id
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Email test failed"
    });
  }
}
