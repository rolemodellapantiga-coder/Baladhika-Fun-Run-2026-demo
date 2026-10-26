
"use strict";

// BALADHIKA FUN RUN 2026 — DEMO ONLY
// API CEK PESANAN
// Mendukung nomor pesanan lama dan 6 karakter.
// WAJIB aktifkan rate limiting di Vercel Firewall.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const OLD_FORMAT = /^BFR-ORDER-[A-F0-9]{20}$/;
const NEW_FORMAT = /^[A-Z0-9]{6}$/;

const VALID_STATUSES = new Set([
  "PENDING_DEMO",
  "PAID_DEMO"
]);

function send(res, status, payload) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");

  return res.status(status).json(payload);
}

async function readRows(table, filters, fields) {
  const query = new URLSearchParams({
    select: fields,
    ...filters,
    limit: "1"
  });

  const url =
    `${SUPABASE_URL.replace(/\/+$/, "")}` +
    `/rest/v1/${table}?${query}`;

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
    throw new Error("Invalid Supabase response");
  }

  return rows;
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

  const body =
    req.body &&
    typeof req.body === "object" &&
    !Array.isArray(req.body)
      ? req.body
      : {};

  const number =
    typeof body.order_number === "string"
      ? body.order_number.trim().toUpperCase()
      : "";

  if (
    !OLD_FORMAT.test(number) &&
    !NEW_FORMAT.test(number)
  ) {
    return send(res, 400, {
      success: false,
      error: "Format nomor pesanan tidak valid."
    });
  }

  try {
    let orderId = null;

    const filterName = OLD_FORMAT.test(number)
      ? "old_order_number"
      : "new_order_number";

    const mappings = await readRows(
      "order_number_mapping_20261026",
      {
        [filterName]: `eq.${number}`
      },
      "order_id"
    );

    if (mappings.length) {
      orderId = mappings[0].order_id;
    }

    const orders = await readRows(
      "orders",
      orderId
        ? { id: `eq.${orderId}` }
        : { order_number: `eq.${number}` },
      [
        "order_number",
        "payment_status",
        "payment_expires_at",
        "expiry_policy_version"
      ].join(",")
    );

    if (
      !orders.length ||
      !VALID_STATUSES.has(orders[0].payment_status)
    ) {
      return send(res, 404, {
        success: false,
        error: "Pesanan tidak ditemukan."
      });
    }

    const order = orders[0];
    const paid = order.payment_status === "PAID_DEMO";

    const hasExpiry =
      Number(order.expiry_policy_version) === 1 &&
      Boolean(order.payment_expires_at);

    const expiresAt = hasExpiry
      ? Date.parse(order.payment_expires_at)
      : NaN;

    const now = Date.now();

    const remainingSeconds =
      !paid && Number.isFinite(expiresAt)
        ? Math.max(0, Math.ceil((expiresAt - now) / 1000))
        : null;

    const expired =
      !paid &&
      hasExpiry &&
      Number.isFinite(expiresAt) &&
      remainingSeconds === 0;

    let paymentNotice;

    if (paid) {
      paymentNotice =
        "Pembayaran DEMO sudah dikonfirmasi.";
    } else if (expired) {
      paymentNotice =
        "Batas pembayaran 1 jam telah berakhir. " +
        "Pesanan menunggu proses penghapusan otomatis.";
    } else if (hasExpiry) {
      paymentNotice =
        "Selesaikan pembayaran sebelum batas waktu 1 jam berakhir.";
    } else {
      paymentNotice =
        "Pesanan menggunakan ketentuan pembayaran sebelumnya.";
    }

    return send(res, 200, {
      success: true,
      demo: true,

      order_number: order.order_number,
      payment_status: order.payment_status,

      payment_expires_at:
        hasExpiry ? order.payment_expires_at : null,

      expiry_policy_version:
        Number(order.expiry_policy_version) || 0,

      payment_remaining_seconds: remainingSeconds,

      payment_expired: expired,

      payment_notice: paymentNotice,

      server_time: new Date(now).toISOString(),

      notice:
        "SIMULASI / TEST — bukan bukti pembayaran nyata."
    });

  } catch (error) {
    console.error("Order lookup failed:", error.message);

    return send(res, 503, {
      success: false,
      error: "Pemeriksaan pesanan belum tersedia."
    });
  }
};
