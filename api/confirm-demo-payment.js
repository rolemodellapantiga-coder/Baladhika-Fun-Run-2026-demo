
"use strict";

// BALADHIKA FUN RUN 2026
// Endpoint konfirmasi lama dinonaktifkan.
// Pembayaran DEMO hanya melalui unggah bukti simulasi.

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Allow", "POST");

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Metode tidak diizinkan."
    });
  }

  return res.status(410).json({
    success: false,
    demo: true,
    error:
      "Konfirmasi pembayaran lama sudah dinonaktifkan. " +
      "Silakan unggah bukti pembayaran DEMO melalui halaman pembayaran.",
    next_step: "UPLOAD_DEMO_PROOF"
  });
};
