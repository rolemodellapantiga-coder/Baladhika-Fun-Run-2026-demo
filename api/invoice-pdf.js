
"use strict";

const PDFDocument = require("pdfkit");

const BASE = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const BUCKET = "real-payment-proofs";

const ORDER = /^BDJ-[A-HJ-NP-Z2-9]{4}$/;

async function query(table, params) {
  const response = await fetch(
    `${BASE}/rest/v1/${table}?${new URLSearchParams(params)}`,
    {
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`
      },
      signal: AbortSignal.timeout(12000),
      cache: "no-store"
    }
  );

  if (!response.ok) {
    throw new Error(`${table}: ${response.status}`);
  }

  return response.json();
}

function safe(v) {
  return String(v == null ? "-" : v)
    .replace(/[\x00-\x1f]/g, " ")
    .slice(0, 220);
}

function rupiah(n) {
  return "Rp " + Number(n).toLocaleString("id-ID");
}

async function generateInvoicePdf(orderNumber) {
  if (!BASE || !KEY) {
    throw new Error("Konfigurasi Supabase belum siap");
  }

  const number = String(orderNumber || "").trim().toUpperCase();

  if (!ORDER.test(number)) {
    throw new Error("Nomor pesanan tidak valid");
  }

  const orders = await query("orders", {
    select:
      "id,order_number,buyer_name,buyer_email,normal_qty,total_participants,total_amount,payment_status,paid_at,payment_proof_path,payment_review_status",
    order_number: `eq.${number}`,
    limit: "1"
  });

  const o = orders?.[0];

  if (
    !o ||
    o.payment_status !== "PAID" ||
    o.payment_review_status !== "APPROVED"
  ) {
    throw new Error("Pembayaran belum disetujui OWNER");
  }

  const participants = await query("participants", {
    select: "first_name,last_name,booking_code,jersey_size",
    order_id: `eq.${o.id}`,
    order: "created_at.asc",
    limit: "50"
  });

  const rows = Array.isArray(participants) ? participants : [];

  let proofBytes = null;

  if (
    o.payment_proof_path &&
    o.payment_proof_path.startsWith(o.id + "/")
  ) {
    const path = o.payment_proof_path
      .split("/")
      .map(encodeURIComponent)
      .join("/");

    const response = await fetch(
      `${BASE}/storage/v1/object/${BUCKET}/${path}`,
      {
        headers: {
          apikey: KEY,
          Authorization: `Bearer ${KEY}`
        },
        signal: AbortSignal.timeout(12000),
        cache: "no-store"
      }
    );

    if (response.ok) {
      const proofType = (
        response.headers.get("content-type") || ""
      ).split(";")[0].toLowerCase();

      const bytes = Buffer.from(await response.arrayBuffer());

      if (
        bytes.length <= 5 * 1024 * 1024 &&
        ["image/jpeg", "image/png"].includes(proofType)
      ) {
        proofBytes = bytes;
      }
    }
  }

  const doc = new PDFDocument({
    size: "A4",
    margin: 46,
    autoFirstPage: true,
    info: {
      Title: `Invoice ${number}`,
      Author: "Baladhika Fun Run 2026"
    }
  });

  const chunks = [];

  doc.on("data", x => chunks.push(x));

  const finished = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const dark = "#183729";
  const orange = "#F26A21";
  const muted = "#5B645F";

  doc.rect(0, 0, 595, 112).fill(dark);

  doc
    .fillColor("#FFFFFF")
    .font("Helvetica-Bold")
    .fontSize(22)
    .text("INVOICE PEMBAYARAN", 46, 33);

  doc
    .font("Helvetica")
    .fontSize(10)
    .text("BALADHIKA FUN RUN 2026  |  5K", 46, 68);

  doc
    .fillColor(dark)
    .font("Helvetica-Bold")
    .fontSize(13)
    .text("DETAIL PESANAN", 46, 135);

  doc
    .moveTo(46, 157)
    .lineTo(549, 157)
    .strokeColor("#DDDDDD")
    .stroke();

  const fields = [
    ["Nomor Pesanan", o.order_number],
    ["Nama Pemesan", o.buyer_name],
    ["Kategori", "REGULER"],
    [
      "Jumlah Peserta",
      o.total_participants || o.normal_qty || rows.length
    ],
    ["Total Dibayar", rupiah(o.total_amount)],
    ["Status", "LUNAS - Diverifikasi OWNER"],
    [
      "Tanggal Lunas",
      o.paid_at
        ? new Date(o.paid_at).toLocaleString("id-ID", {
            timeZone: "Asia/Jakarta"
          })
        : "-"
    ]
  ];

  let y = 171;

  for (const [k, v] of fields) {
    doc
      .fillColor(muted)
      .font("Helvetica")
      .fontSize(10)
      .text(k, 46, y, { width: 155 });

    doc
      .fillColor(dark)
      .font("Helvetica-Bold")
      .text(": " + safe(v), 203, y, { width: 345 });

    y += 25;
  }

  y += 9;

  doc
    .fillColor(dark)
    .font("Helvetica-Bold")
    .fontSize(13)
    .text("KODE BOOKING PENGAMBILAN RACEPACK", 46, y);

  y += 25;

  if (rows.length) {
    for (const [i, p] of rows.entries()) {
      if (y > 690) {
        doc.addPage();
        y = 55;
      }

      doc
        .fillColor(dark)
        .font("Helvetica")
        .fontSize(10)
        .text(
          `${i + 1}. ${safe(
            [p.first_name, p.last_name].filter(Boolean).join(" ")
          )}`,
          46,
          y,
          { width: 260 }
        );

      doc
        .fillColor(orange)
        .font("Helvetica-Bold")
        .text(
          safe(p.booking_code || "BELUM TERSEDIA"),
          315,
          y,
          { width: 225 }
        );

      y += 23;
    }
  } else {
    doc
      .fillColor(muted)
      .font("Helvetica")
      .fontSize(10)
      .text(
        "Data peserta / kode booking belum tersedia di database.",
        46,
        y
      );

    y += 28;
  }

  if (y > 610) {
    doc.addPage();
    y = 55;
  }

  doc
    .roundedRect(46, y + 10, 503, 123, 9)
    .fill("#F6F1E6");

  doc
    .fillColor(dark)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text("INFORMASI PENGAMBILAN RACEPACK", 62, y + 24);

  doc
    .font("Helvetica")
    .fontSize(10)
    .text(
      "Invoice ini adalah bukti untuk pengambilan Racepack.",
      62,
      y + 45
    );

  doc.text(
    "Tanggal: 4-5 Desember 2026   |   Waktu: 09.00 s.d. 17.00 WIB",
    62,
    y + 65
  );

  doc.text("Tempat: Korem 083/BDJ", 62, y + 84);

  const mapUrl = "https://maps.app.goo.gl/dYJC8VDHShwtpsqG6";

  doc
    .fillColor("#1455A0")
    .text(mapUrl, 62, y + 103, {
      link: mapUrl,
      underline: true
    });

  doc.addPage();

  doc
    .fillColor(dark)
    .font("Helvetica-Bold")
    .fontSize(16)
    .text("LAMPIRAN BUKTI PEMBAYARAN", 46, 46);

  doc
    .fillColor(muted)
    .font("Helvetica")
    .fontSize(9)
    .text(
      `Pesanan: ${number} | Bukti diunggah peserta dan pembayaran disetujui OWNER.`,
      46,
      74,
      { width: 503 }
    );

  if (proofBytes) {
    try {
      doc.image(proofBytes, 46, 108, {
        fit: [503, 620],
        align: "center",
        valign: "top"
      });
    } catch {
      doc
        .fillColor(muted)
        .text("Lampiran gambar tidak dapat ditampilkan.", 46, 112);
    }
  } else {
    doc
      .fillColor(muted)
      .fontSize(11)
      .text(
        "Lampiran bukti transfer belum dapat ditampilkan. Periksa file di Storage atau format gambarnya (JPG/PNG).",
        46,
        112,
        { width: 490 }
      );
  }

  doc.end();

  const pdf = await finished;

  return {
    orderId: o.id,
    orderNumber: o.order_number,
    buyerName: o.buyer_name,
    buyerEmail: o.buyer_email,
    filename: `INVOICE-${number}.pdf`,
    pdf
  };
}

module.exports = { generateInvoicePdf };
