
"use strict";

const crypto = require("node:crypto");
const { generateInvoicePdf } = require("./invoice-pdf");

const TEST_EMAIL = "andiisyafa@gmail.com";
const TEST_ORDER = "BDJ-2KAM";

function respond(res, status, data) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(status).json(data);
}

function validSecret(provided, expected) {
  if (!provided || !expected) return false;

  const a = crypto
    .createHash("sha256")
    .update(provided)
    .digest();

  const b = crypto
    .createHash("sha256")
    .update(expected)
    .digest();

  return crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return respond(res, 405, {
      success: false,
      error: "Gunakan metode POST."
    });
  }

  const expectedSecret = process.env.EMAIL_TEST_SECRET;
  const providedSecret = req.headers["x-test-secret"];

  if (!validSecret(providedSecret, expectedSecret)) {
    return respond(res, 401, {
      success: false,
      error: "Akses pengujian ditolak."
    });
  }

  if (
    !process.env.RESEND_API_KEY ||
    !process.env.RESEND_FROM_EMAIL
  ) {
    return respond(res, 503, {
      success: false,
      error: "Konfigurasi Resend belum lengkap."
    });
  }

  try {
    const invoice = await generateInvoicePdf(TEST_ORDER);

    if (!invoice.pdf || invoice.pdf.length === 0) {
      throw new Error("PDF invoice kosong.");
    }

    const response = await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from:
            `BALADHIKA FUN RUN 2026 <${process.env.RESEND_FROM_EMAIL}>`,
          to: [TEST_EMAIL],
          subject:
            `[TEST] Invoice LUNAS - ${invoice.orderNumber}`,
          html: `
            <div style="font-family:Arial,sans-serif;
                        max-width:600px;margin:auto">
              <h2 style="color:#183729">
                BALADHIKA FUN RUN 2026
              </h2>

              <p><strong>EMAIL PENGUJIAN SISTEM</strong></p>

              <p>
                Ini adalah percobaan pengiriman
                invoice pembayaran melalui Resend.
              </p>

              <p>
                Nomor pesanan:
                <strong>${invoice.orderNumber}</strong>
              </p>

              <p>
                File PDF invoice LUNAS terlampir.
              </p>

              <p>
                Email ini bukan konfirmasi pembayaran baru.
              </p>
            </div>
          `,
          attachments: [
            {
              filename: invoice.filename,
              content: invoice.pdf.toString("base64"),
              content_type: "application/pdf"
            }
          ]
        }),
        signal: AbortSignal.timeout(20000)
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.error("Resend test error:", {
        status: response.status,
        error: result
      });

      return respond(res, 502, {
        success: false,
        error: "Resend menolak pengiriman email percobaan."
      });
    }

    return respond(res, 200, {
      success: true,
      message: "Email percobaan diterima oleh Resend.",
      recipient: TEST_EMAIL,
      order_number: invoice.orderNumber,
      pdf_bytes: invoice.pdf.length,
      resend_email_id: result.id || null
    });
  } catch (error) {
    console.error("Invoice email test:", error);

    return respond(res, 503, {
      success: false,
      error: "Pengujian invoice belum berhasil."
    });
  }
};
