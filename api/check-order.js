
"use strict";

// BALADHIKA FUN RUN 2026
// API CARI PESANAN — DEMO ONLY
// Hanya menampilkan status pembayaran simulasi.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SHORT_FORMAT = /^[A-HJ-NP-Z2-9]{5}$/;
const FULL_FORMAT = /^BDJ-[A-HJ-NP-Z2-9]{5}$/;

const VALID_STATUSES = new Set([
  "PENDING_DEMO",
  "PAID_DEMO"
]);

function send(res, status, payload) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(status).json(payload);
}

async function findOrder(orderNumber) {
  const query = new URLSearchParams({
    select: "order_number,payment_status",
    order_number: `eq.${orderNumber}`,
    limit: "1"
  });

  const url =
    `${SUPABASE_URL.replace(/\/+$/, "")}` +
    `/rest/v1/orders?${query.toString()}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Accept: "application/json"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Supabase HTTP ${response.status}`);
  }

  const rows = await response.json();

  if (!Array.isArray(rows)) {
    throw new Error("Respons Supabase tidak valid.");
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
    body = typeof req.body === "string"
      ? JSON.parse(req.body)
      : req.body;
  } catch {
    return send(res, 400, {
      success: false,
      error: "Format JSON tidak valid."
    });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return send(res, 400, {
      success: false,
      error: "Data permintaan tidak valid."
    });
  }

  const input = typeof body.order_number === "string"
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
      error: "Masukkan 5 karakter kode pesanan yang valid."
    });
  }

  try {
    const order = await findOrder(orderNumber);

    if (!order || !VALID_STATUSES.has(order.payment_status)) {
      return send(res, 404, {
        success: false,
        error: "Pesanan tidak ditemukan."
      });
    }

    const paid = order.payment_status === "PAID_DEMO";

    return send(res, 200, {
      success: true,
      demo: true,
      order_number: order.order_number,
      payment_status: order.payment_status,
      payment_notice: paid
        ? "Pembayaran simulasi telah dikonfirmasi."
        : "Pembayaran simulasi belum dikonfirmasi.",
      notice:
        "DEMO / TEST — BUKAN BUKTI PEMBAYARAN SAH"
    });

  } catch (error) {
    console.error("check-order:", error.message);

    return send(res, 503, {
      success: false,
      error: "Pemeriksaan pesanan sementara belum tersedia."
    });
  }
};
