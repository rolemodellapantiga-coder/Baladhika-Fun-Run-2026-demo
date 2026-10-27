
"use strict";

const crypto = require("node:crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_PARTICIPANTS_PER_ORDER = 10;

const PRICES = {
  EARLY_BIRD: 125000,
  NORMAL: 150000,
};

const VALID_SIZES = [
  "XS", "S", "M", "L", "XL", "XXL", "XXXL"
];

const VALID_IDENTITIES = [
  "KTP",
  "KIA",
  "Paspor",
  "Identitas Lainnya",
];

const VALID_HEALTH = [
  "Sehat / Siap Mengikuti Lari",
  "Memiliki Kondisi Kesehatan yang Perlu Diperhatikan",
];

function send(res, status, data) {
  return res.status(status).json(data);
}

function clean(value, max = 200) {
  return typeof value === "string"
    ? value.trim().slice(0, max)
    : "";
}

function required(value, max = 200) {
  return clean(value, max);
}

// Nomor registrasi peserta tetap memakai format lama.
function makeCode(prefix) {
  return (
    prefix +
    "-" +
    crypto.randomBytes(10).toString("hex").toUpperCase()
  );
}

// Nomor pesanan: BDJ + 5 karakter acak.
function makeOrderNumber() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = "BDJ-";

  for (let i = 0; i < 5; i++) {
    value += alphabet[crypto.randomInt(alphabet.length)];
  }

  return value;
}

function validEmail(email) {
  return (
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

function validPhone(phone) {
  return /^[+0-9()\s-]{8,25}$/.test(phone);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(value + "T00:00:00Z");

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    value <= new Date().toISOString().slice(0, 10)
  );
}

function normalizeGender(value) {
  const gender = clean(value, 30).toUpperCase();

  if (gender === "LAKI-LAKI") {
    return "LAKI-LAKI";
  }

  if (gender === "PEREMPUAN") {
    return "PEREMPUAN";
  }

  return "";
}

function validPaymentMethod(value) {
  return [
    "QRIS_DEMO",
    "VA_MANDIRI_DEMO",
  ].includes(value);
}

function supabaseError(result) {
  const message = String(result?.message || "");

  if (message.includes("EMAIL_ALREADY_REGISTERED") ||
      /registration_email_locks.*(?:duplicate|unique)/i.test(message)) {
    return {
      status: 409,
      error: "Email ini sudah memiliki pendaftaran. Silakan gunakan CEK PESANAN untuk melanjutkan pembayaran atau melihat statusnya.",
    };
  }

  if (
    message.includes("SOLD OUT") ||
    message.includes("tidak mencukupi") ||
    message.includes("belum dibuka") ||
    message.includes("sudah SOLD OUT")
  ) {
    return {
      status: 409,
      error: message,
    };
  }

  if (
    message.includes("tidak valid") ||
    message.includes("tidak sesuai") ||
    message.includes("belum lengkap")
  ) {
    return {
      status: 400,
      error: message,
    };
  }

  if (result?.code === "23505") {
    return {
      status: 409,
      error:
        "Terjadi duplikasi data registrasi. Silakan ulangi pendaftaran.",
    };
  }

  return {
    status: 500,
    error:
      "Pendaftaran gagal disimpan. Silakan coba kembali.",
  };
}

// Memeriksa nomor yang pernah digunakan, termasuk pesanan yang sudah dihapus.
// Mapping lama tetap diperiksa untuk kompatibilitas.
async function orderNumberExists(number) {
  const base = SUPABASE_URL.replace(/\/+$/, "");
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    Accept: "application/json",
  };

  const checks = [
    `${base}/rest/v1/used_order_numbers?select=order_number&order_number=eq.${number}&limit=1`,
    `${base}/rest/v1/order_number_mapping_20261026?select=order_id&new_order_number=eq.${number}&limit=1`,
  ];

  for (const url of checks) {
    const response = await fetch(url, {
      headers,
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(
        `Pemeriksaan nomor pesanan gagal: ${response.status}`
      );
    }

    const rows = await response.json();

    if (!Array.isArray(rows)) {
      throw new Error("Respons database tidak valid.");
    }

    if (rows.length > 0) {
      return true;
    }
  }

  return false;
}

// Baca waktu kedaluwarsa dari database, bukan menghitung ulang di browser.
async function getRegistrationExpiry(orderNumber) {
  const url = SUPABASE_URL.replace(/\/+$/, "") +
    "/rest/v1/rpc/get_registration_expiry";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_order_number: orderNumber }),
    cache: "no-store",
  });
  if (!response.ok) {
    console.error("Expiry lookup failed:", response.status);
    return null;
  }
  const result = await response.json().catch(() => null);
  if (!result || result.order_number !== orderNumber ||
      result.expiry_policy_version !== 1 ||
      !result.payment_expires_at) return null;
  return result.payment_expires_at;
}

