// server.js (live-tauglich)

import { Readable } from "stream";
import { pipeline } from "stream";
import { promisify } from "util";
const pipe = promisify(pipeline);

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import jwt from "jsonwebtoken";
import path from "path";
import { fileURLToPath } from "url";

// ===== Basis-Konfiguration =====
const PORT = process.env.PORT || 3001;

// Öffentliche Basis-URL (für Download-Links)
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://localhost:${PORT}`;

// Quelle der großen ZIP-Datei (empfohlen: GitHub Release Asset URL)
const DOWNLOAD_SOURCE_URL = process.env.DOWNLOAD_SOURCE_URL || null;

// Produkt & Preis
const EXPECTED_AMOUNT   = process.env.PRODUCT_AMOUNT   || "5.00";
const EXPECTED_CURRENCY = process.env.PRODUCT_CURRENCY || "EUR";

// Lokale Datei (nur als Fallback, z. B. bei lokalem Test)
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const FILE_PATH  = process.env.FILE_PATH || path.join(__dirname, "files", "Email_Summarizer.zip");

// JWT für Einmal-Links
const JWT_SECRET  = process.env.JWT_SECRET  || "change_me_to_a_long_random_secret";
const JWT_EXPIRES = process.env.JWT_EXPIRES || "1h"; // Gültigkeit des Download-Links
const usedTokens = new Set();

// ===== PayPal-Konfiguration =====
// PAYPAL_ENV: "live" oder "sandbox" (default: live)
const PAYPAL_ENV = (process.env.PAYPAL_ENV || "live").toLowerCase();
const PAYPAL_API_BASE =
  PAYPAL_ENV === "sandbox"
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com";

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "";
const PAYPAL_SECRET    = process.env.PAYPAL_SECRET    || "";

const PP_OAUTH_URL  = `${PAYPAL_API_BASE}/v1/oauth2/token`;
const PP_ORDERS_URL = `${PAYPAL_API_BASE}/v2/checkout/orders/`;

// ===== App-Setup =====
const app = express();

// Statische Dateien (z. B. /webseite.html, /thanks.html)
app.use(express.static(__dirname));

// CORS (für lokale Tests offen; in Produktion Domain einschränken!)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // <-- später auf deine Domain setzen
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(bodyParser.json());

// ===== Hilfsfunktionen PayPal =====
async function getPayPalAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString("base64");
  const resp = await fetch(PP_OAUTH_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error("PayPal OAuth fehlgeschlagen: " + t);
  }
  const data = await resp.json();
  return data.access_token;
}

async function fetchOrder(orderID, accessToken) {
  const resp = await fetch(PP_ORDERS_URL + orderID, {
    headers: { "Authorization": `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error("Order-Abfrage fehlgeschlagen: " + t);
  }
  return resp.json();
}

// ===== API: Zahlung verifizieren & Download-Link ausstellen =====
app.post("/verify", async (req, res) => {
  try {
    const { orderID, expectedAmount, expectedCurrency, product = "email_summarizer" } = req.body || {};
    if (!orderID) return res.status(400).json({ ok: false, message: "orderID fehlt" });

    // 1) PayPal prüfen
    const accessToken = await getPayPalAccessToken();
    const order = await fetchOrder(orderID, accessToken);

    const status   = order?.status;
    const amount   = order?.purchase_units?.[0]?.amount?.value;
    const currency = order?.purchase_units?.[0]?.amount?.currency_code;

    if (status !== "COMPLETED") {
      return res.status(400).json({ ok: false, message: `Zahlung nicht abgeschlossen: ${status}` });
    }

    const expAmount   = expectedAmount   || EXPECTED_AMOUNT;
    const expCurrency = expectedCurrency || EXPECTED_CURRENCY;

    if (amount !== expAmount || currency !== expCurrency) {
      return res.status(400).json({
        ok: false,
        message: `Betrag/Currency ungleich (erwartet ${expAmount} ${expCurrency}, erhalten ${amount} ${currency})`,
      });
    }

    // 2) Kurzlebigen Einmal-Token erzeugen
    const token = jwt.sign({ sub: product, orderID }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    const downloadUrl = `${PUBLIC_BASE_URL}/download?token=${encodeURIComponent(token)}`;

    const { exp } = jwt.decode(token);
    const expiresAt = exp ? new Date(exp * 1000).toISOString() : null;

    return res.json({ ok: true, downloadUrl, expiresAt });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, message: err.message || "Serverfehler" });
  }
});

// ===== API: Einmaliger Download =====
app.get("/download", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send("Token fehlt");

    if (usedTokens.has(token)) {
      return res.status(410).send("Dieser Link wurde bereits verwendet.");
    }

    // Token prüfen
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).send("Ungültiger oder abgelaufener Token.");
    }

    // Einmal-Verbrauch markieren
    usedTokens.add(token);

    // --- Bevorzugt: von externer Quelle streamen (GitHub Release) ---
    if (DOWNLOAD_SOURCE_URL) {
      try {
        const upstream = await fetch(DOWNLOAD_SOURCE_URL, {
          headers: { "User-Agent": "lumi-downloader" },
        });

        if (!upstream.ok || !upstream.body) {
          usedTokens.delete(token);
          return res.status(502).send("Quelle nicht erreichbar.");
        }

        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", 'attachment; filename="Email_Summarizer.zip"');

        await pipe(Readable.fromWeb(upstream.body), res);
        return;
      } catch (err) {
        console.error("Stream-Fehler:", err);
        usedTokens.delete(token);
        if (!res.headersSent) res.status(500).send("Fehler beim Download.");
        return;
      }
    }

    // --- Fallback: lokale Datei (nur lokal sinnvoll) ---
    res.download(FILE_PATH, "Email_Summarizer.zip", (err) => {
      if (err) {
        console.error("Download-Fehler:", err);
        usedTokens.delete(token);
        if (!res.headersSent) res.status(500).send("Fehler beim Download.");
      }
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).send("Serverfehler");
  }
});

// ===== Start =====
app.listen(PORT, () => {
  console.log(`Payments backend listening on ${PUBLIC_BASE_URL} (port ${PORT})`);
  console.log(`PayPal env: ${PAYPAL_ENV} / API: ${PAYPAL_API_BASE}`);
});



