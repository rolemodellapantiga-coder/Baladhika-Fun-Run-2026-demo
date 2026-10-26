
"use strict";

const crypto = require("node:crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OTP_SECRET = process.env.OTP_SECRET;
const DEMO_EMAIL = process.env.OTP_DEMO_ALLOWED_EMAIL;

const SESSION_SECONDS = 15 * 60;

function reply(res, status, payload) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(status).json(payload);
}

function normalizeEmail(value) {
  return typeof value === "string"
    ? value.trim().toLowerCase()
    : "";
}

function hmac(value) {
  return crypto
    .createHmac("sha256", OTP_SECRET)
    .update(value)
    .digest("hex");
}

function createSession(orderNumber, email) {
  const payload = Buffer.from(
    JSON.stringify({
      order_number: orderNumber,
      email,
      exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
      iss: "baladhika-funrun-2026"
    })
  ).toString("base64url");

  const signature = hmac(`session:${payload}`);

  return `${payload}.${signature}`;
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

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return reply(res, 405, {
      ok: false,
      message: "Method not allowed"
    });
  }

  if (
    !SUPABASE_URL ||
    !SUPABASE_KEY ||
    !OTP_SECRET ||
    !DEMO_EMAIL
  ) {
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

  const email = normalizeEmail(body.email);

  const otp =
    typeof body.otp === "string"
      ? body.otp.trim()
      : "";

  if (
    !/^(?:[A-Z0-9]{6}|BFR-ORDER-[A-F0-9]{20})$/.test(orderNumber) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !/^\d{6}$/.test(otp)
  ) {
    return reply(res, 400, {
      ok: false,
      message: "Data verifikasi tidak valid atau kode telah kedaluwarsa."
    });
  }

  // DEMO: hanya akun pengujian yang diizinkan.
  if (email !== normalizeEmail(DEMO_EMAIL)) {
    return reply(res, 400, {
      ok: false,
      message: "Verifikasi gagal atau kode telah kedaluwarsa."
    });
  }

  try {
    // Pembatasan tambahan: maksimal 10 verifikasi per IP
    // dalam jendela 15 menit.
    // Header IP harus berasal dari infrastruktur tepercaya.
    const ipHeader = req.headers["x-real-ip"];
    const forwarded = req.headers["x-forwarded-for"];

    const ip =
      typeof ipHeader === "string" && ipHeader.trim()
        ? ipHeader.trim()
        : typeof forwarded === "string" && forwarded.trim()
          ? forwarded.split(",")[0].trim()
          : "";

    if (!ip || ip.length > 128) {
      return reply(res, 503, {
        ok: false,
        message: "Permintaan tidak dapat diproses."
      });
    }

    const limited = await rpc(
      "consume_registration_otp_rate_limit",
      {
        p_key_hash: hmac(`verify-ip:${ip}`),
        p_window_seconds: 900,
        p_max_requests: 10
      }
    );

    if (limited !== true) {
      return reply(res, 429, {
        ok: false,
        message: "Terlalu banyak percobaan. Silakan coba lagi nanti."
      });
    }

    const otpHash = hmac(`registration-otp:${otp}`);

    const verified = await rpc(
      "verify_registration_otp",
      {
        p_order_number: orderNumber,
        p_email: email,
        p_otp_hash: otpHash
      }
    );

    if (verified !== true) {
      return reply(res, 400, {
        ok: false,
        message: "Verifikasi gagal atau kode telah kedaluwarsa."
      });
    }

    const sessionToken = createSession(orderNumber, email);

    return reply(res, 200, {
      ok: true,
      verified: true,
      session_token: sessionToken,
      expires_in: SESSION_SECONDS,
      message: "Verifikasi berhasil. Sesi berlaku selama 15 menit."
    });

  } catch (error) {
    console.error("OTP verification failed:", error.message);

    return reply(res, 503, {
      ok: false,
      message: "Layanan verifikasi sementara tidak tersedia."
    });
  }
};
