
const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL;
const OTP_SECRET = process.env.OTP_SECRET;
const DEMO_EMAIL = process.env.OTP_DEMO_ALLOWED_EMAIL;

const genericResponse = {
  ok: true,
  message:
    "Jika data pesanan sesuai dan email diizinkan, kode OTP akan dikirim."
};

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function makeOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function hashOtp(otp) {
  return crypto
    .createHmac("sha256", OTP_SECRET)
    .update("registration-otp:" + otp)
    .digest("hex");
}

async function supabaseRpc(name, params) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/${name}`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(params)
    }
  );

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(data?.message || "Database request failed");
    error.code = data?.message || "";
    throw error;
  }

  return data;
}

async function finalizeOtp(id, hash, sent) {
  return supabaseRpc("finalize_registration_otp", {
    p_otp_id: id,
    p_otp_hash: hash,
    p_sent: sent
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
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
    console.error("OTP environment configuration incomplete");
    return res.status(503).json({
      ok: false,
      message: "Layanan OTP belum siap."
    });
  }

  if (Buffer.byteLength(JSON.stringify(req.body || {})) > 2048) {
    return res.status(413).json({
      ok: false,
      message: "Permintaan terlalu besar."
    });
  }

  const orderNumber = String(
    req.body?.order_number || ""
  ).trim().toUpperCase();

  const email = normalizeEmail(req.body?.email);

  if (
    !/^[A-Z0-9-]{6,40}$/.test(orderNumber) ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return res.status(200).json(genericResponse);
  }

  // DEMO: hanya email yang diizinkan oleh Resend.
  if (email !== normalizeEmail(DEMO_EMAIL)) {
    return res.status(200).json(genericResponse);
  }

  const otp = makeOtp();
  const otpHash = hashOtp(otp);

  let issued;

  try {
    issued = await supabaseRpc("issue_registration_otp", {
      p_order_number: orderNumber,
      p_email: email,
      p_otp_hash: otpHash
    });
  } catch (error) {
    if (
      error.code.includes("OTP_REQUEST_NOT_AVAILABLE") ||
      error.code.includes("OTP_COOLDOWN_ACTIVE")
    ) {
      return res.status(200).json(genericResponse);
    }

    console.error("OTP issuance failed:", error.message);

    return res.status(503).json({
      ok: false,
      message: "Layanan OTP sementara tidak tersedia."
    });
  }

  const issuedRecord = Array.isArray(issued)
    ? issued[0]
    : issued;

  if (!issuedRecord?.otp_id) {
    console.error("OTP issuance returned no record");

    return res.status(503).json({
      ok: false,
      message: "Gagal menyiapkan OTP."
    });
  }

  let sent = false;

  try {
    const response = await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: [email],
          subject: "Kode OTP - Baladhika Fun Run 2026",
          text:
            `Kode verifikasi pesanan Anda: ${otp}\n\n` +
            "Kode berlaku selama 60 detik.\n" +
            "Jangan berikan kode ini kepada siapa pun.\n\n" +
            "BALADHIKA FUN RUN 2026 - DEMO"
        })
      }
    );

    const result = await response.json().catch(() => null);

    sent = response.ok && Boolean(result?.id);

    if (!sent) {
      console.error(
        "Resend rejected OTP:",
        response.status,
        result?.name || "Unknown error"
      );
    }
  } catch (error) {
    console.error("Resend request failed:", error.message);
  }

  try {
    const finalized = await finalizeOtp(
      issuedRecord.otp_id,
      otpHash,
      sent
    );

    if (!finalized) {
      console.error("OTP finalization was not applied");
      return res.status(503).json({
        ok: false,
        message: "Status pengiriman OTP belum dapat dipastikan."
      });
    }
  } catch (error) {
    console.error("OTP finalization failed:", error.message);

    return res.status(503).json({
      ok: false,
      message: "Status pengiriman OTP belum dapat dipastikan."
    });
  }

  return res.status(200).json(genericResponse);
};
