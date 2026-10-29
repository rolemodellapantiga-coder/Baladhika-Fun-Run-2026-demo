
"use strict";

// BALADHIKA FUN RUN 2026
// PENCARIAN STATUS PESANAN RESMI
// Nomor pesanan BDJ-XXXX, tanpa OTP atau token.
// Tidak menampilkan data pribadi peserta.

const SUPABASE_URL = (
  process.env.SUPABASE_URL || ""
).replace(/\/+$/, "");

const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const SHORT_FORMAT = /^[A-HJ-NP-Z2-9]{4}$/;
const FULL_FORMAT = /^BDJ-[A-HJ-NP-Z2-9]{4}$/;

const VALID_STATUSES = new Set([
  "PENDING_PAYMENT",
  "PAID"
]);

function send(res, status, payload) {
  res.setHeader(
    "Cache-Control",
    "private, no-store, max-age=0"
  );
  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  return res.status(status).json(payload);
}

async function findOrder(orderNumber) {
  const query = new URLSearchParams({
    select:
      "order_number,payment_status," +
      "payment_review_status",
    order_number: `eq.${orderNumber}`,
    limit: "1"
  });

  const url =
    `${SUPABASE_URL}/rest/v1/orders?${query}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Accept: "application/json"
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(
      `Supabase HTTP ${response.status}`
    );
  }

  const rows = await response.json();

  if (!Array.isArray(rows)) {
    throw new Error(
      "Respons Supabase tidak valid."
    );
  }

  return rows[0] || null;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return send(res, 405, {
      success: false,
      error: "Metode tidak diizinkan."
    });
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return send(res, 503, {
      success: false,
      error: "Konfigurasi server belum tersedia."
    });
  }

  let body;

  try {
    body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;
  } catch {
    return send(res, 400, {
      success: false,
      error: "Format JSON tidak valid."
    });
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Buffer.byteLength(JSON.stringify(body)) > 2048
  ) {
    return send(res, 400, {
      success: false,
      error: "Data permintaan tidak valid."
    });
  }

  const input =
    typeof body.order_number === "string"
      ? body.order_number.trim().toUpperCase()
      : "";

  let orderNumber;

  if (SHORT_FORMAT.test(input)) {
    orderNumber = `BDJ-${input}`;
  } else if (FULL_FORMAT.test(input)) {
    orderNumber = input;
  } else {
    return send(res, 400, {
      success: false,
      error:
        "Masukkan nomor pesanan BDJ-XXXX."
    });
  }

  try {
    const order = await findOrder(orderNumber);

    if (
      !order ||
      !VALID_STATUSES.has(order.payment_status)
    ) {
      return send(res, 404, {
        success: false,
        error: "Pesanan tidak ditemukan."
      });
    }

    const paid =
      order.payment_status === "PAID";

    const waiting =
      order.payment_review_status === "WAITING";

    let paymentNotice;

    if (paid) {
      paymentNotice =
        "Pembayaran telah dikonfirmasi LUNAS.";
    } else if (waiting) {
      paymentNotice =
        "Bukti pembayaran sedang diverifikasi admin.";
    } else {
      paymentNotice =
        "Pembayaran belum dikonfirmasi.";
    }

    return send(res, 200, {
      success: true,
      order_number: order.order_number,
      payment_status: order.payment_status,
      payment_review_status:
        order.payment_review_status,
      payment_notice: paymentNotice
    });

  } catch (error) {
    console.error(
      "check-order:",
      error.message
    );

    return send(res, 503, {
      success: false,
      error:
        "Pemeriksaan pesanan sementara tidak tersedia."
    });
  }
};
