
"use strict";

// BALADHIKA FUN RUN 2026 — DEMO / TEST
// Upload bukti tidak otomatis melunasi pesanan.
// Status PAID_DEMO hanya boleh diberikan oleh admin.

const crypto = require("node:crypto");

const URL_BASE = process.env.SUPABASE_URL?.replace(/\/+$/, "");
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

function reply(res, status, message, extra = {}) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");

  return res.status(status).json({
    success: status >= 200 && status < 300,
    message,
    ...extra
  });
}

async function database(path, options = {}) {
  const response = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      ...(options.headers || {})
    },
    cache: "no-store"
  });

  if (!response.ok) {
    const details = await response.text();
    console.error(
      "Supabase error:",
      response.status,
      details.slice(0, 300)
    );
    throw new Error(`DATABASE_${response.status}`);
  }

  if (response.status === 204) return null;

  return response.json();
}

function validImage(bytes, mime) {
  if (mime === "image/png") {
    return bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      );
  }

  if (mime === "image/jpeg") {
    return bytes.length >= 4 &&
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      bytes[bytes.length - 2] === 255 &&
      bytes[bytes.length - 1] === 217;
  }

  if (mime === "image/webp") {
    return bytes.length >= 12 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP";
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
      `${URL_BASE}/storage/v1/object/${BUCKET}/${path}`,
      {
        method: "DELETE",
        headers: {
          apikey: KEY,
          Authorization: `Bearer ${KEY}`
        }
      }
    );

    if (!response.ok) {
      console.error(
        "Cleanup storage failed:",
        response.status
      );
    }
  } catch (error) {
    console.error(
      "Cleanup storage failed:",
      error.message
    );
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return reply(res, 405, "Metode tidak diizinkan.");
  }

  if (!URL_BASE || !KEY || !SECRET) {
    return reply(
      res,
      503,
      "Konfigurasi server belum lengkap."
    );
  }

  let body;

  try {
    body = typeof req.body === "string"
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

  if (
    !ORDER_RE.test(orderNumber) ||
    !TOKEN_RE.test(token)
  ) {
    return reply(
      res,
      400,
      "Nomor pesanan atau token tidak valid."
    );
  }

  if (
    typeof payload !== "string" ||
    typeof signature !== "string" ||
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
    file.length === 0 ||
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
        "id,order_number,payment_status,demo_payment_proof_path",
      order_number: `eq.${orderNumber}`,
      demo_payment_token_hash: `eq.${tokenHash}`,
      limit: "1"
    });

    const orders = await database(`orders?${filters}`);

    if (
      !Array.isArray(orders) ||
      orders.length !== 1
    ) {
      return reply(
        res,
        404,
        "Pesanan atau token tidak cocok."
      );
    }

    const order = orders[0];
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

    // Pesanan sudah disetujui oleh admin.
    if (order.payment_status === "PAID_DEMO") {
      return reply(
        res,
        200,
        "Pesanan sudah lunas dalam mode DEMO.",
        {
          demo: true,
          order_number: orderNumber,
          payment_status: "PAID_DEMO"
        }
      );
    }

    // Bukti sudah masuk antrean verifikasi.
    if (order.payment_status === "WAITING") {
      return reply(
        res,
        200,
        "Bukti sudah diterima dan menunggu verifikasi admin.",
        {
          demo: true,
          order_number: orderNumber,
          payment_status: "WAITING"
        }
      );
    }

    // Status lain tidak boleh langsung diproses.
    if (order.payment_status !== "PENDING_DEMO") {
      return reply(
        res,
        409,
        "Status pesanan tidak dapat diproses."
      );
    }

    const objectPath =
      `${order.id}/${crypto.randomUUID()}.${TYPES[mime]}`;

    // Simpan bukti ke Supabase Storage.
    const upload = await fetch(
      `${URL_BASE}/storage/v1/object/${BUCKET}/${objectPath}`,
      {
        method: "POST",
        headers: {
          apikey: KEY,
          Authorization: `Bearer ${KEY}`,
          "Content-Type": mime,
          "x-upsert": "false"
        },
        body: file
      }
    );

    if (!upload.ok) {
      console.error(
        "Storage upload failed:",
        upload.status
      );

      return reply(
        res,
        502,
        "Gagal menyimpan bukti simulasi."
      );
    }

    const now = new Date().toISOString();

    // Perubahan penting:
    // Status WAITING, bukan PAID_DEMO.
    // paid_at dan verified_at tidak diisi.
    const updateFilters = new URLSearchParams({
      id: `eq.${order.id}`,
      demo_payment_token_hash: `eq.${tokenHash}`,
      payment_status: "eq.PENDING_DEMO",
      demo_payment_proof_path: "is.null",
      select: "id,payment_status"
    });

    let updated;

    try {
      updated = await database(
        `orders?${updateFilters}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Prefer: "return=representation"
          },
          body: JSON.stringify({
            demo_payment_proof_path: objectPath,
            demo_payment_proof_uploaded_at: now,
            payment_status: "WAITING"
          })
        }
      );
    } catch (error) {
      await removeObject(objectPath);
      throw error;
    }

    if (
      !Array.isArray(updated) ||
      updated.length !== 1
    ) {
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
      "Bukti berhasil diunggah. Menunggu verifikasi panitia.",
      {
        demo: true,
        order_number: orderNumber,
        payment_status: "WAITING",
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
