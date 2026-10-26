"use strict";

// BALADHIKA FUN RUN 2026 — SIMULASI SAJA, TANPA PEMBAYARAN RIIL
const crypto = require("node:crypto");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function reply(res, status, payload) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(status).json(payload);
}

async function db(path, opts = {}) {
  const response = await fetch(`${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {})
    },
    cache: "no-store"
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { /* response not JSON */ }
  if (!response.ok) throw new Error(`Supabase HTTP ${response.status}`);
  return data;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return reply(res, 405, { success: false, error: "Metode tidak diizinkan." });
  if (!SUPABASE_URL || !SERVICE_KEY) return reply(res, 503, { success: false, error: "Konfigurasi server belum tersedia." });

  const orderNumber = typeof req.body?.order_number === "string" ? req.body.order_number.trim() : "";
  const token = typeof req.body?.payment_token === "string" ? req.body.payment_token.trim() : "";
  if (!/^BFR-ORDER-[A-F0-9]{20}$/.test(orderNumber) || !/^[a-f0-9]{64}$/.test(token)) {
    return reply(res, 400, { success: false, error: "Nomor pesanan atau token simulasi tidak valid." });
  }

  const hash = crypto.createHash("sha256").update(token).digest("hex");
  try {
    const filter = `order_number=eq.${encodeURIComponent(orderNumber)}&demo_payment_token_hash=eq.${hash}`;
    const matched = await db(`orders?select=id,order_number,buyer_name,total_amount,total_participants,payment_method,payment_status,paid_at&${filter}&limit=1`);
    if (!Array.isArray(matched) || matched.length !== 1) {
      return reply(res, 404, { success: false, error: "Pesanan atau token simulasi tidak cocok." });
    }

    let order = matched[0];
    if (order.payment_status === "CANCELLED_DEMO") {
      return reply(res, 409, { success: false, error: "Pesanan simulasi sudah dibatalkan." });
    }
    if (order.payment_status === "PENDING_DEMO") {
      const updated = await db(`orders?${filter}&payment_status=eq.PENDING_DEMO`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ payment_status: "PAID_DEMO", paid_at: new Date().toISOString() })
      });
      if (Array.isArray(updated) && updated.length === 1) {
        order = updated[0];
      } else {
        // Another request may have processed the same payment; read the result.
        const latest = await db(`orders?select=id,order_number,buyer_name,total_amount,total_participants,payment_method,payment_status,paid_at&${filter}&limit=1`);
        if (!Array.isArray(latest) || latest.length !== 1) throw new Error("Order disappeared after update");
        order = latest[0];
      }
    }
    if (order.payment_status !== "PAID_DEMO") {
      return reply(res, 409, { success: false, error: "Status pesanan belum dapat diterbitkan sebagai invoice DEMO." });
    }

    const participants = await db(`participants?select=registration_number,booking_code,first_name,last_name,ticket_category,jersey_size&order_id=eq.${encodeURIComponent(order.id)}&order=created_at.asc`);
    if (!Array.isArray(participants) || !participants.length || participants.some(p => !p.booking_code)) {
      return reply(res, 503, { success: false, error: "Pembayaran DEMO tercatat, tetapi data invoice belum lengkap. Coba lagi." });
    }

    return reply(res, 200, {
      success: true,
      demo: true,
      order_number: order.order_number,
      buyer_name: order.buyer_name,
      total_amount: order.total_amount,
      total_participants: order.total_participants,
      payment_method: order.payment_method,
      payment_status: "PAID_DEMO",
      paid_at: order.paid_at,
      participants,
      notice: "LUNAS — DEMO / TEST. BUKAN BUKTI PEMBAYARAN NYATA."
    });
  } catch (error) {
    console.error("confirm-demo-payment:", error.message);
    return reply(res, 500, { success: false, error: "Konfirmasi simulasi gagal. Silakan coba kembali." });
  }
};
