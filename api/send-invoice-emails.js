
"use strict";

const crypto = require("node:crypto");
const { generateInvoicePdf } = require("./invoice-pdf");

const BASE = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const RESEND_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "";
const CRON_SECRET = process.env.CRON_SECRET || "";

function reply(res, status, data) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(status).json(data);
}

function authorized(req) {
  const expected = CRON_SECRET;
  const provided = String(
    req.headers.authorization || ""
  ).replace(/^Bearer\s+/i, "");

  if (!expected || !provided) return false;

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

async function supabase(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(12000),
    cache: "no-store"
  });

  const raw = await response.text();

  let data = null;

  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error("Respons Supabase tidak valid");
    }
  }

  if (!response.ok) {
    throw new Error(
      `Supabase HTTP ${response.status}: ${raw.slice(0, 300)}`
    );
  }

  return data;
}

async function updateQueue(queueId, values) {
  return supabase(
    `/rest/v1/invoice_email_queue?id=eq.${encodeURIComponent(queueId)}&status=eq.PROCESSING`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        ...values,
        updated_at: new Date().toISOString()
      })
    }
  );
}

async function getOrder(orderId) {
  const rows = await supabase(
    `/rest/v1/orders?${new URLSearchParams({
      select:
        "id,order_number,buyer_email,payment_status,payment_review_status,payment_email_sent_at",
      id: `eq.${orderId}`,
      limit: "1"
    })}`
  );

  return rows?.[0] || null;
}

async function sendEmail(invoice, orderId) {
  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `bdj-invoice-${orderId}-v1`
      },
      body: JSON.stringify({
        from: `BALADHIKA FUN RUN 2026 <${FROM_EMAIL}>`,
        to: [invoice.buyerEmail],
        subject:
          `Invoice Pembayaran LUNAS - ${invoice.orderNumber}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#183729">
            <h2>BALADHIKA FUN RUN 2026</h2>
            <p>Yth. Peserta,</p>
            <p>
              Pembayaran pesanan
              <strong>${invoice.orderNumber}</strong>
              telah diverifikasi dan dinyatakan
              <strong>LUNAS</strong>.
            </p>
            <p>
              Invoice PDF terlampir sebagai bukti pembayaran
              dan informasi pengambilan racepack.
            </p>
            <p>
              Simpan invoice dan kode booking Anda
              untuk pengambilan racepack.
            </p>
            <p>Terima kasih atas partisipasi Anda.</p>
            <p><strong>Panitia BALADHIKA FUN RUN 2026</strong></p>
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

  const raw = await response.text();

  let data = {};

  try {
    data = JSON.parse(raw);
  } catch {
    // Respons tidak dapat dipastikan.
  }

  if (!response.ok || !data.id) {
    const error = new Error(
      `Resend HTTP ${response.status}: ${raw.slice(0, 300)}`
    );

    error.resendStatus = response.status;
    throw error;
  }

  return data.id;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return reply(res, 405, {
      success: false,
      error: "Metode tidak diizinkan"
    });
  }

  if (!authorized(req)) {
    return reply(res, 401, {
      success: false,
      error: "Akses ditolak"
    });
  }

  if (
    !BASE ||
    !KEY ||
    !RESEND_KEY ||
    !FROM_EMAIL
  ) {
    return reply(res, 503, {
      success: false,
      error: "Konfigurasi server belum lengkap"
    });
  }

  const results = [];

  try {
    const claimed = await supabase(
      "/rest/v1/rpc/claim_invoice_email_queue",
      {
        method: "POST",
        body: JSON.stringify({})
      }
    );

    for (const item of claimed || []) {
      const queueId = item.queue_id;
      const orderId = item.claimed_order_id;

      let orderNumber = null;
      let resendAccepted = false;

      try {
        const order = await getOrder(orderId);

        if (!order) {
          throw new Error("Pesanan tidak ditemukan");
        }

        orderNumber = order.order_number;

        if (
          order.payment_status !== "PAID" ||
          order.payment_review_status !== "APPROVED"
        ) {
          throw new Error("Pembayaran belum disetujui OWNER");
        }

        if (order.payment_email_sent_at) {
          const updated = await updateQueue(queueId, {
            status: "SENT",
            sent_at: order.payment_email_sent_at,
            processing_started_at: null,
            last_error: null
          });

          if (!updated?.length) {
            throw new Error("Gagal memperbarui antrean");
          }

          results.push({
            order_number: orderNumber,
            status: "ALREADY_SENT"
          });

          continue;
        }

        const invoice = await generateInvoicePdf(
          order.order_number
        );

        const resendId = await sendEmail(
          invoice,
          orderId
        );

        resendAccepted = true;

        const sentAt = new Date().toISOString();

        const updated = await updateQueue(queueId, {
          status: "SENT",
          sent_at: sentAt,
          resend_email_id: resendId,
          processing_started_at: null,
          last_error: null
        });

        if (!updated?.length) {
          throw new Error(
            "Resend menerima email, tetapi status antrean gagal diperbarui"
          );
        }

        try {
          await supabase(
            `/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&payment_email_sent_at=is.null`,
            {
              method: "PATCH",
              body: JSON.stringify({
                payment_email_sent_at: sentAt
              })
            }
          );
        } catch (error) {
          console.error(
            "Gagal memperbarui timestamp order:",
            orderNumber,
            error.message
          );
        }

        results.push({
          order_number: orderNumber,
          status: "SENT",
          resend_email_id: resendId
        });

      } catch (error) {
        console.error(
          "Invoice email failed:",
          orderNumber || orderId,
          error
        );

        // Jika respons pengiriman tidak pasti,
        // tahan antrean agar tidak otomatis dikirim ulang.
        const uncertain =
          resendAccepted ||
          !error.resendStatus ||
          error.resendStatus >= 500 ||
          error.resendStatus === 429;

        const retryAt = uncertain
          ? "2099-01-01T00:00:00.000Z"
          : new Date(
              Date.now() + 30 * 60 * 1000
            ).toISOString();

        try {
          await updateQueue(queueId, {
            status: "FAILED",
            next_attempt_at: retryAt,
            processing_started_at: null,
            last_error: String(error.message).slice(0, 500)
          });
        } catch (updateError) {
          console.error(
            "Gagal memperbarui status antrean:",
            updateError
          );
        }

        results.push({
          order_number: orderNumber,
          status: "FAILED",
          requires_review: uncertain
        });
      }
    }

    return reply(res, 200, {
      success: true,
      processed: results.length,
      results
    });

  } catch (error) {
    console.error("Invoice worker error:", error);

    return reply(res, 503, {
      success: false,
      error: "Proses pengiriman invoice gagal"
    });
  }
};
