
"use strict";

// BALADHIKA FUN RUN 2026 — DEMO ONLY.
// Tidak memproses pembayaran uang sungguhan.

const crypto = require("node:crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BUCKET = "demo-payment-proofs";
const ORDER_RE = /^BDJ-[A-HJ-NP-Z2-9]{5}$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const MAX_BYTES = 1048576;

const MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
};

function respond(res, code, message, extra = {}) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");

  return res.status(code).json({
    success: code >= 200 && code < 300,
    message,
    ...extra
  });
}

async function supa(path, options = {}) {
  const response = await fetch(
    `${SUPABASE_URL.replace(/\/+$/, "")}${path}`,
    {
      ...options,
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        ...(options.headers || {})
      },
      cache: "no-store"
    }
  );

  if (!response.ok) {
    console.error(
      "Supabase operation failed",
      response.status
    );
    throw new Error("SUPABASE_ERROR");
  }

  if (response.status === 204) return null;

  return response.json();
}

function signatureOk(bytes, mime) {
  if (mime === "image/png") {
    return (
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      )
    );
  }

  if (mime === "image/jpeg") {
    return (
      bytes.length >= 4 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[bytes.length - 2] === 0xff &&
      bytes[bytes.length - 1] === 0xd9
    );
  }

  if (mime === "image/webp") {
    return (
      bytes.length >= 12 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP"
    );
  }

  return false;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return respond(res, 405, "Gunakan metode POST.");
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return respond(
      res,
      503,
      "Konfigurasi server belum lengkap."
    );
  }

  let body;

  try {
    body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;
  } catch {
    return respond(res, 400, "JSON tidak valid.");
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

  if (
    !ORDER_RE.test(orderNumber) ||
    !TOKEN_RE.test(token)
  ) {
    return respond(
      res,
      400,
      "Nomor pesanan atau token tidak valid."
    );
  }

  if (!Object.hasOwn(MIME, mime)) {
    return respond(
      res,
      400,
      "Gunakan JPG, PNG, atau WEBP."
    );
  }

  if (
    typeof encoded !== "string" ||
    encoded.length > Math.ceil(MAX_BYTES / 3) * 4 + 8 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    return respond(
      res,
      400,
      "Bukti pembayaran tidak valid atau melebihi 1 MB."
    );
  }

  const file = Buffer.from(encoded, "base64");

  if (
    file.length === 0 ||
    file.length > MAX_BYTES ||
    !signatureOk(file, mime)
  ) {
    return respond(
      res,
      400,
      "File tidak valid atau melebihi 1 MB."
    );
  }

  const hash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  const q = new URLSearchParams({
    select:
      "id,order_number,payment_status,demo_payment_proof_path",
    order_number: `eq.${orderNumber}`,
    demo_payment_token_hash: `eq.${hash}`,
    limit: "1"
  });

  try {
    const orders = await supa(
      `/rest/v1/orders?${q}`
    );

    if (
      !Array.isArray(orders) ||
      orders.length !== 1
    ) {
      return respond(
        res,
        404,
        "Pesanan atau token tidak cocok."
      );
    }

    const order = orders[0];

    if (order.payment_status === "PAID_DEMO") {
      return respond(
        res,
        200,
        "Pesanan telah dikonfirmasi sebelumnya.",
        {
          order_number: orderNumber,
          payment_status: "PAID_DEMO"
        }
      );
    }

    if (order.payment_status !== "PENDING_DEMO") {
      return respond(
        res,
        409,
        "Pesanan tidak dapat dikonfirmasi."
      );
    }

    const objectPath =
      `${order.id}/${crypto.randomUUID()}.${MIME[mime]}`;

    const upload = await fetch(
      `${SUPABASE_URL.replace(/\/+$/, "")}` +
      `/storage/v1/object/${BUCKET}/${objectPath}`,
      {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": mime,
          "Cache-Control": "no-store",
          "x-upsert": "false"
        },
        body: file
      }
    );

    if (!upload.ok) {
      console.error(
        "Storage upload failed",
        upload.status
      );

      return respond(
        res,
        502,
        "Gagal menyimpan bukti DEMO. Silakan coba lagi."
      );
    }

    const now = new Date().toISOString();

    const filters = new URLSearchParams({
      id: `eq.${order.id}`,
      demo_payment_token_hash: `eq.${hash}`,
      payment_status: "eq.PENDING_DEMO",
      demo_payment_proof_path: "is.null",
      select: "id,order_number,payment_status"
    });

    const changed = await supa(
      `/rest/v1/orders?${filters}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          demo_payment_proof_path: objectPath,
          demo_payment_proof_uploaded_at: now,
          demo_payment_verified_at: now,
          payment_status: "PAID_DEMO",
          paid_at: now
        })
      }
    );

    if (
      Array.isArray(changed) &&
      changed.length === 1
    ) {
      return respond(
        res,
        200,
        "Unggahan bukti simulasi berhasil. Status PAID_DEMO.",
        {
          demo: true,
          order_number: orderNumber,
          payment_status: "PAID_DEMO",
          notice:
            "DEMO / TEST — BUKAN BUKTI PEMBAYARAN SAH"
        }
      );
    }

    return respond(
      res,
      409,
      "Status pesanan telah berubah. Periksa status pesanan."
    );
  } catch (error) {
    console.error(
      "upload-demo-proof error",
      error?.message || "UNKNOWN"
    );

    return respond(
      res,
      500,
      "Unggah bukti DEMO gagal. Silakan coba kembali."
    );
  }
};
