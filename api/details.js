
"use strict";

const crypto = require("node:crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OTP_SECRET = process.env.OTP_SECRET;

function reply(res, status, data) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(status).json(data);
}

function hmac(value) {
  return crypto
    .createHmac("sha256", OTP_SECRET)
    .update(value)
    .digest("hex");
}

function verifySession(token) {
  if (typeof token !== "string" || token.length > 4096) {
    return null;
  }

  const parts = token.split(".");

  if (parts.length !== 2) {
    return null;
  }

  const [payload, signature] = parts;

  if (!/^[A-Za-z0-9_-]+$/.test(payload) ||
      !/^[a-f0-9]{64}$/.test(signature)) {
    return null;
  }

  const expected = hmac(`session:${payload}`);

  const receivedBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  if (!crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) {
    return null;
  }

  let session;

  try {
    session = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);

  if (
    session.iss !== "baladhika-funrun-2026" ||
    !Number.isSafeInteger(session.exp) ||
    session.exp <= now ||
    session.exp > now + 900 ||
    typeof session.order_number !== "string" ||
    typeof session.email !== "string"
  ) {
    return null;
  }

  return session;
}

async function supabaseGet(table, params) {
  const url = new URL(
    `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/${table}`
  );

  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  const response = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`Supabase ${table}: HTTP ${response.status}`);
  }

  return response.json();
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
      message: "Layanan riwayat belum siap."
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

  if (Buffer.byteLength(JSON.stringify(body)) > 8192) {
    return reply(res, 413, {
      ok: false,
      message: "Permintaan terlalu besar."
    });
  }

  const session = verifySession(body.session_token);

  if (!session) {
    return reply(res, 401, {
      ok: false,
      message: "Sesi tidak valid atau telah berakhir. Verifikasi OTP kembali."
    });
  }

  try {
    const orderNumber = session.order_number.toUpperCase();
    const email = session.email.trim().toLowerCase();

    let orderId = null;

    // Cari nomor pesanan langsung terlebih dahulu.
    const directOrders = await supabaseGet("orders", {
      select: "id",
      order_number: `eq.${orderNumber}`,
      limit: "1"
    });

    if (directOrders.length) {
      orderId = directOrders[0].id;
    } else {
      // Mendukung nomor pesanan baru maupun nomor lama.
      const mappings = await supabaseGet(
        "order_number_mapping_20261026",
        {
          select: "order_id",
          or: `(new_order_number.eq.${orderNumber},old_order_number.eq.${orderNumber})`,
          limit: "1"
        }
      );

      if (mappings.length) {
        orderId = mappings[0].order_id;
      }
    }

    if (!orderId) {
      return reply(res, 404, {
        ok: false,
        message: "Pesanan tidak ditemukan."
      });
    }

    const orders = await supabaseGet("orders", {
      select:
        "id,order_number,buyer_name,buyer_email,buyer_phone," +
        "total_participants,total_amount,currency," +
        "payment_status,payment_method,created_at,paid_at," +
        "payment_expires_at,expiry_policy_version",
      id: `eq.${orderId}`,
      limit: "1"
    });

    const order = orders[0];

    if (
      !order ||
      order.buyer_email.trim().toLowerCase() !== email
    ) {
      return reply(res, 403, {
        ok: false,
        message: "Akses pesanan tidak diizinkan."
      });
    }

    const isPaid = order.payment_status === "PAID_DEMO";
    const isLegacy = order.expiry_policy_version === 0;

    if (
      !isPaid &&
      !isLegacy &&
      (
        !order.payment_expires_at ||
        new Date(order.payment_expires_at).getTime() <= Date.now()
      )
    ) {
      return reply(res, 410, {
        ok: false,
        message: "Masa berlaku pesanan telah berakhir."
      });
    }

    const participants = await supabaseGet("participants", {
      select:
        "id,registration_number,ticket_category," +
        "first_name,last_name,bib_name,birth_date,gender," +
        "jersey_size,phone,city,province,regency," +
        "racepack_status",
      order_id: `eq.${order.id}`,
      order: "created_at.asc",
      limit: "100"
    });

    return reply(res, 200, {
      ok: true,
      order: {
        order_number: orderNumber,
        buyer_name: order.buyer_name,
        buyer_email: order.buyer_email,
        buyer_phone: order.buyer_phone,
        total_participants: order.total_participants,
        total_amount: order.total_amount,
        currency: order.currency,
        payment_status: order.payment_status,
        payment_method: order.payment_method,
        created_at: order.created_at,
        paid_at: order.paid_at
      },
      participants: participants.map((p) => ({
        id: p.id,
        registration_number: p.registration_number,
        ticket_category: p.ticket_category,
        full_name: [p.first_name, p.last_name]
          .filter(Boolean)
          .join(" "),
        bib_name: p.bib_name,
        birth_date: p.birth_date,
        gender: p.gender,
        jersey_size: p.jersey_size,
        phone: p.phone,
        city: p.city,
        province: p.province,
        regency: p.regency,
        racepack_status: p.racepack_status
      }))
    });

  } catch (error) {
    console.error("Order details failed:", error.message);

    return reply(res, 503, {
      ok: false,
      message: "Riwayat pendaftaran sementara tidak tersedia."
    });
  }
};
