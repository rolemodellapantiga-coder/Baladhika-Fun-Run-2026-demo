
"use strict";

// BALADHIKA FUN RUN 2026
// Penerbit kode verifikasi bukti simulasi.
// DEMO / TEST — TIDAK ADA TRANSAKSI UANG NYATA.

const crypto = require("node:crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PROOF_SECRET = process.env.DEMO_PROOF_SECRET;

const ORDER_RE = /^BDJ-[A-HJ-NP-Z2-9]{5}$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;

function reply(res, status, data) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(status).json(data);
}

function sign(value) {
  return crypto
    .createHmac("sha256", PROOF_SECRET)
    .update(value)
    .digest("hex");
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return reply(res, 405, {
      success: false,
      error: "Metode tidak diizinkan."
    });
  }

  if (!SUPABASE_URL || !SERVICE_KEY || !PROOF_SECRET) {
    return reply(res, 503, {
      success: false,
      error: "Konfigurasi server belum lengkap."
    });
  }

  let body;

  try {
    body = typeof req.body === "string"
      ? JSON.parse(req.body)
      : req.body;
  } catch {
    return reply(res, 400, {
      success: false,
      error: "Format JSON tidak valid."
    });
  }

  const orderNumber = String(
    body?.order_number || ""
  ).trim().toUpperCase();

  const paymentToken = String(
    body?.payment_token || ""
  ).trim();

  if (
    !ORDER_RE.test(orderNumber) ||
    !TOKEN_RE.test(paymentToken)
  ) {
    return reply(res, 400, {
      success: false,
      error: "Nomor pesanan atau token tidak valid."
    });
  }

  const tokenHash = crypto
    .createHash("sha256")
    .update(paymentToken)
    .digest("hex");

  try {
    const params = new URLSearchParams({
      select: "id,order_number,payment_status",
      order_number: `eq.${orderNumber}`,
      demo_payment_token_hash: `eq.${tokenHash}`,
      limit: "1"
    });

    const response = await fetch(
      `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/orders?${params}`,
      {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`
        },
        cache: "no-store"
      }
    );

    if (!response.ok) {
      throw new Error("DATABASE_ERROR");
    }

    const orders = await response.json();

    if (!Array.isArray(orders) || orders.length !== 1) {
      return reply(res, 404, {
        success: false,
        error: "Pesanan atau token tidak cocok."
      });
    }

    const order = orders[0];

    if (order.payment_status !== "PENDING_DEMO") {
      return reply(res, 409, {
        success: false,
        error: "Pesanan bukan dalam status PENDING_DEMO."
      });
    }

    const nonce = crypto.randomBytes(16).toString("hex");

    const payload = [
      "BALADHIKA-DEMO-V1",
      orderNumber,
      order.id,
      nonce
    ].join("|");

    const signature = sign(payload);

    return reply(res, 200, {
      success: true,
      demo: true,
      order_number: orderNumber,
      proof_payload: payload,
      proof_signature: signature,
      notice:
        "DEMO / TEST — BUKAN BUKTI PEMBAYARAN SAH"
    });

  } catch (error) {
    console.error(
      "issue-demo-proof:",
      error?.message || "UNKNOWN"
    );

    return reply(res, 500, {
      success: false,
      error: "Gagal menerbitkan kode bukti DEMO."
    });
  }
};
