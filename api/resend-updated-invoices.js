
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
  const token = String(
    req.headers.authorization || ""
  ).replace(/^Bearer\s+/i, "");

  if (!CRON_SECRET || !token) return false;

  const a = crypto.createHash("sha256")
    .update(token).digest();

  const b = crypto.createHash("sha256")
    .update(CRON_SECRET).digest();

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
  const rows = await supabase(
    `/rest/v1/invoice_resend_queue?id=eq.${encodeURIComponent(queueId)}&status=eq.PROCESSING`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        ...values,
        updated_at: new Date().toISOString()
      })
    }
  );

  if (!rows?.length) {
    throw new Error("Gagal memperbarui antrean");
  }

  return rows;
}

async function getOrder(orderId) {
  const rows = await supabase(
    `/rest/v1/orders?${new URLSearchParams({
      select: "id,order_number,buyer_email,payment_status,payment_review_status,payment_email_sent_at",
      id: `eq.${orderId}`,
      limit: "1"
    })}`
  );

  return rows?.[0] || null;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

async function sendUpdatedEmail(invoice, orderId) {
  const orderNumber = escapeHtml(invoice.orderNumber);

  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key":
          `bdj-schedule-update-${orderId}-20261213-v1`
      },
      body: JSON.stringify({
        from: `BALADHIKA FUN RUN 2026 <${FROM_EMAIL}>`,
        to: [invoice.buyerEmail],
        subject:
          `PERUBAHAN JADWAL - Invoice Terbaru ${invoice.orderNumber}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#183729">
            <h2>BALADHIKA FUN RUN 2026</h2>
            <p>Yth. Peserta,</p>

            <p>
              Kami informasikan bahwa jadwal
              BALADHIKA FUN RUN 2026 mengalami perubahan.
            </p>

            <p>
              Nomor pesanan:
              <strong>${orderNumber}</strong>
            </p>

            <p><strong>JADWAL PELAKSANAAN TERBARU</strong></p>
            <p>
              Minggu, <strong>13 Desember 2026</strong>
            </p>

            <p><strong>PENGAMBILAN RACEPACK</strong></p>
            <p>
              Tanggal: <strong>11-12 Desember 2026</strong><br>
              Waktu: 09.00-17.00 WIB<br>
              Tempat: Korem 083/BDJ
            </p>

            <p>
              Lokasi:
              <a href="https://maps.app.goo.gl/dYJC8VDHShwtpsqG6">
                Google Maps
              </a>
            </p>

            <p>
              Pembayaran Anda tetap
              <strong>LUNAS</strong>.
              Nomor pesanan dan kode booking
              tetap berlaku.
            </p>

            <p>
              Invoice PDF dengan jadwal terbaru
              kami lampirkan pada email ini.
            </p>

            <p>
              Terima kasih atas pengertian
              dan partisipasi Anda.
            </p>

            <p>
              <strong>Panitia BALADHIKA FUN RUN 2026</strong>
            </p>
          </div>
        `,
        attachments: [{
          filename: invoice.filename,
          content: invoice.pdf.toString("base64"),
          content_type: "application/pdf"
        }]
      }),
      signal: AbortSignal.timeout(20000)
    }
  );

  const raw = await response.text();
  let data = {};

  try {
    data = JSON.parse(raw);
  } catch {
    // Respons pengiriman tidak dapat dipastikan.
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

async function processItem(item) {
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
      order.payment_review_status !== "APPROVED" ||
      !order.payment_email_sent_at
    ) {
      throw new Error("Pesanan tidak memenuhi syarat");
    }

    if (
      !order.buyer_email ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(order.buyer_email)
    ) {
      throw new Error("Email pembeli tidak valid");
    }

    const invoice = await generateInvoicePdf(
      order.order_number
    );

    if (
      !invoice?.pdf ||
      !invoice?.buyerEmail ||
      invoice.buyerEmail.toLowerCase() !==
        order.buyer_email.toLowerCase()
    ) {
      throw new Error("Data penerima invoice tidak sesuai");
    }

    const resendId = await sendUpdatedEmail(
      invoice,
      orderId
    );

    resendAccepted = true;

    await updateQueue(queueId, {
      status: "SENT",
      sent_at: new Date().toISOString(),
      resend_email_id: resendId,
      processing_started_at: null,
      last_error: null
    });

    return {
      order_number: orderNumber,
      status: "SENT",
      resend_email_id: resendId
    };

  } catch (error) {
    console.error(
      "Updated invoice failed:",
      orderNumber || orderId,
      error
    );

    // Jangan kirim ulang otomatis bila hasil
    // pengiriman belum dapat dipastikan.
    try {
      await updateQueue(queueId, {
        status: "FAILED",
        next_attempt_at: "2099-01-01T00:00:00.000Z",
        processing_started_at: null,
        last_error: String(error.message).slice(0, 500)
      });
    } catch (updateError) {
      console.error(
        "Queue update failed:",
        updateError
      );
    }

    return {
      order_number: orderNumber,
      status: "FAILED",
      requires_review: true,
      resend_accepted: resendAccepted
    };
  }
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

  if (!BASE || !KEY || !RESEND_KEY || !FROM_EMAIL) {
    return reply(res, 503, {
      success: false,
      error: "Konfigurasi belum lengkap"
    });
  }

  try {
    const claimed = await supabase(
      "/rest/v1/rpc/claim_invoice_resend_queue",
      {
        method: "POST",
        body: JSON.stringify({})
      }
    );

    const results = await Promise.all(
      (claimed || []).map(processItem)
    );

    return reply(res, 200, {
      success: true,
      processed: results.length,
      sent: results.filter(
        r => r.status === "SENT"
      ).length,
      failed: results.filter(
        r => r.status === "FAILED"
      ).length,
      results
    });

  } catch (error) {
    console.error(
      "Updated invoice worker error:",
      error
    );

    return reply(res, 503, {
      success: false,
      error: "Proses pengiriman ulang gagal"
    });
  }
};
