
const crypto = require("node:crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_PARTICIPANTS_PER_ORDER = 20;

const PRICES = {
  EARLY_BIRD: 125000,
  NORMAL: 150000,
};

function send(res, status, data) {
  return res.status(status).json(data);
}

function clean(value, max = 200) {
  return typeof value === "string"
    ? value.trim().slice(0, max)
    : "";
}

function makeCode(prefix) {
  return (
    prefix +
    "-" +
    crypto.randomBytes(10).toString("hex").toUpperCase()
  );
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validPhone(phone) {
  return /^[+0-9()\s-]{8,25}$/.test(phone);
}

async function createRegistration(order, participants) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/create_demo_registration`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_order: order,
        p_participants: participants,
      }),
    }
  );

  const result = await response.json().catch(() => null);

  if (!response.ok) {
    console.error(
      "Supabase registration error:",
      response.status,
      result?.code || "UNKNOWN"
    );

    const message = String(result?.message || "");

    if (
      message.includes("Kuota total 2.000") ||
      message.includes("Kuota total")
    ) {
      return {
        error: "Kuota gabungan 2.000 peserta sudah penuh.",
        status: 409,
      };
    }

    return {
      error: "Pendaftaran gagal disimpan. Silakan coba lagi.",
      status: 500,
    };
  }

  return { data: result };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return send(res, 405, {
      error: "Metode tidak diizinkan.",
    });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return send(res, 500, {
      error: "Konfigurasi database belum tersedia.",
    });
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    if (!body || typeof body !== "object") {
      return send(res, 400, {
        error: "Data pendaftaran tidak valid.",
      });
    }

    const buyer = body.buyer || {};
    const inputParticipants = body.participants;

    if (
      !Array.isArray(inputParticipants) ||
      inputParticipants.length < 1 ||
      inputParticipants.length > MAX_PARTICIPANTS_PER_ORDER
    ) {
      return send(res, 400, {
        error: "Jumlah peserta per pesanan harus 1 sampai 20 orang.",
      });
    }

    const buyerName = clean(buyer.name);
    const buyerEmail = clean(buyer.email, 254).toLowerCase();
    const buyerPhone = clean(buyer.phone, 30);

    if (
      !buyerName ||
      !validEmail(buyerEmail) ||
      !validPhone(buyerPhone)
    ) {
      return send(res, 400, {
        error: "Nama, email, atau nomor HP pemesan tidak valid.",
      });
    }

    const paymentMethod = clean(
      body.payment_method,
      30
    ).toUpperCase();

    if (
      !["QRIS_DEMO", "VA_MANDIRI_DEMO"].includes(paymentMethod)
    ) {
      return send(res, 400, {
        error: "Pilih metode pembayaran simulasi.",
      });
    }

    const participants = [];
    let earlyQty = 0;
    let normalQty = 0;

    for (const person of inputParticipants) {
      if (!person || typeof person !== "object") {
        return send(res, 400, {
          error: "Data peserta tidak valid.",
        });
      }

      const category = clean(
        person.category || person.ticket_category,
        30
      ).toUpperCase();

      if (
        category !== "EARLY_BIRD" &&
        category !== "NORMAL"
      ) {
        return send(res, 400, {
          error: "Kategori tiket peserta tidak valid.",
        });
      }

      const firstName = clean(person.first_name);
      const lastName = clean(person.last_name);
      const bibName = clean(person.bib_name, 40);
      const emergencyName = clean(person.emergency_name);
      const emergencyPhone = clean(
        person.emergency_phone,
        30
      );

      if (
        !firstName ||
        !lastName ||
        !bibName ||
        !emergencyName ||
        !validPhone(emergencyPhone)
      ) {
        return send(res, 400, {
          error:
            "Nama, nama BIB, dan kontak darurat peserta wajib diisi.",
        });
      }

      if (category === "EARLY_BIRD") {
        earlyQty++;
      } else {
        normalQty++;
      }

      participants.push({
        registration_number: makeCode("BFR"),
        ticket_category: category,

        first_name: firstName,
        last_name: lastName,
        bib_name: bibName,

        birth_date: clean(person.birth_date, 10) || null,
        gender: clean(person.gender, 30) || null,
        jersey_size: clean(person.jersey_size, 10) || null,
        blood_type: clean(person.blood_type, 5) || null,
        phone: clean(person.phone, 30) || null,

        emergency_name: emergencyName,
        emergency_phone: emergencyPhone,
        emergency_relation:
          clean(person.emergency_relation, 50) || null,

        city: clean(person.city, 100) || null,
        medical_notes:
          clean(person.medical_notes, 1000) || null,
      });
    }

    const totalAmount =
      earlyQty * PRICES.EARLY_BIRD +
      normalQty * PRICES.NORMAL;

    const orderNumber = makeCode("BFR-ORDER");

    // Token acak untuk konfirmasi pembayaran demo.
    // Database hanya menyimpan hash token.
    const paymentToken = crypto.randomBytes(32).toString("hex");

    const paymentTokenHash = crypto
      .createHash("sha256")
      .update(paymentToken)
      .digest("hex");

    const order = {
      order_number: orderNumber,

      buyer_name: buyerName,
      buyer_email: buyerEmail,
      buyer_phone: buyerPhone,

      early_bird_qty: earlyQty,
      normal_qty: normalQty,

      total_amount: totalAmount,

      payment_method: paymentMethod,
      demo_payment_token_hash: paymentTokenHash,
    };

    const result = await createRegistration(
      order,
      participants
    );

    if (result.error) {
      return send(res, result.status, {
        success: false,
        error: result.error,
      });
    }

    return send(res, 201, {
      success: true,
      demo: true,

      message: "Pendaftaran simulasi berhasil dibuat.",

      order_number: result.data.order_number,

      early_bird_qty: earlyQty,
      normal_qty: normalQty,

      total_participants:
        result.data.total_participants,

      total_amount: result.data.total_amount,

      currency: "IDR",

      payment_method: paymentMethod,
      payment_status: "PENDING_DEMO",

      payment_token: paymentToken,

      notice:
        "DEMO - BUKAN BUKTI PEMBAYARAN SAH",
    });
  } catch (error) {
    console.error(
      "Registration handler error:",
      error.message
    );

    return send(res, 500, {
      success: false,
      error:
        "Terjadi kesalahan sistem. Silakan coba kembali.",
    });
  }
};
