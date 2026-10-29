
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SYNC_SECRET = process.env.GOOGLE_SHEETS_SYNC_SECRET;

async function fetchAll(table, select, orderBy = "created_at") {
  const result = [];
  const batchSize = 1000;

  for (let offset = 0; ; offset += batchSize) {
    const url = new URL(
      `${SUPABASE_URL}/rest/v1/${table}`
    );

    url.searchParams.set("select", select);
    url.searchParams.set("order", `${orderBy}.asc`);
    url.searchParams.set("limit", batchSize);
    url.searchParams.set("offset", offset);

    const response = await fetch(url, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(
        `Supabase ${table}: HTTP ${response.status}`
      );
    }

    const rows = await response.json();
    result.push(...rows);

    if (rows.length < batchSize) break;
  }

  return result;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const providedToken = req.headers["x-sync-secret"];

  if (
    !SYNC_SECRET ||
    !SUPABASE_URL ||
    !SERVICE_KEY ||
    typeof providedToken !== "string" ||
    providedToken !== SYNC_SECRET
  ) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  try {
    const orders = await fetchAll(
      "orders",
      "id,order_number,created_at,buyer_name,buyer_phone,buyer_email,total_participants,total_amount,payment_method,payment_status,payment_review_status,payment_proof_path"
    );

    const participants = await fetchAll(
      "participants",
      "id,order_id,first_name,last_name,booking_code,jersey_size,racepack_status"
    );

    const ordersById = new Map(
      orders.map(order => [order.id, order])
    );

    const rows = participants.map(participant => {
      const order = ordersById.get(participant.order_id);

      if (!order) return null;

      const approved =
        order.payment_status === "PAID" &&
        order.payment_review_status === "APPROVED";

      const fullName = [
        participant.first_name,
        participant.last_name
      ].filter(Boolean).join(" ");

      return {
        nomor_pesanan: order.order_number,
        kode_booking: approved
          ? participant.booking_code || ""
          : "",
        tanggal_pendaftaran: order.created_at,
        nama_pemesan: order.buyer_name || "",
        nomor_hp: order.buyer_phone || "",
        email: order.buyer_email || "",
        nama_peserta: fullName,
        kategori: "REGULER",
        ukuran_jersey: participant.jersey_size || "",
        jumlah_peserta: order.total_participants,
        total_tagihan: order.total_amount,
        metode_pembayaran: order.payment_method || "",
        status_pembayaran: approved
          ? "LUNAS"
          : "BELUM LUNAS",
        status_verifikasi_owner:
          order.payment_review_status === "APPROVED"
            ? "Disetujui"
            : order.payment_review_status === "REJECTED"
              ? "Ditolak"
              : "Menunggu",
        bukti_transfer: order.payment_proof_path
          ? "BUKTI TERSIMPAN - AKSES OWNER"
          : "BELUM ADA BUKTI",
        status_racepack:
          participant.racepack_status === "COLLECTED"
            ? "SUDAH DIAMBIL"
            : "BELUM DIAMBIL"
      };
    }).filter(Boolean);

    return res.status(200).json({
      success: true,
      updated_at: new Date().toISOString(),
      total_rows: rows.length,
      data: rows
    });

  } catch (error) {
    console.error("Google Sheets sync failed:", error.message);

    return res.status(500).json({
      error: "Gagal mengambil data sinkronisasi"
    });
  }
}
