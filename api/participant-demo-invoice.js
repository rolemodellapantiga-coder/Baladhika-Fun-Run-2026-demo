
"use strict";

// API invoice DEMO peserta.
// Verifikasi nomor pesanan dan email pemesan.
// Hanya pesanan PAID_DEMO yang dapat mengakses invoice.

const URL_BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FORMAT = /^BDJ-[A-HJ-NP-Z2-9]{5}$/;

function send(res, status, data) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(status).json(data);
}

async function rows(table, query) {
  const url =
    URL_BASE.replace(/\/+$/, "") +
    "/rest/v1/" +
    table +
    "?" +
    new URLSearchParams(query);

  const response = await fetch(url, {
    headers: {
      apikey: KEY,
      Authorization: "Bearer " + KEY,
      Accept: "application/json"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error("Supabase HTTP " + response.status);
  }

  const data = await response.json();

  if (!Array.isArray(data)) {
    throw new Error("Respons tidak valid");
  }

  return data;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, {
      success: false,
      error: "Metode tidak diizinkan."
    });
  }

  if (!URL_BASE || !KEY) {
    return send(res, 503, {
      success: false,
      error: "Server belum dikonfigurasi."
    });
  }

  const body =
    req.body &&
    typeof req.body === "object" &&
    !Array.isArray(req.body)
      ? req.body
      : {};

  const order =
    typeof body.order_number === "string"
      ? body.order_number.trim().toUpperCase()
      : "";

  const email =
    typeof body.buyer_email === "string"
      ? body.buyer_email.trim().toLowerCase()
      : "";

  if (
    !FORMAT.test(order) ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return send(res, 400, {
      success: false,
      error: "Nomor pesanan atau email tidak valid."
    });
  }

  try {
    const orders = await rows("orders", {
      select:
        "id,order_number,buyer_name,buyer_email,total_participants,total_amount,payment_status,paid_at",
      order_number: "eq." + order,
      limit: "1"
    });

    const o = orders[0];

    if (
      !o ||
      String(o.buyer_email || "").trim().toLowerCase() !== email
    ) {
      return send(res, 404, {
        success: false,
        error: "Data pesanan atau email tidak cocok."
      });
    }

    if (o.payment_status !== "PAID_DEMO") {
      return send(res, 403, {
        success: false,
        error:
          "Invoice hanya tersedia setelah pembayaran disetujui OWNER."
      });
    }

    const participants = await rows("participants", {
      select:
        "first_name,last_name,ticket_category,booking_code,registration_number,created_at",
      order_id: "eq." + o.id,
      order: "created_at.asc"
    });

    return send(res, 200, {
      success: true,
      demo: true,
      invoice: {
        order_number: o.order_number,
        buyer_name: o.buyer_name,
        total_participants: o.total_participants,
        total_amount: o.total_amount,
        payment_status: o.payment_status,
        paid_at: o.paid_at,
        participants: participants.map(p => ({
          name: [p.first_name, p.last_name]
            .filter(Boolean)
            .join(" "),
          ticket_category: p.ticket_category,
          booking_code: p.booking_code,
          registration_number: p.registration_number
        }))
      }
    });
  } catch (error) {
    console.error(
      "Participant demo invoice failed:",
      error.message
    );

    return send(res, 503, {
      success: false,
      error:
        "Invoice belum dapat diproses. Silakan coba kembali."
    });
  }
};
