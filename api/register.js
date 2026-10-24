
const crypto = require("node:crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PRICES = {
  EARLY_BIRD: 125000,
  NORMAL: 150000,
};

function send(res, status, data) {
  res.status(status).json(data);
}

function clean(value, max = 200) {
  return typeof value === "string"
    ? value.trim().slice(0, max)
    : "";
}

function makeCode(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
}

async function supabase(path, options = {}) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...options.headers,
      },
    }
  );

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    console.error("Database request failed", response.status);
    throw new Error("DATABASE_ERROR");
  }

  return data;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "Metode tidak diizinkan." });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return send(res, 500, {
      error: "Konfigurasi database belum tersedia.",
    });
  }

  try {
    const body = typeof req.body === "string"
      ? JSON.parse(req.body)
      : req.body;

    const buyer = body?.buyer || {};
    const participants = body?.participants;

    if (!Array.isArray(participants) ||
        participants.length < 1 ||
        participants.length > 20) {
      return send(res, 400, {
        error: "Jumlah peserta harus 1 sampai 20 orang.",
      });
    }

    const buyerName = clean(buyer.name);
    const buyerEmail = clean(buyer.email, 254).toLowerCase();
    const buyerPhone = clean(buyer.phone, 30);

    if (
      !buyerName ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail) ||
      !buyerPhone
    ) {
      return send(res, 400, {
        error: "Nama, email, dan nomor HP pemesan wajib valid.",
      });
    }

    const rows = [];
    let earlyQty = 0;
    let normalQty = 0;

    for (const person of participants) {
      const category = clean(person.category).toUpperCase();

      if (!["EARLY_BIRD", "NORMAL"].includes(category)) {
        return send(res, 400, {
          error: "Kategori tiket tidak valid.",
        });
      }

      const firstName = clean(person.first_name);
      const lastName = clean(person.last_name);
      const bibName = clean(person.bib_name, 40);
      const emergencyName = clean(person.emergency_name);
      const emergencyPhone = clean(person.emergency_phone, 30);

      if (
        !firstName ||
        !lastName ||
        !bibName ||
        !emergencyName ||
        !emergencyPhone
      ) {
        return send(res, 400, {
          error: "Identitas dan kontak darurat peserta wajib diisi.",
        });
      }

      if (category === "EARLY_BIRD") earlyQty++;
      else normalQty++;

      rows.push({
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

    const method = clean(body.payment_method).toUpperCase();

    if (!["QRIS_DEMO", "VA_MANDIRI_DEMO"].includes(method)) {
      return send(res, 400, {
        error: "Pilih metode pembayaran demo.",
      });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const orderNumber = makeCode("BFR-ORDER");

    const createdOrders = await supabase("orders", {
      method: "POST",
      body: JSON.stringify({
        order_number: orderNumber,
        buyer_name: buyerName,
        buyer_email: buyerEmail,
        buyer_phone: buyerPhone,
        early_bird_qty: earlyQty,
        normal_qty: normalQty,
        total_amount: totalAmount,
        payment_method: method,
        payment_status: "PENDING_DEMO",
        demo_payment_token_hash: tokenHash,
      }),
    });

    const order = createdOrders?.[0];

    if (!order?.id) {
      throw new Error("ORDER_CREATE_FAILED");
    }

    const participantRows = rows.map((row) => ({
      ...row,
      order_id: order.id,
    }));

    try {
      await supabase("participants", {
        method: "POST",
        body: JSON.stringify(participantRows),
      });
    } catch (error) {
      // Batalkan pesanan yang gagal menyimpan peserta.
      try {
        await supabase(
          `orders?id=eq.${encodeURIComponent(order.id)}`,
          { method: "DELETE" }
        );
      } catch {
        console.error("Order cleanup failed");
      }
      throw error;
    }

    return send(res, 201, {
      success: true,
      demo: true,
      message: "Pendaftaran demo berhasil dibuat.",
      order_number: orderNumber,
      total_participants: participants.length,
      total_amount: totalAmount,
      currency: "IDR",
      payment_method: method,
      payment_status: "PENDING_DEMO",
      payment_token: token,
      notice: "DEMO - BUKAN BUKTI PEMBAYARAN SAH",
    });

  } catch (error) {
    console.error("Registration error:", error.message);

    return send(res, 500, {
      error: "Pendaftaran belum dapat diproses. Silakan coba lagi.",
    });
  }
};
