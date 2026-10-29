
"use strict";

const crypto = require("node:crypto");

const BASE = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const BUCKET = "real-payment-proofs";

const ORDER = /^BDJ-[A-HJ-NP-Z2-9]{4}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
};

function respond(res, status, message, extra = {}) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");

  return res.status(status).json({
    ok: status >= 200 && status < 300,
    message,
    ...extra
  });
}

function headers(extra = {}) {
  return {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    ...extra
  };
}

function validSignature(buffer, mime) {
  if (mime === "image/png") {
    return buffer.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    );
  }

  if (mime === "image/jpeg") {
    return (
      buffer.length > 4 &&
      buffer[0] === 255 &&
      buffer[1] === 216 &&
      buffer.at(-2) === 255 &&
      buffer.at(-1) === 217
    );
  }

  if (mime === "image/webp") {
    return (
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP"
    );
  }

  return false;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return respond(res, 405, "Gunakan metode POST.");
  }

  if (!BASE || !KEY) {
    return respond(res, 503, "Konfigurasi server belum lengkap.");
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

  const number = String(body.order_number || "")
    .trim()
    .toUpperCase();

  const email = String(body.buyer_email || "")
    .trim()
    .toLowerCase();

  const mime = body.mime_type;

  if (
    !ORDER.test(number) ||
    email.length > 254 ||
    !EMAIL.test(email)
  ) {
    return respond(
      res,
      401,
      "Nomor pesanan atau email tidak valid."
    );
  }

  if (
    !Object.hasOwn(MIME, mime) ||
    typeof body.file_base64 !== "string" ||
    body.file_base64.length > 1400000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(body.file_base64)
  ) {
    return respond(
      res,
      400,
      "Bukti pembayaran harus JPG, PNG, atau WebP maksimal 1 MB."
    );
  }

  const buffer = Buffer.from(body.file_base64, "base64");

  if (
    buffer.length < 16 ||
    buffer.length > 1048576 ||
    !validSignature(buffer, mime)
  ) {
    return respond(
      res,
      400,
      "Gambar tidak valid atau terlalu besar."
    );
  }

  let uploadedPath = null;

  try {
    const query = new URLSearchParams({
      select:
        "id,order_number,payment_status,payment_review_status," +
        "payment_proof_path,payment_expires_at,expiry_policy_version",
      order_number: `eq.${number}`,
      buyer_email: `eq.${email}`,
      limit: "1"
    });

    const response = await fetch(
      `${BASE}/rest/v1/orders?${query}`,
      {
        headers: headers(),
        cache: "no-store",
        signal: AbortSignal.timeout(12000)
      }
    );

    if (!response.ok) {
      throw new Error(`Database HTTP ${response.status}`);
    }

    const orders = await response.json();
    const order = orders?.[0];

    if (!order) {
      return respond(
        res,
        401,
        "Nomor pesanan atau email tidak cocok."
      );
    }

    if (order.payment_status !== "PENDING_PAYMENT") {
      return respond(
        res,
        409,
        "Pesanan tidak dapat menerima bukti pembayaran."
      );
    }

    if (
      order.payment_proof_path ||
      order.payment_review_status === "WAITING"
    ) {
      return respond(
        res,
        409,
        "Bukti sudah diunggah. Hubungi admin jika perlu mengganti."
      );
    }

    if (
      order.expiry_policy_version !== 0 &&
      order.payment_expires_at &&
      Date.parse(order.payment_expires_at) <= Date.now()
    ) {
      return respond(res, 410, "Batas pembayaran telah lewat.");
    }

    uploadedPath =
      `${order.id}/${crypto.randomUUID()}.${MIME[mime]}`;

    const uploaded = await fetch(
      `${BASE}/storage/v1/object/${BUCKET}/${uploadedPath}`,
      {
        method: "POST",
        headers: headers({
          "Content-Type": mime,
          "x-upsert": "false"
        }),
        body: buffer,
        signal: AbortSignal.timeout(12000)
      }
    );

    if (!uploaded.ok) {
      throw new Error(`Storage HTTP ${uploaded.status}`);
    }

    const filter = new URLSearchParams({
      id: `eq.${order.id}`,
      payment_status: "eq.PENDING_PAYMENT",
      payment_proof_path: "is.null",
      select: "id"
    });

    const updatedResponse = await fetch(
      `${BASE}/rest/v1/orders?${filter}`,
      {
        method: "PATCH",
        headers: headers({
          "Content-Type": "application/json",
          Prefer: "return=representation"
        }),
        body: JSON.stringify({
          payment_proof_path: uploadedPath,
          payment_proof_uploaded_at: new Date().toISOString(),
          payment_review_status: "WAITING"
        }),
        signal: AbortSignal.timeout(12000)
      }
    );

    if (!updatedResponse.ok) {
      throw new Error(`Update HTTP ${updatedResponse.status}`);
    }

    const updated = await updatedResponse.json();

    if (!Array.isArray(updated) || updated.length !== 1) {
      await fetch(
        `${BASE}/storage/v1/object/${BUCKET}/${uploadedPath}`,
        {
          method: "DELETE",
          headers: headers(),
          signal: AbortSignal.timeout(10000)
        }
      ).catch(() => {});

      return respond(
        res,
        409,
        "Bukti sudah diproses. Muat ulang pesanan."
      );
    }

    return respond(
      res,
      200,
      "Bukti pembayaran berhasil diterima dan menunggu verifikasi OWNER.",
      {
        order_number: number,
        review_status: "WAITING"
      }
    );

  } catch (error) {
    console.error("Upload real proof failed:", error.message);

    return respond(
      res,
      503,
      "Unggahan belum berhasil. Silakan coba lagi."
    );
  }
};
