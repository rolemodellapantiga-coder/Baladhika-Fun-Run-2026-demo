
"use strict";

const crypto = require("node:crypto");
const { generateInvoicePdf } = require("./invoice-pdf");

const BASE = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const RESEND_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "";
const SECRET = process.env.EMAIL_TEST_SECRET || "";

const TEST_ORDER = "BDJ-2KAM";
const TEST_EMAIL = "andiisyafa@gmail.com";

function reply(res, status, data) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(status).json(data);
}

function validSecret(provided, expected) {
  if (!provided || !expected) return false;

  const a = crypto.createHash("sha256")
    .update(String(provided)).digest();

  const b = crypto.createHash("sha256")
    .update(String(expected)).digest();

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

async function updateQueue(queueId, values) {
  const rows = await supabase(
    `/rest/v1/invoice_resend_queue?id=eq.${encodeURIComponent(queueId)}&status=eq.PROCESSING`,
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

  if (!rows?.length) {
    throw new Error("Status antrean gagal diperbarui");
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[ch]);
}

async function sendEmail(invoice, orderId, recipient) {
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
        to: [recipient],
        subject:
          `PERUBAHAN JADWAL - Invoice Terbaru ${invoice.orderNumber}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#183729">
            <h2>BALADHIKA FUN RUN 2026</h2>
            <p>Yth. Peserta,</p>

            <p>
              Kami informasikan bahwa jadwal
              BALADHIKA FUN RUN 2026 telah berubah.
            </p>

            <p>
              Nomor pesanan:
              <strong>${orderNumber}</strong>
            </p>

            <h3>JADWAL TERBARU</h3>
            <p>
              Pelaksanaan Fun Run:<br>
              <strong>Minggu, 13 Desember 2026</strong>
            </p>

            <h3>PENGAMBILAN RACEPACK</h3>
            <p>
              Tanggal: <strong>11-12 Desember 2026</strong><br>
              Waktu: 09.00-17.00 WIB<br>
              Tempat: Korem 083/BDJ
            </p>

            <p>
              <a href="https://maps.app.goo.gl/dYJC8VDHShwtpsqG6">
                Lihat lokasi pengambilan racepack
              </a>
            </p>

            <p>
              Pembayaran Anda tetap
              <strong>LUNAS</strong>.
              Kode booking tetap berlaku.
            </p>

            <p>
              Invoice terbaru terlampir dalam PDF.
              Mohon gunakan informasi jadwal terbaru
              untuk pengambilan racepack.
            </p>

            <p>
              Terima kasih atas pengertian Anda.
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
    // Respons tidak dapat dipastikan.
  }

  if (!response.ok || !data.id) {
    const error = new Error(
      `Resend HTTP ${response.status}: ${raw.slice(0, 300)}`
    );
    throw error;
  }

  return data.id;
}

async function processItem(item, mode) {
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

    if (mode === "TEST" && orderNumber !== TEST_ORDER) {
      throw new Error("Pesanan bukan target pengujian");
    }

    const invoice = await generateInvoicePdf(orderNumber);

    if (!invoice?.pdf?.length || !invoice?.filename) {
      throw new Error("PDF invoice tidak valid");
    }

    if (
      !invoice.buyerEmail ||
      !order.buyer_email ||
      invoice.buyerEmail.trim().toLowerCase() !==
        order.buyer_email.trim().toLowerCase()
    ) {
      throw new Error("Email invoice tidak sesuai dengan pesanan");
    }

    const recipient = mode === "TEST"
      ? TEST_EMAIL
      : order.buyer_email;

    const resendId = await sendEmail(
      invoice,
      orderId,
      recipient
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
      mode,
      resend_email_id: resendId
    };

  } catch (error) {
    console.error(
      "Invoice resend failed:",
      orderNumber || orderId,
      error
    );

    // Semua kegagalan ditahan untuk pemeriksaan manual.
    // Jangan mengirim ulang otomatis jika hasil
    // pengiriman sebelumnya belum dapat dipastikan.
    try {
      await updateQueue(queueId, {
        status: "FAILED",
        next_attempt_at: "2099-01-01T00:00:00.000Z",
        processing_started_at: null,
        last_error: String(error.message).slice(0, 500)
      });
    } catch (updateError) {
      console.error(
        "Gagal memperbarui antrean:",
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
      error: "Gunakan metode POST"
    });
  }

  if (!validSecret(req.headers["x-test-secret"], SECRET)) {
    return reply(res, 401, {
      success: false,
      error: "Akses ditolak"
    });
  }

  const mode = String(
    req.headers["x-resend-mode"] || ""
  ).toUpperCase();

  if (!["TEST", "BATCH"].includes(mode)) {
    return reply(res, 400, {
      success: false,
      error: "Mode harus TEST atau BATCH"
    });
  }

  if (!BASE || !KEY || !RESEND_KEY || !FROM_EMAIL) {
    return reply(res, 503, {
      success: false,
      error: "Konfigurasi server belum lengkap"
    });
  }

  try {
    const rpc = mode === "TEST"
      ? "claim_invoice_resend_test"
      : "claim_invoice_resend_queue";

    const claimed = await supabase(
      `/rest/v1/rpc/${rpc}`,
      {
        method: "POST",
        body: JSON.stringify(
          mode === "TEST"
            ? { p_order_number: TEST_ORDER }
            : {}
        )
      }
    );

    // Diproses satu per satu untuk mengurangi
    // beban Resend dan server.
    const results = [];

    for (const item of claimed || []) {
      results.push(await processItem(item, mode));
    }

    return reply(res, 200, {
      success: true,
      mode,
      processed: results.length,
      sent: results.filter(
        x => x.status === "SENT"
      ).length,
      failed: results.filter(
        x => x.status === "FAILED"
      ).length,
      results
    });

  } catch (error) {
    console.error("Invoice resend worker:", error);

    return reply(res, 503, {
      success: false,
      error: "Proses pengiriman ulang gagal"
    });
  }
};
