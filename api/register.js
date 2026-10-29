
"use strict";

// BALADHIKA FUN RUN 2026
// API PENDAFTARAN LIVE REAL
// Pendaftaran tetap TERTUTUP secara default.

const MAX_PARTICIPANTS = 10;

function respond(res, status, data) {
  return res.status(status).json(data);
}

function clean(value, max = 250) {
  return typeof value === "string"
    ? value.trim().slice(0, max)
    : "";
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Allow", "POST");

  if (req.method !== "POST") {
    return respond(res, 405, {
      success: false,
      error: "Metode tidak diizinkan."
    });
  }

  // Pendaftaran tetap ditutup selama pengujian.
  if (process.env.REGISTRATION_OPEN !== "true") {
    return respond(res, 503, {
      success: false,
      registration_open: false,
      code: "REGISTRATION_CLOSED_FOR_MIGRATION",
      error:
        "Pendaftaran Baladhika Fun Run 2026 ditutup sementara."
    });
  }

  const supabaseUrl = (
    process.env.SUPABASE_URL || ""
  ).replace(/\/+$/, "");

  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  if (!supabaseUrl || !serviceKey) {
    console.error("Supabase configuration missing");

    return respond(res, 503, {
      success: false,
      error: "Layanan pendaftaran belum siap."
    });
  }

  try {
    const contentLength = Number(
      req.headers["content-length"] || 0
    );

    if (contentLength > 32768) {
      return respond(res, 413, {
        success: false,
        error: "Data pendaftaran terlalu besar."
      });
    }

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body)
    ) {
      return respond(res, 400, {
        success: false,
        error: "Format data tidak valid."
      });
    }

    const buyer = body.order || body.buyer;
    const participants = body.participants;

    if (
      !buyer ||
      typeof buyer !== "object" ||
      Array.isArray(buyer) ||
      !Array.isArray(participants) ||
      participants.length < 1 ||
      participants.length > MAX_PARTICIPANTS
    ) {
      return respond(res, 400, {
        success: false,
        error: "Data pemesan atau peserta tidak valid."
      });
    }

    const p_order = {
      buyer_name: clean(
        buyer.buyer_name || buyer.name,
        150
      ),
      buyer_email: clean(
        buyer.buyer_email || buyer.email,
        254
      ).toLowerCase(),
      buyer_phone: clean(
        buyer.buyer_phone || buyer.phone,
        40
      )
    };

    if (
      !p_order.buyer_name ||
      !p_order.buyer_email ||
      !p_order.buyer_phone
    ) {
      return respond(res, 400, {
        success: false,
        error: "Data pemesan belum lengkap."
      });
    }

    const p_participants = participants.map(
      (p) => ({
        first_name: clean(p.first_name, 100),
        last_name: clean(p.last_name, 100),
        bib_name: clean(p.bib_name, 80),
        birth_date: clean(p.birth_date, 20),
        gender: clean(p.gender, 30),
        jersey_size: clean(p.jersey_size, 10),
        identity_type: clean(p.identity_type, 50),
        identity_number: clean(
          p.identity_number,
          80
        ),
        health_status: clean(
          p.health_status,
          150
        ),
        street_address: clean(
          p.street_address || p.address,
          500
        ),
        phone: clean(p.phone, 40),
        emergency_name: clean(
          p.emergency_name,
          150
        ),
        emergency_phone: clean(
          p.emergency_phone,
          40
        ),
        emergency_relation: clean(
          p.emergency_relation,
          80
        ),
        blood_type: clean(p.blood_type, 10),
        medical_notes: clean(
          p.medical_notes,
          500
        )
      })
    );

    const response = await fetch(
      `${supabaseUrl}/rest/v1/rpc/create_real_registration_with_access`,
      {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          p_order,
          p_participants
        }),
        signal: AbortSignal.timeout(12000)
      }
    );

    const result = await response
      .json()
      .catch(() => null);

    if (!response.ok) {
      console.error("Registration RPC failed", {
        status: response.status,
        code: result?.code,
        message: result?.message
      });

      const message = String(result?.message || "");

      if (/kuota/i.test(message)) {
        return respond(res, 409, {
          success: false,
          error: "Kuota pendaftaran tidak mencukupi."
        });
      }

      if (/email.*(terdaftar|digunakan|sudah|duplicate)/i.test(message)) {
        return respond(res, 409, {
          success: false,
          error: "Email sudah digunakan untuk pendaftaran."
        });
      }

      return respond(res, 400, {
        success: false,
        error: "Pendaftaran belum berhasil. Periksa kembali data peserta."
      });
    }

    if (
      !result ||
      result.success !== true ||
      typeof result.order_number !== "string" ||
      !/^[a-f0-9]{64}$/.test(
        String(result.payment_access_token || "")
      )
    ) {
      return respond(res, 500, {
        success: false,
        error: "Respons pendaftaran tidak valid."
      });
    }

    const paymentAccessToken = result.payment_access_token;

    const paymentUrl =
      `https://www.baladhikafunrun.com/payment-real.html` +
      `#order=${encodeURIComponent(result.order_number)}` +
      `&access=${encodeURIComponent(paymentAccessToken)}`;

    return respond(res, 201, {
      success: true,
      order_number: result.order_number,
      total_participants: result.total_participants,
      total_amount: result.total_amount,
      payment_method: result.payment_method,
      payment_status: result.payment_status,
      booking_codes: result.booking_codes,
      payment_access_token: paymentAccessToken,
      payment_url: paymentUrl
    });

  } catch (error) {
    console.error(
      "Registration error:",
      error?.message
    );

    return respond(res, 500, {
      success: false,
      error: "Layanan pendaftaran sedang mengalami gangguan."
    });
  }
};
