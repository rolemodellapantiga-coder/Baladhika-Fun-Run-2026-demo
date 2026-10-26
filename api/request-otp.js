
"use strict";

const crypto = require("node:crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL;
const OTP_SECRET = process.env.OTP_SECRET;
const DEMO_EMAIL = process.env.OTP_DEMO_ALLOWED_EMAIL;

const GENERIC_RESPONSE = {
  ok: true,
  message:
    "Jika data pesanan sesuai dan memenuhi ketentuan pengujian, kode OTP akan dikirim."
};

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

function makeOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function hmac(value) {
  return crypto
    .createHmac("sha256", OTP_SECRET)
    .update(value)
    .digest("hex");
}

function getClientIp(req) {
  const realIp = req.headers["x-real-ip"];

  if (
    typeof realIp === "string" &&
    realIp.trim()
  ) {
    return realIp.trim();
  }

  const forwarded = req.headers["x-forwarded-for"];

  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return null;
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
      cache: "no-store"
    }
  );

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(
      data?.message || `Supabase HTTP ${response.status}`
    );

    error.code = data?.message || "";
    throw error;
  }

  return data;
}

async function consumeLimit(key, windowSeconds, maxRequests) {
  const result = await supabaseRpc(
    "consume_registration_otp_rate_limit",
    {
      p_key_hash: hmac(`otp-rate-limit:${key}`),
      p_window_seconds: windowSeconds,
      p_max_requests: maxRequests
    }
  );

  return result === true;
}

async function finalizeOtp(id, otpHash, sent) {
  return supabaseRpc("finalize_registration_otp", {
    p_otp_id: id,
    p_otp_hash: otpHash,
    p_sent: sent
  });
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
    !RESEND_KEY ||
    !FROM_EMAIL ||
    !OTP_SECRET ||
    !DEMO_EMAIL
  ) {
    console.error("OTP configuration incomplete");

    return reply(res, 503, {
      ok: false,
      message: "Layanan OTP belum siap."
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

  const clientIp = getClientIp(req);

  // Fail closed: jangan mengirim OTP jika IP tidak dapat ditentukan.
  if (!clientIp || clientIp.length > 128) {
    return reply(res, 503, {
      ok: false,
      message: "Permintaan tidak dapat diproses."
    });
  }

  // Maksimal 5 permintaan per IP dalam 15 menit.
  try {
    const allowed = await consumeLimit(
      `ip:${clientIp}`,
      15 * 60,
      5
    );

    if (!allowed) {
      return reply(res, 200, GENERIC_RESPONSE);
    }
  } catch (error) {
    console.error("IP rate limit failed:", error.message);

    return reply(res, 503, {
      ok: false,
      message: "Layanan OTP sementara tidak tersedia."
    });
  }

  const orderNumber =
    typeof body.order_number === "string"
      ? body.order_number.trim().toUpperCase()
      : "";

  const email = normalizeEmail(body.email);
  const allowedDemoEmail = normalizeEmail(DEMO_EMAIL);

  if (
    !/^(?:[A-Z0-9]{6}|BFR-ORDER-[A-F0-9]{20})$/.test(orderNumber) ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return reply(res, 200, GENERIC_RESPONSE);
  }

  // Tahap DEMO: hanya email yang diizinkan Resend.
  if (email !== allowedDemoEmail) {
    return reply(res, 200, GENERIC_RESPONSE);
  }

  // Maksimal 3 permintaan per email dalam 1 jam.
  try {
    const allowed = await consumeLimit(
      `email:${email}`,
      60 * 60,
      3
    );

    if (!allowed) {
      return reply(res, 200, GENERIC_RESPONSE);
    }
  } catch (error) {
    console.error("Email rate limit failed:", error.message);

    return reply(res, 503, {
      ok: false,
      message: "Layanan OTP sementara tidak tersedia."
    });
  }

  const otp = makeOtp();
  const otpHash = hmac(`registration-otp:${otp}`);

  let issued;

  try {
    issued = await supabaseRpc("issue_registration_otp", {
      p_order_number: orderNumber,
      p_email: email,
      p_otp_hash: otpHash
    });
  } catch (error) {
    // Tidak mengungkap apakah nomor atau email terdaftar.
    if (
      error.code.includes("OTP_REQUEST_NOT_AVAILABLE") ||
      error.code.includes("OTP_COOLDOWN_ACTIVE") ||
      error.code.includes("INVALID_OTP_REQUEST")
    ) {
      return reply(res, 200, GENERIC_RESPONSE);
    }

    console.error("OTP issuance failed:", error.message);

    return reply(res, 503, {
      ok: false,
      message: "Layanan OTP sementara tidak tersedia."
    });
  }

  const record = Array.isArray(issued) ? issued[0] : issued;

  if (!record?.otp_id) {
    console.error("OTP issuance returned no ID");

    return reply(res, 503, {
      ok: false,
      message: "Gagal menyiapkan OTP."
    });
  }

  let sent = false;

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [email],
        subject: "Kode Verifikasi OTP — Baladhika Fun Run 2026",
        text:
          `Kode verifikasi Anda: ${otp}\n\n` +
          "Kode berlaku selama 60 detik sejak diterbitkan.\n" +
          "Jangan berikan kode ini kepada siapa pun.\n\n" +
          "BALADHIKA FUN RUN 2026 — DEMO / TEST"
      }),
      signal: AbortSignal.timeout(10000)
    });

    const result = await response.json().catch(() => null);

    sent = response.ok && Boolean(result?.id);

    if (!sent) {
      console.error(
        "Resend rejected request:",
        response.status,
        result?.name || "Unknown error"
      );
    }
  } catch (error) {
    console.error("Resend request failed:", error.message);
  }

  try {
    const finalized = await finalizeOtp(
      record.otp_id,
      otpHash,
      sent
    );

    if (finalized !== true) {
      console.error("OTP finalization was not confirmed");

      return reply(res, 503, {
        ok: false,
        message: "Status pengiriman OTP belum dapat dipastikan."
      });
    }
  } catch (error) {
    console.error("OTP finalization failed:", error.message);

    return reply(res, 503, {
      ok: false,
      message: "Status pengiriman OTP belum dapat dipastikan."
    });
  }

  return reply(res, 200, GENERIC_RESPONSE);
};
