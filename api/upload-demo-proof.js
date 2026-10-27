
"use strict";

// BALADHIKA FUN RUN 2026
// Upload bukti pembayaran DEMO
// Upload tidak otomatis membuat pesanan lunas.

const crypto = require("node:crypto");

const BASE = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.DEMO_PROOF_SECRET;

const BUCKET = "demo-payment-proofs";
const ORDER_RE = /^BDJ-[A-HJ-NP-Z2-9]{5}$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const MAX_BYTES = 1048576;

const TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
};

function reply(res, code, message, extra = {}) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");

  return res.status(code).json({
    success: code >= 200 && code < 300,
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

async function db(path, options = {}) {
  const response = await fetch(`${BASE}/rest/v1/${path}`, {
    ...options,
    headers: headers(options.headers || {}),
    cache: "no-store"
  });

  if (!response.ok) {
    console.error("Supabase REST:", response.status);
    throw new Error(`DATABASE_${response.status}`);
  }

  return response.status === 204
    ? null
    : response.json();
}

function validImage(buffer, mime) {
  if (mime === "image/png") {
    return (
      buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      )
    );
  }

  if (mime === "image/jpeg") {
    return (
      buffer.length >= 4 &&
      buffer[0] === 255 &&
      buffer[1] === 216 &&
      buffer[buffer.length - 2] === 255 &&
      buffer[buffer.length - 1] === 217
    );
  }

  if (mime === "image/webp") {
    return (
      buffer.length >= 12 &&
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP"
    );
  }

  return false;
}

function validSignature(payload, signature) {
  if (
    typeof signature !== "string" ||
    !/^[a-f0-9]{64}$/.test(signature)
  ) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", SECRET)
    .update(payload)
    .digest();

  return crypto.timingSafeEqual(
    expected,
    Buffer.from(signature, "hex")
  );
}

async function removeObject(path) {
  try {
    const response = await fetch(
      `${BASE}/storage/v1/object/${BUCKET}/${path}`,
      {
        method: "DELETE",
        headers: headers()
      }
    );

    if (!response.ok) {
      console.error("Storage cleanup:", response.status);
    }
  } catch (error) {
    console.error("Storage cleanup failed:", error.message);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return reply(res, 405, "Metode tidak diizinkan.");
  }

  if (!BASE || !KEY || !SECRET) {
    return reply(res, 503, "Konfigurasi server belum lengkap.");
  }

  let body;

  try {
    body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;
  } catch {
    return reply(res, 400, "Format JSON tidak valid.");
  }

  const orderNumber = String(
    body?.order_number || ""
  ).trim().toUpperCase();

  const token = String(
    body?.payment_token || ""
  ).trim();

  const mime = String(
    body?.mime_type || ""
  ).trim().toLowerCase();

  const encoded = body?.file_base64;
  const payload = body?.proof_payload;
  const signature = body?.proof_signature;

  if (!ORDER_RE.test(orderNumber) || !TOKEN_RE.test(token)) {
    return reply(
      res,
      400,
      "Nomor pesanan atau token tidak valid."
    );
  }

  if (
    typeof payload !== "string" ||
    payload.length > 300 ||
    !validSignature(payload, signature)
  ) {
    return reply(
      res,
      400,
      "Kode verifikasi bukti tidak valid."
    );
  }

  if (!Object.hasOwn(TYPES, mime)) {
    return reply(
      res,
      400,
      "Format gambar tidak didukung."
    );
  }

  if (
    typeof encoded !== "string" ||
    encoded.length > Math.ceil(MAX_BYTES / 3) * 4 + 8 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    return reply(
      res,
      400,
      "Data gambar tidak valid atau terlalu besar."
    );
  }

  const file = Buffer.from(encoded, "base64");

  if (
    !file.length ||
    file.length > MAX_BYTES ||
    !validImage(file, mime)
  ) {
    return reply(
      res,
      400,
      "Bukti gambar tidak valid."
    );
  }

  const tokenHash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  try {
    const filters = new URLSearchParams({
      select:
        "id,order_number,payment_status," +
        "demo_proof_review_status," +
        "demo_payment_proof_path",
      order_number: `eq.${orderNumber}`,
      demo_payment_token_hash: `eq.${tokenHash}`,
      limit: "1"
    });

    const rows = await db(`orders?${filters}`);

    if (!Array.isArray(rows) || rows.length !== 1) {
      return reply(
        res,
        404,
        "Pesanan atau token tidak cocok."
      );
    }

    const order = rows[0];
    const parts = payload.split("|");

    if (
      parts.length !== 4 ||
      parts[0] !== "BALADHIKA-DEMO-V1" ||
      parts[1] !== orderNumber ||
      parts[2] !== String(order.id) ||
      !/^[a-f0-9]{32}$/.test(parts[3])
    ) {
      return reply(
        res,
        400,
        "Kode bukti bukan milik pesanan ini."
      );
    }

    if (order.payment_status === "PAID_DEMO") {
      return reply(
        res,
        200,
        "Pesanan sudah disetujui panitia.",
        {
          demo: true,
          order_number: orderNumber,
          payment_status: "PAID_DEMO",
          review_status: "APPROVED"
        }
      );
    }

    if (order.payment_status !== "PENDING_DEMO") {
      return reply(
        res,
        409,
        "Status pesanan tidak dapat diproses."
      );
    }

    if (order.demo_proof_review_status === "WAITING") {
      return reply(
        res,
        409,
        "Bukti sebelumnya masih menunggu pemeriksaan panitia.",
        {
          review_status: "WAITING"
        }
      );
    }

    if (
      !["NOT_UPLOADED", "REJECTED"].includes(
        order.demo_proof_review_status
      )
    ) {
      return reply(
        res,
        409,
        "Status pemeriksaan bukti tidak dapat diproses."
      );
    }

    const objectPath =
      `${order.id}/${crypto.randomUUID()}.${TYPES[mime]}`;

    const uploaded = await fetch(
      `${BASE}/storage/v1/object/${BUCKET}/${objectPath}`,
      {
        method: "POST",
        headers: headers({
          "Content-Type": mime,
          "x-upsert": "false"
        }),
        body: file
      }
    );

    if (!uploaded.ok) {
      return reply(
        res,
        502,
        "Gagal menyimpan bukti simulasi."
      );
    }

    const updateFilters = new URLSearchParams({
      id: `eq.${order.id}`,
      demo_payment_token_hash: `eq.${tokenHash}`,
      payment_status: "eq.PENDING_DEMO",
      demo_proof_review_status:
        `eq.${order.demo_proof_review_status}`,
      select: "id,payment_status,demo_proof_review_status"
    });

    let updated;

    try {
      updated = await db(`orders?${updateFilters}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          demo_payment_proof_path: objectPath,
          demo_payment_proof_uploaded_at:
            new Date().toISOString(),
          demo_proof_review_status: "WAITING",
          demo_proof_reviewed_at: null,
          demo_proof_rejection_reason: null
        })
      });
    } catch (error) {
      await removeObject(objectPath);
      throw error;
    }

    if (!Array.isArray(updated) || updated.length !== 1) {
      await removeObject(objectPath);

      return reply(
        res,
        409,
        "Status pesanan berubah. Periksa kembali."
      );
    }

    return reply(
      res,
      200,
      "Bukti DEMO diterima dan MENUNGGU VERIFIKASI panitia.",
      {
        demo: true,
        order_number: orderNumber,
        payment_status: "PENDING_DEMO",
        review_status: "WAITING",
        notice:
          "DEMO / TEST — BUKAN BUKTI PEMBAYARAN SAH"
      }
    );

  } catch (error) {
    console.error(
      "upload-demo-proof:",
      error?.message || "UNKNOWN"
    );

    return reply(
      res,
      500,
      "Proses bukti simulasi gagal."
    );
  }
};
