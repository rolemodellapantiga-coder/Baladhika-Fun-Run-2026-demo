
"use strict";

const BASE = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const ORDER_PATTERN = /^BDJ-[A-HJ-NP-Z2-9]{4}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function reply(res, status, data) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(status).json(data);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return reply(res, 405, {
      ok: false,
      message: "Gunakan metode POST."
    });
  }

  if (!BASE || !KEY) {
    return reply(res, 503, {
      ok: false,
      message: "Layanan pesanan belum siap."
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

  const number = String(body.order_number || "")
    .trim()
    .toUpperCase();

  const email = String(body.buyer_email || "")
    .trim()
    .toLowerCase();

  if (
    !ORDER_PATTERN.test(number) ||
    email.length > 254 ||
    !EMAIL_PATTERN.test(email)
  ) {
    return reply(res, 400, {
      ok: false,
      message: "Nomor pesanan atau email tidak valid."
    });
  }

  try {
    const query = new URLSearchParams({
      select:
        "order_number,buyer_email,total_participants," +
        "total_amount,currency,payment_status,payment_method," +
        "payment_review_status,payment_proof_uploaded_at," +
        "payment_expires_at,expiry_policy_version",
      order_number: `eq.${number}`,
      buyer_email: `eq.${email}`,
      limit: "1"
    });

    const response = await fetch(
      `${BASE}/rest/v1/orders?${query}`,
      {
        headers: {
          apikey: KEY,
          Authorization: `Bearer ${KEY}`
        },
        cache: "no-store",
        signal: AbortSignal.timeout(10000)
      }
    );

    if (!response.ok) {
      throw new Error(`Database HTTP ${response.status}`);
    }

    const rows = await response.json();
    const order = rows?.[0];

    if (!order) {
      return reply(res, 404, {
        ok: false,
        message: "Nomor pesanan atau email tidak cocok."
      });
    }

    const expired =
      order.expiry_policy_version !== 0 &&
      order.payment_expires_at &&
      Date.parse(order.payment_expires_at) <= Date.now();

    const proofUploaded =
      Boolean(order.payment_proof_uploaded_at);

    const paymentAllowed =
      order.payment_status === "PENDING_PAYMENT" &&
      !expired &&
      !proofUploaded &&
      order.payment_review_status !== "WAITING";

    return reply(res, 200, {
      ok: true,
      order: {
        order_number: order.order_number,
        total_participants: order.total_participants,
        total_amount: order.total_amount,
        currency: order.currency,
        payment_status: order.payment_status,
        payment_method: order.payment_method,
        payment_review_status: order.payment_review_status,
        payment_proof_uploaded: proofUploaded,
        payment_allowed: paymentAllowed
      }
    });

  } catch (error) {
    console.error("Order details failed:", error.message);

    return reply(res, 503, {
      ok: false,
      message: "Detail pesanan sementara tidak tersedia."
    });
  }
};
