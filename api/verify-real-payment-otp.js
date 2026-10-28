
"use strict";

const crypto = require("node:crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OTP_SECRET = process.env.OTP_SECRET;

const SESSION_SECONDS = 30 * 60;

function reply(res, status, payload) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(status).json(payload);
}

function hmac(value) {
  return crypto
    .createHmac("sha256", OTP_SECRET)
    .update(value)
    .digest("hex");
}

async function rpc(name, params) {
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
      signal: AbortSignal.timeout(10000),
      cache: "no-store"
    }
  );

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      data?.message || `Supabase HTTP ${response.status}`
    );
  }

  return data;
}

function clientIp(req) {
  const realIp = req.headers["x-real-ip"];

  if (typeof realIp === "string" && realIp.trim()) {
    return realIp.trim();
  }

  const forwarded = req.headers["x-forwarded-for"];

  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return "";
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return reply(res, 405, {
      ok: false,
      message: "Method not allowed"
    });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY || !OTP_SECRET) {
    return reply(res, 503, {
      ok: false,
      message: "Layanan verifikasi belum siap."
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

  const email =
    typeof body.email === "string"
      ? body.email.trim().toLowerCase()
      : "";

  const otp =
    typeof body.otp === "string"
      ? body.otp.trim()
      : "";

  if (
    !/^BDJ-[A-HJ-NP-Z2-9]{4}$/.test(orderNumber) ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !/^\d{6}$/.test(otp)
  ) {
    return reply(res, 400, {
      ok: false,
      message: "Verifikasi gagal atau kode tidak valid."
    });
  }

  const ip = clientIp(req);

  if (!ip || ip.length > 128) {
    return reply(res, 503, {
      ok: false,
      message: "Permintaan tidak dapat diproses."
    });
  }

  try {
    const allowed = await rpc(
      "consume_registration_otp_rate_limit",
      {
        p_key_hash: hmac(`real-payment:verify-ip:${ip}`),
        p_window_seconds: 900,
        p_max_requests: 10
      }
    );

    if (allowed !== true) {
      return reply(res, 429, {
        ok: false,
        message: "Terlalu banyak percobaan. Coba lagi nanti."
      });
    }

    const otpHash = hmac(`registration-otp:${otp}`);

    const sessionToken = crypto
      .randomBytes(32)
      .toString("hex");

    const sessionHash = crypto
      .createHash("sha256")
      .update(sessionToken)
      .digest("hex");

    const result = await rpc(
      "create_real_payment_session",
      {
        p_order_number: orderNumber,
        p_email: email,
        p_otp_hash: otpHash,
        p_session_token_hash: sessionHash
      }
    );

    const session = Array.isArray(result)
      ? result[0]
      : result;

    if (
      session?.success !== true ||
      !session.expires_at
    ) {
      return reply(res, 400, {
        ok: false,
        message: "Verifikasi gagal atau OTP telah kedaluwarsa."
      });
    }

    return reply(res, 200, {
      ok: true,
      verified: true,
      order_number: orderNumber,
      session_token: sessionToken,
      expires_at: session.expires_at,
      expires_in: SESSION_SECONDS,
      message:
        "Verifikasi berhasil. Sesi pembayaran berlaku selama 30 menit."
    });

  } catch (error) {
    if (
      String(error.message).includes("OTP_INVALID_OR_EXPIRED") ||
      String(error.message).includes("ORDER_NOT_AVAILABLE") ||
      String(error.message).includes("INVALID_SESSION_REQUEST")
    ) {
      return reply(res, 400, {
        ok: false,
        message: "Verifikasi gagal atau OTP telah kedaluwarsa."
      });
    }

    console.error(
      "REAL payment verification failed:",
      error.message
    );

    return reply(res, 503, {
      ok: false,
      message: "Layanan verifikasi sementara tidak tersedia."
    });
  }
};
