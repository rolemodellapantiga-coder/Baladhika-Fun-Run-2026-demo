
"use strict";

const crypto = require("node:crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL;
const OTP_SECRET = process.env.OTP_SECRET;
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;

// Aktifkan hanya setelah payment-real.html mengirim token Turnstile.
const TURNSTILE_ENFORCE = process.env.TURNSTILE_ENFORCE === "true";

const GENERIC_RESPONSE = {
  ok: true,
  message:
    "Jika nomor pesanan dan email sesuai, kode OTP akan dikirim. Periksa kotak masuk dan folder spam."
};

function reply(res, status, payload) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(status).json(payload);
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function makeOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function hmac(value) {
  return crypto.createHmac("sha256", OTP_SECRET).update(value).digest("hex");
}

function getClientIp(req) {
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) return realIp.trim();

  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return null;
}

async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET_KEY || !token || token.length > 2048) return false;

  const params = new URLSearchParams({
    secret: TURNSTILE_SECRET_KEY,
    response: token
  });

  if (ip) params.set("remoteip", ip);

  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: AbortSignal.timeout(10000),
      cache: "no-store"
    }
  );

  if (!response.ok) throw new Error(`Turnstile HTTP ${response.status}`);

  const result = await response.json();
  if (result?.success !== true) return false;

  const hostname = String(result.hostname || "").toLowerCase();

  return hostname === "baladhikafunrun.com" ||
    hostname === "www.baladhikafunrun.com";
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

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(data?.message || `Supabase HTTP ${response.status}`);
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
    !OTP_SECRET
  ) {
    console.error("REAL payment OTP configuration incomplete");
    return reply(res, 503, {
      ok: false,
      message: "Layanan OTP belum siap."
    });
  }

  if (TURNSTILE_ENFORCE && !TURNSTILE_SECRET_KEY) {
    console.error("Turnstile enforcement enabled without secret key");
    return reply(res, 503, {
      ok: false,
      message: "Layanan keamanan belum siap."
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

  if (Buffer.byteLength(JSON.stringify(body)) > 4096) {
    return reply(res, 413, {
      ok: false,
      message: "Permintaan terlalu besar."
    });
  }

  const clientIp = getClientIp(req);

  if (!clientIp || clientIp.length > 128) {
    return reply(res, 503, {
      ok: false,
      message: "Permintaan tidak dapat diproses."
    });
  }

  // Mode transisi: permintaan lama masih diterima.
  // Saat TURNSTILE_ENFORCE=true, token Turnstile wajib valid.
  if (TURNSTILE_ENFORCE) {
    const token = typeof body.turnstile_token === "string"
      ? body.turnstile_token.trim()
      : "";

    try {
      const valid = await verifyTurnstile(token, clientIp);

      if (!valid) {
        return reply(res, 403, {
          ok: false,
          message: "Pemeriksaan keamanan gagal. Muat ulang halaman dan coba lagi."
        });
      }
    } catch (error) {
      console.error("Turnstile verification unavailable:", error.message);
      return reply(res, 503, {
        ok: false,
        message: "Pemeriksaan keamanan sementara tidak tersedia."
      });
    }
  }

  try {
    const allowed = await consumeLimit(
      `real-payment:ip:${clientIp}`,
      15 * 60,
      5
    );

    if (!allowed) {
      return reply(res, 200, GENERIC_RESPONSE);
    }
  } catch (error) {
    console.error("REAL payment OTP IP rate limit failed:", error.message);

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

  if (
    !/^BDJ-[A-HJ-NP-Z2-9]{4}$/.test(orderNumber) ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return reply(res, 200, GENERIC_RESPONSE);
  }

  try {
    const emailAllowed = await consumeLimit(
      `real-payment:email:${email}`,
      60 * 60,
      3
    );

    if (!emailAllowed) {
      return reply(res, 200, GENERIC_RESPONSE);
    }

    const orderAllowed = await consumeLimit(
      `real-payment:order:${orderNumber}`,
      60 * 60,
      3
    );

    if (!orderAllowed) {
      return reply(res, 200, GENERIC_RESPONSE);
    }
  } catch (error) {
    console.error("REAL payment OTP rate limit failed:", error.message);

    return reply(res, 503, {
      ok: false,
      message: "Layanan OTP sementara tidak tersedia."
    });
  }

  const otp = makeOtp();
  const otpHash = hmac(`registration-otp:${otp}`);

  let issued;

  try {
    issued = await supabaseRpc("issue_real_payment_otp", {
      p_order_number: orderNumber,
      p_email: email,
      p_otp_hash: otpHash
    });
  } catch (error) {
    if (
      [
        "OTP_REQUEST_NOT_AVAILABLE",
        "OTP_COOLDOWN_ACTIVE",
        "INVALID_OTP_REQUEST"
      ].some(code => String(error.code).includes(code))
    ) {
      return reply(res, 200, GENERIC_RESPONSE);
    }

    console.error("REAL payment OTP issuance failed:", error.message);

    return reply(res, 503, {
      ok: false,
      message: "Layanan OTP sementara tidak tersedia."
    });
  }

  const record = Array.isArray(issued) ? issued[0] : issued;

  if (!record?.otp_id) {
    console.error("REAL payment OTP issuance returned no ID");

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
        to: [record.recipient_email],
        subject: "Kode OTP Pembayaran — Baladhika Fun Run 2026",
        text:
          `Kode verifikasi pembayaran Anda: ${otp}\n\n` +
          `Nomor pesanan: ${orderNumber}\n` +
          "Kode berlaku selama 5 menit sejak diterbitkan.\n" +
          "Jangan berikan kode ini kepada siapa pun.\n\n" +
          "BALADHIKA FUN RUN 2026"
      }),
      signal: AbortSignal.timeout(10000)
    });

    const result = await response.json().catch(() => null);

    sent = response.ok && Boolean(result?.id);

    if (!sent) {
      console.error(
        "Resend rejected REAL OTP:",
        response.status,
        result?.name || "Unknown error"
      );
    }
  } catch (error) {
    console.error("Resend REAL OTP request failed:", error.message);
  }

  try {
    const finalized = await supabaseRpc(
      "finalize_registration_otp",
      {
        p_otp_id: record.otp_id,
        p_otp_hash: otpHash,
        p_sent: sent
      }
    );

    if (finalized !== true) {
      console.error("REAL OTP finalization was not confirmed");

      return reply(res, 503, {
        ok: false,
        message: "Status pengiriman OTP belum dapat dipastikan."
      });
    }
  } catch (error) {
    console.error("REAL OTP finalization failed:", error.message);

    return reply(res, 503, {
      ok: false,
      message: "Status pengiriman OTP belum dapat dipastikan."
    });
  }

  return reply(res, 200, GENERIC_RESPONSE);
};
