
"use strict";

const crypto = require("node:crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ORDER_PATTERN = /^BDJ-[A-HJ-NP-Z2-9]{4}$/;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function reply(res, status, data) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(status).json(data);
}

function tokenHash(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

async function supabaseRpc(name, params) {
  const response = await fetch(
    `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/rpc/${name}`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(params),
      cache: "no-store",
      signal: AbortSignal.timeout(10000)
    }
  );

  if (!response.ok) {
    throw new Error(`Supabase RPC HTTP ${response.status}`);
  }

  return response.json();
}

async function supabaseGet(table, params) {
  const url = new URL(
    `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/${table}`
  );

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`Supabase ${table} HTTP ${response.status}`);
  }

  return response.json();
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return reply(res, 405, {
      ok: false,
      message: "Method not allowed"
    });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return reply(res, 503, {
      ok: false,
      message: "Layanan detail pesanan belum siap."
    });
  }

  let body = req.body;

  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    body = {};
  }

  if (Buffer.byteLength(JSON.stringify(body)) > 2048) {
    return reply(res, 413, {
      ok: false,
      message: "Permintaan terlalu besar."
    });
  }

  const orderNumber =
    typeof body.order_number === "string"
      ? body.order_number.trim().toUpperCase()
      : "";

  const sessionToken =
    typeof body.session_token === "string"
      ? body.session_token.trim()
      : "";

  if (
    !ORDER_PATTERN.test(orderNumber) ||
    !TOKEN_PATTERN.test(sessionToken)
  ) {
    return reply(res, 401, {
      ok: false,
      message: "Sesi tidak valid. Silakan verifikasi OTP kembali."
    });
  }

  try {
    const validated = await supabaseRpc(
      "validate_real_payment_session",
      {
        p_order_number: orderNumber,
        p_token_hash: tokenHash(sessionToken)
      }
    );

    const session = Array.isArray(validated)
      ? validated[0]
      : validated;

    if (
      !session?.order_id ||
      session.order_number !== orderNumber
    ) {
      return reply(res, 401, {
        ok: false,
        message: "Sesi tidak valid atau telah berakhir."
      });
    }

    const orders = await supabaseGet("orders", {
      select:
        "id,order_number,buyer_name,buyer_email,buyer_phone," +
        "total_participants,total_amount,currency," +
        "payment_status,payment_method,created_at,paid_at," +
        "payment_expires_at,expiry_policy_version",
      id: `eq.${session.order_id}`,
      limit: "1"
    });

    const order = orders[0];

    if (!order || order.order_number !== orderNumber) {
      return reply(res, 404, {
        ok: false,
        message: "Pesanan tidak ditemukan."
      });
    }

    const isPaid = order.payment_status === "PAID";
    const isLegacy = order.expiry_policy_version === 0;

    if (
      !isPaid &&
      !isLegacy &&
      order.payment_expires_at &&
      new Date(order.payment_expires_at).getTime() <= Date.now()
    ) {
      return reply(res, 410, {
        ok: false,
        message: "Masa pembayaran pesanan telah berakhir."
      });
    }

    const participants = await supabaseGet("participants", {
      select:
        "id,registration_number,ticket_category," +
        "first_name,last_name,bib_name,birth_date,gender," +
        "jersey_size,phone,city,province,regency," +
        "racepack_status",
      order_id: `eq.${order.id}`,
      order: "created_at.asc",
      limit: "10"
    });

    return reply(res, 200, {
      ok: true,
      order: {
        order_number: order.order_number,
        buyer_name: order.buyer_name,
        buyer_email: order.buyer_email,
        buyer_phone: order.buyer_phone,
        total_participants: order.total_participants,
        total_amount: order.total_amount,
        currency: order.currency,
        payment_status: order.payment_status,
        payment_method: order.payment_method,
        created_at: order.created_at,
        paid_at: order.paid_at,
        payment_expires_at: order.payment_expires_at,
        payment_allowed:
          order.payment_status === "PENDING_PAYMENT"
      },
      participants: participants.map(p => ({
        id: p.id,
        registration_number: p.registration_number,
        ticket_category: p.ticket_category,
        full_name: [p.first_name, p.last_name]
          .filter(Boolean)
          .join(" "),
        bib_name: p.bib_name,
        birth_date: p.birth_date,
        gender: p.gender,
        jersey_size: p.jersey_size,
        phone: p.phone,
        city: p.city,
        province: p.province,
        regency: p.regency,
        racepack_status: p.racepack_status
      }))
    });

  } catch (error) {
    console.error("REAL order details failed:", error.message);

    return reply(res, 503, {
      ok: false,
      message: "Detail pesanan sementara tidak tersedia."
    });
  }
};
