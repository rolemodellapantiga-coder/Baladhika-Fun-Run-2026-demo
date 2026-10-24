
/**
 * BALADHIKA FUN RUN 2026
 * API: /api/ticket-status
 *
 * Early Bird: 1.800 peserta
 * Normal: 200 peserta
 *
 * Tidak mengirimkan jumlah kuota kepada publik.
 */

const EARLY_BIRD_LIMIT = 1800;
const NORMAL_LIMIT = 200;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(503).json({
      error: "Konfigurasi server belum tersedia"
    });
  }

  try {
    const url = new URL(
      "/rest/v1/orders",
      supabaseUrl
    );

    url.searchParams.set(
      "select",
      "early_bird_qty,normal_qty"
    );

    url.searchParams.set(
      "payment_status",
      "in.(PENDING_DEMO,PAID_DEMO)"
    );

    const response = await fetch(url.toString(), {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Accept: "application/json"
      },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(
        `Supabase request failed: ${response.status}`
      );
    }

    const orders = await response.json();

    if (!Array.isArray(orders)) {
      throw new Error("Invalid database response");
    }

    let earlyBirdSold = 0;
    let normalSold = 0;

    for (const order of orders) {
      earlyBirdSold += Number(
        order.early_bird_qty || 0
      );

      normalSold += Number(
        order.normal_qty || 0
      );
    }

    const earlyBirdSoldOut =
      earlyBirdSold >= EARLY_BIRD_LIMIT;

    const normalSoldOut =
      normalSold >= NORMAL_LIMIT;

    let activeCategory = "EARLY_BIRD";

    if (earlyBirdSoldOut) {
      activeCategory = normalSoldOut
        ? null
        : "NORMAL";
    }

    return res.status(200).json({
      success: true,
      active_category: activeCategory,

      early_bird: {
        price: 125000,
        status: earlyBirdSoldOut
          ? "SOLD_OUT"
          : "AVAILABLE",
        can_register:
          activeCategory === "EARLY_BIRD"
      },

      normal: {
        price: 150000,
        status: normalSoldOut
          ? "SOLD_OUT"
          : earlyBirdSoldOut
            ? "AVAILABLE"
            : "COMING_SOON",
        can_register:
          activeCategory === "NORMAL"
      },

      registration_open:
        activeCategory !== null
    });

  } catch (error) {
    console.error(
      "Ticket status error:",
      error.message
    );

    return res.status(503).json({
      success: false,
      error: "Status tiket belum dapat diperiksa"
    });
  }
}
