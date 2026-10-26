
"use strict";

// BALADHIKA FUN RUN 2026
// API CEK PESANAN — KHUSUS DEMO

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const OLD_FORMAT = /^BFR-ORDER-[A-F0-9]{20}$/;
const NEW_FORMAT = /^[A-Z0-9]{6}$/;

function respond(res, code, data) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(code).json(data);
}

async function select(table, query) {
  const url =
    SUPABASE_URL.replace(/\/+$/, "") +
    "/rest/v1/" + table + "?" + query.toString();

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
    throw new Error("Database error: " + response.status);
  }

  return response.json();
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return respond(res, 405, {
      success: false,
      error: "Metode tidak diizinkan."
    });
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return respond(res, 503, {
      success: false,
      error: "Konfigurasi server belum tersedia."
    });
  }

  const body = req.body || {};

  const orderNumber =
    typeof body.order_number === "string"
      ? body.order_number.trim().toUpperCase()
      : "";

  const email =
    typeof body.buyer_email === "string"
      ? body.buyer_email.trim().toLowerCase()
      : "";

  if (
    !(OLD_FORMAT.test(orderNumber) ||
      NEW_FORMAT.test(orderNumber)) ||
    email.length < 3 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return respond(res, 400, {
      success: false,
      error: "Format nomor pesanan atau email tidak valid."
    });
  }

  try {
    let orderId = null;
    let displayNumber = orderNumber;

    // Mendukung nomor lama dan nomor baru
    const mapQuery = new URLSearchParams({
      select: "order_id,old_order_number,new_order_number",
      [OLD_FORMAT.test(orderNumber)
        ? "old_order_number"
        : "new_order_number"]: "eq." + orderNumber,
      limit: "1"
    });

    const mapped = await select(
      "order_number_mapping_20261026",
      mapQuery
    );

    if (mapped.length === 1) {
      orderId = mapped[0].order_id;
      displayNumber = mapped[0].new_order_number;
    }

    // Email pemesan wajib cocok
    const query = new URLSearchParams({
      select:
        "id,order_number,buyer_name,total_participants,total_amount,payment_status",
      buyer_email: "eq." + email,
      ...(orderId
        ? { id: "eq." + orderId }
        : { order_number: "eq." + orderNumber }),
      limit: "1"
    });

    const orders = await select("orders", query);

    if (orders.length !== 1) {
      return respond(res, 404, {
        success: false,
        error: "Pesanan tidak ditemukan atau email tidak cocok."
      });
    }

    const order = orders[0];

    return respond(res, 200, {
      success: true,
      demo: true,
      order_number: displayNumber,
      buyer_name: order.buyer_name,
      total_participants: order.total_participants,
      total_amount: order.total_amount,
      payment_status: order.payment_status,
      notice: "SIMULASI / TEST — bukan bukti pembayaran nyata."
    });

  } catch (error) {
    console.error("Check order error:", error.message);

    return respond(res, 503, {
      success: false,
      error: "Pemeriksaan pesanan belum tersedia."
    });
  }
};
