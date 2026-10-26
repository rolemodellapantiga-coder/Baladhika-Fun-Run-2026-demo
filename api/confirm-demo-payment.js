
"use strict";

// BALADHIKA FUN RUN 2026
// SIMULASI PEMBAYARAN SAJA
// TIDAK ADA TRANSAKSI UANG RIIL

const crypto = require("node:crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const OLD_ORDER_FORMAT = /^BFR-ORDER-[A-F0-9]{20}$/;
const NEW_ORDER_FORMAT = /^[A-Z0-9]{6}$/;
const TOKEN_FORMAT = /^[a-f0-9]{64}$/;

function reply(res, status, payload) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");

  return res.status(status).json(payload);
}

async function db(path, opts = {}) {
  const response = await fetch(
    `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/${path}`,
    {
      ...opts,
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        ...(opts.headers || {})
      },
      cache: "no-store"
    }
  );

  const raw = await response.text();

  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error("Respons database tidak valid");
  }

  if (!response.ok) {
    throw new Error(`Supabase HTTP ${response.status}`);
  }

  return data;
}

function query(params) {
  return new URLSearchParams(params).toString();
}

// Cari UUID pesanan melalui mapping.
// Mapping tetap digunakan sesudah migrasi,
// sehingga QR DEMO lama tidak kehilangan referensi.
async function resolveOrderId(orderNumber) {
  const isOld = OLD_ORDER_FORMAT.test(orderNumber);

  const column = isOld
    ? "old_order_number"
    : "new_order_number";

  const mapping = await db(
    "order_number_mapping_20261026?" +
      query({
        select: "order_id",
        [column]: `eq.${orderNumber}`,
        limit: "1"
      })
  );

  if (!Array.isArray(mapping)) {
    throw new Error("Respons mapping tidak valid");
  }

  return mapping.length === 1
    ? mapping[0].order_id
    : null;
}

const ORDER_FIELDS = [
  "id",
  "order_number",
  "buyer_name",
  "total_amount",
  "total_participants",
  "payment_method",
  "payment_status",
  "paid_at"
].join(",");

async function findOrder(orderNumber, tokenHash) {
  const mappedId = await resolveOrderId(orderNumber);

  const filters = {
    select: ORDER_FIELDS,
    demo_payment_token_hash: `eq.${tokenHash}`,
    limit: "1"
  };

  if (mappedId) {
    filters.id = `eq.${mappedId}`;
  } else {
    filters.order_number = `eq.${orderNumber}`;
  }

  const matched = await db(
    "orders?" + query(filters)
  );

  if (!Array.isArray(matched)) {
    throw new Error("Respons pesanan tidak valid");
  }

  return matched.length === 1
    ? matched[0]
    : null;
}

async function markPaid(order, tokenHash) {
  const filters = query({
    id: `eq.${order.id}`,
    demo_payment_token_hash: `eq.${tokenHash}`,
    payment_status: "eq.PENDING_DEMO"
  });

  const updated = await db(
    "orders?" + filters,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        payment_status: "PAID_DEMO",
        paid_at: new Date().toISOString()
      })
    }
  );

  if (!Array.isArray(updated)) {
    throw new Error("Respons pembaruan tidak valid");
  }

  if (updated.length === 1) {
    return updated[0];
  }

  // Jika ada dua permintaan konfirmasi bersamaan,
  // baca kembali status terbaru.
  const latest = await db(
    "orders?" +
      query({
        select: ORDER_FIELDS,
        id: `eq.${order.id}`,
        demo_payment_token_hash: `eq.${tokenHash}`,
        limit: "1"
      })
  );

  if (!Array.isArray(latest) || latest.length !== 1) {
    throw new Error("Pesanan tidak ditemukan setelah pembaruan");
  }

  return latest[0];
}

async function getParticipants(orderId) {
  const participants = await db(
    "participants?" +
      query({
        select: [
          "registration_number",
          "booking_code",
          "first_name",
          "last_name",
          "ticket_category",
          "jersey_size"
        ].join(","),
        order_id: `eq.${orderId}`,
        order: "created_at.asc"
      })
  );

  if (!Array.isArray(participants)) {
    throw new Error("Respons peserta tidak valid");
  }

  return participants;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return reply(res, 405, {
      success: false,
      error: "Metode tidak diizinkan."
    });
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return reply(res, 503, {
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
    return reply(res, 400, {
      success: false,
      error: "Format permintaan tidak valid."
    });
  }

  const orderNumber =
    typeof body?.order_number === "string"
      ? body.order_number.trim().toUpperCase()
      : "";

  const token =
    typeof body?.payment_token === "string"
      ? body.payment_token.trim()
      : "";

  const validOrder =
    OLD_ORDER_FORMAT.test(orderNumber) ||
    NEW_ORDER_FORMAT.test(orderNumber);

  if (!validOrder || !TOKEN_FORMAT.test(token)) {
    return reply(res, 400, {
      success: false,
      error:
        "Nomor pesanan atau token simulasi tidak valid."
    });
  }

  const tokenHash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  try {
    let order = await findOrder(
      orderNumber,
      tokenHash
    );

    if (!order) {
      return reply(res, 404, {
        success: false,
        error:
          "Pesanan atau token simulasi tidak cocok."
      });
    }

    if (order.payment_status === "CANCELLED_DEMO") {
      return reply(res, 409, {
        success: false,
        error:
          "Pesanan simulasi sudah dibatalkan."
      });
    }

    if (order.payment_status === "PENDING_DEMO") {
      order = await markPaid(order, tokenHash);
    }

    if (order.payment_status !== "PAID_DEMO") {
      return reply(res, 409, {
        success: false,
        error:
          "Status pesanan belum dapat diterbitkan sebagai invoice DEMO."
      });
    }

    const participants = await getParticipants(
      order.id
    );

    if (
      !participants.length ||
      participants.some(
        (person) => !person.booking_code
      )
    ) {
      return reply(res, 503, {
        success: false,
        error:
          "Pembayaran DEMO tercatat, tetapi data invoice belum lengkap. Silakan coba lagi."
      });
    }

    return reply(res, 200, {
      success: true,
      demo: true,

      // Selalu kembalikan nomor pesanan terkini.
      // Setelah migrasi, nomor ini menjadi 6 karakter.
      order_number: order.order_number,

      buyer_name: order.buyer_name,
      total_amount: order.total_amount,
      total_participants: order.total_participants,
      payment_method: order.payment_method,

      payment_status: "PAID_DEMO",
      paid_at: order.paid_at,

      participants,

      notice:
        "LUNAS — DEMO / TEST. BUKAN BUKTI PEMBAYARAN NYATA."
    });

  } catch (error) {
    console.error(
      "confirm-demo-payment:",
      error.message
    );

    return reply(res, 500, {
      success: false,
      error:
        "Konfirmasi simulasi gagal. Silakan coba kembali."
    });
  }
};
