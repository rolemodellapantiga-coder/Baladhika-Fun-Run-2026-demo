"use strict";

// BALADHIKA FUN RUN 2026
// Penguncian server-side selama migrasi sistem pembayaran nyata.
// Jangan membuka endpoint ini sebelum backend LIVE REAL selesai diuji.
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Allow", "POST");

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Metode tidak diizinkan."
    });
  }

  return res.status(503).json({
    success: false,
    registration_open: false,
    code: "REGISTRATION_CLOSED_FOR_MIGRATION",
    error: "Pendaftaran Baladhika Fun Run 2026 ditutup sementara selama pembaruan sistem."
  });
};