async function createRegistration(order, participants) {
  const url =
    SUPABASE_URL.replace(/\/+$/, "") +
    "/rest/v1/rpc/create_demo_registration";

  const response = await fetch(url, {
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
  });

  const result = await response.json().catch(() => null);

  if (!response.ok) {
    console.error(
      "Registration database error:",
      response.status,
      result?.code || "UNKNOWN"
    );

    return {
      error: supabaseError(result),
      duplicateCode:
        result?.code === "23505" &&
        /order_number|orders_order_number_key|used_order_numbers_pkey/i.test(
          String(result?.message || "") +
          " " +
          String(result?.details || "") +
          " " +
          String(result?.constraint || "")
        ),
    };
  }

  if (!result || result.success !== true) {
    return {
      error: {
        status: 500,
        error: "Respons database tidak sesuai.",
      },
    };
  }

  return { data: result };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return send(res, 405, {
      success: false,
      error: "Metode tidak diizinkan.",
    });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return send(res, 500, {
      success: false,
      error: "Konfigurasi database belum tersedia.",
    });
  }

  try {
    let body;

    try {
      body =
        typeof req.body === "string"
          ? JSON.parse(req.body)
          : req.body;
    } catch {
      return send(res, 400, {
        success: false,
        error: "Format JSON tidak valid.",
      });
    }

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body)
    ) {
      return send(res, 400, {
        success: false,
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
        success: false,
        error:
          "Jumlah peserta harus 1 sampai 10 orang per pesanan.",
      });
    }

    // =====================================
    // VALIDASI DATA PEMESAN UTAMA
    // =====================================

    const buyerName = required(buyer.name, 200);

    const buyerEmail = required(
      buyer.email, 254
    ).toLowerCase();

    const buyerPhone = required(buyer.phone, 30);

    if (
      !buyerName ||
      !validEmail(buyerEmail) ||
      !validPhone(buyerPhone)
    ) {
      return send(res, 400, {
        success: false,
        error:
          "Nama, email, atau nomor HP pemesan tidak valid.",
      });
    }

    const paymentMethod = clean(
      body.payment_method, 30
    ).toUpperCase();

    if (!validPaymentMethod(paymentMethod)) {
      return send(res, 400, {
        success: false,
        error:
          "Pilih metode pembayaran DEMO yang tersedia.",
      });
    }

    // =====================================
    // VALIDASI DATA SETIAP PESERTA
    // =====================================

    const participants = [];

    let earlyQty = 0;
    let normalQty = 0;

    for (
      let i = 0;
      i < inputParticipants.length;
      i++
    ) {
      const person = inputParticipants[i];

      if (
        !person ||
        typeof person !== "object" ||
        Array.isArray(person)
      ) {
        return send(res, 400, {
          success: false,
          error: `Data peserta ${i + 1} tidak valid.`,
        });
      }

      const category = clean(
        person.category || person.ticket_category,
        30
      ).toUpperCase();

      if (!Object.hasOwn(PRICES, category)) {
        return send(res, 400, {
          success: false,
          error:
            `Kategori tiket peserta ${i + 1} tidak valid.`,
        });
      }

      const firstName = required(person.first_name);
      const lastName = required(person.last_name);
      const bibName = required(person.bib_name, 40);

      const birthDate = required(
        person.birth_date, 10
      );

      const gender = normalizeGender(person.gender);

      const jerseySize = required(
        person.jersey_size, 10
      ).toUpperCase();

      const identityType = required(
        person.identity_type, 50
      );

      const identityNumber = required(
        person.identity_number, 100
      );

      const healthStatus = required(
        person.health_status, 200
      );

      const province = required(
        person.province, 150
      );

      const regency = required(
        person.regency, 150
      );

      const district = required(
        person.district, 150
      );

      const village = required(
        person.village, 150
      );

      const streetAddress = required(
        person.street_address, 500
      );

      const postalCode = clean(
        person.postal_code, 20
      );

      const phone = clean(person.phone, 30);

      const emergencyName = required(
        person.emergency_name, 200
      );

      const emergencyPhone = required(
        person.emergency_phone, 30
      );

      const emergencyRelation = required(
        person.emergency_relation, 50
      );

      if (
        !firstName ||
        !lastName ||
        !bibName ||
        !validDate(birthDate) ||
        !gender ||
        !VALID_SIZES.includes(jerseySize)
      ) {
        return send(res, 400, {
          success: false,
          error:
            `Identitas dasar peserta ${i + 1} belum lengkap atau tidak valid.`,
        });
      }

      if (
        !VALID_IDENTITIES.includes(identityType) ||
        !identityNumber
      ) {
        return send(res, 400, {
          success: false,
          error:
            `Dokumen identitas peserta ${i + 1} belum lengkap.`,
        });
      }

      if (!VALID_HEALTH.includes(healthStatus)) {
        return send(res, 400, {
          success: false,
          error:
            `Status kesehatan peserta ${i + 1} tidak valid.`,
        });
      }

      if (
        !province ||
        !regency ||
        !district ||
        !village ||
        !streetAddress
      ) {
        return send(res, 400, {
          success: false,
          error:
            `Alamat lengkap peserta ${i + 1} wajib diisi.`,
        });
      }

      if (phone && !validPhone(phone)) {
        return send(res, 400, {
          success: false,
          error:
            `Nomor HP peserta ${i + 1} tidak valid.`,
        });
      }

      if (
        !emergencyName ||
        !validPhone(emergencyPhone) ||
        !emergencyRelation
      ) {
        return send(res, 400, {
          success: false,
          error:
            `Kontak darurat peserta ${i + 1} belum lengkap.`,
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

        birth_date: birthDate,
        gender,
        jersey_size: jerseySize,

        identity_type: identityType,
        identity_number: identityNumber,

        health_status: healthStatus,

        province,
        regency,
        district,
        village,
        street_address: streetAddress,
        postal_code: postalCode || null,

        phone: phone || null,

        emergency_name: emergencyName,
        emergency_phone: emergencyPhone,
        emergency_relation: emergencyRelation,

        // Kolom lama tetap dipertahankan.
        city: regency,
        blood_type:
          clean(person.blood_type, 5) || null,
        medical_notes:
          clean(person.medical_notes, 1000) || null,
      });
    }

    // Satu pesanan hanya satu kategori tiket.
    if (earlyQty > 0 && normalQty > 0) {
      return send(res, 400, {
        success: false,
        error:
          "Satu pesanan hanya boleh menggunakan satu kategori tiket.",
      });
    }

    // =====================================
    // PEMBUATAN PESANAN DEMO
    // =====================================

    const totalAmount =
      earlyQty * PRICES.EARLY_BIRD +
      normalQty * PRICES.NORMAL;

    const paymentToken = crypto
      .randomBytes(32)
      .toString("hex");

    const paymentTokenHash = crypto
      .createHash("sha256")
      .update(paymentToken)
      .digest("hex");

    // =====================================
    // SIMPAN KE SUPABASE
    // =====================================

    let result = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      const orderNumber = makeOrderNumber();

      // Cegah benturan dengan nomor pesanan lama
      // yang sudah disiapkan dalam tabel mapping.
      const alreadyExists =
        await orderNumberExists(orderNumber);

      if (alreadyExists) {
        continue;
      }

      const order = {
        order_number: orderNumber,

        buyer_name: buyerName,
        buyer_email: buyerEmail,
        buyer_phone: buyerPhone,

        early_bird_qty: earlyQty,
        normal_qty: normalQty,

        total_participants: participants.length,
        total_amount: totalAmount,

        payment_method: paymentMethod,

        demo_payment_token_hash: paymentTokenHash,
      };

      result = await createRegistration(
        order,
        participants
      );

      if (result.duplicateCode) {
        continue;
      }

      break;
    }

    if (!result || result.duplicateCode) {
      return send(res, 409, {
        success: false,
        error:
          "Nomor pesanan belum berhasil dibuat. Silakan coba kembali.",
      });
    }

    if (result.error) {
      return send(res, result.error.status, {
        success: false,
        error: result.error.error,
      });
    }

    // Pesanan telah tersimpan. Kegagalan membaca expiry tidak boleh
    // membuat klien mengulang pendaftaran dan menghasilkan duplikasi.
    const paymentExpiresAt = await getRegistrationExpiry(
      result.data.order_number
    );

    // =====================================
    // HASIL REGISTRASI DEMO
    // =====================================

    return send(res, 201, {
      success: true,
      demo: true,

      message:
        "Pendaftaran DEMO berhasil disimpan.",

      order_number: result.data.order_number,

      registration_numbers:
        result.data.registration_numbers,

      early_bird_qty: earlyQty,
      normal_qty: normalQty,

      total_participants:
        result.data.total_participants,

      total_amount:
        result.data.total_amount,

      currency: "IDR",

      payment_method: paymentMethod,
      payment_status: "PENDING_DEMO",
      payment_expires_at: paymentExpiresAt,
      payment_window_minutes: 60,
      expiry_notice: "Selesaikan pembayaran dalam 1 jam sejak pendaftaran disimpan. Jika belum dibayar, data pendaftaran akan dihapus permanen dan Anda harus mendaftar ulang.",

      payment_token: paymentToken,

      notice:
        "DEMO - BUKAN BUKTI PEMBAYARAN SAH",
    });

  } catch (error) {
    console.error(
      "Registration handler error:",
      error?.name || "UNKNOWN"
    );

    return send(res, 500, {
      success: false,
      error:
        "Terjadi kesalahan sistem. Silakan coba kembali.",
    });
  }
};
