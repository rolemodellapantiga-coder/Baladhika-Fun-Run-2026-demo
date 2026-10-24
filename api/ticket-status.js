
/**
 * BALADHIKA FUN RUN 2026
 * API: /api/ticket-status
 *
 * Kuota:
 * Early Bird 1.800
 * Normal 200
 *
 * Perhitungan dilakukan oleh Supabase.
 * Jumlah kuota tidak dikirimkan ke publik.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return res.status(405).json({
      success: false,
      error: "Metode tidak diizinkan.",
    });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(503).json({
      success: false,
      error: "Konfigurasi server belum tersedia.",
    });
  }

  try {
    const url =
      SUPABASE_URL.replace(/\/+$/, "") +
      "/rest/v1/rpc/get_demo_ticket_status";

    const response = await fetch(url, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
      cache: "no-store",
    });

    if (!response.ok) {
      console.error(
        "Ticket status database error:",
        response.status
      );

      throw new Error(
        "Gagal membaca status tiket."
      );
    }

    const data = await response.json();

    if (!data || data.success !== true) {
      throw new Error(
        "Respons status tiket tidak valid."
      );
    }

    return res.status(200).json({
      success: true,

      active_category:
        data.active_category,

      early_bird: data.early_bird,
      normal: data.normal,

      registration_open:
        data.registration_open,
    });

  } catch (error) {
    console.error(
      "Ticket status error:",
      error?.message || "UNKNOWN"
    );

    return res.status(503).json({
      success: false,
      error:
        "Status tiket belum dapat diperiksa.",
    });
  }
};
