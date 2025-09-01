// server.js (Live-tauglich)
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import jwt from "jsonwebtoken";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ======= Konfiguration =======
const PORT = process.env.PORT || 3001;

// Öffentliche Basis-URL (für Download-Links)
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL // z.B. https://dein-name.onrender.com
  || (process.env.RENDER_EXTERNAL_URL) // Render setzt das automatisch
  || `http://localhost:${PORT}`;

// Produkt
const EXPECTED_AMOUNT   = process.env.PRODUCT_AMOUNT   || "5.00";
const EXPECTED_CURRENCY = process.env.PRODUCT_CURRENCY || "EUR";

// Download-Datei
const FILE_PATH = process.env.FILE_PATH
  || path.join(__dirname, "files", "Email_Summarizer.zip");

// Token (JWT)
const JWT_SECRET  = process.env.JWT_SECRET || "change_me_to_a_long_random_secret";
const JWT_EXPIRES = process.env.JWT_EXPIRES || "1h";

// Einmal-Verbrauch
const usedTokens = new Set();

// ======= App-Setup =======
const app = express();

// Statische Dateien (damit /webseite.html, /thanks.html usw. öffentlich sind)
app.use(express.static(__dirname));

// CORS minimal (für lokale Tests ok; im Live später auf deine Domain einschränken)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(bodyParser.json());

// ======= Download-Link ausstellen (wird nach erfolgreicher Zahlung aufgerufen) =======
app.post("/send-link", (req, res) => {
  try {
    const { product = "email_summarizer" } = req.body || {};

    // Kurzlebigen Download-Token erzeugen
    const token = jwt.sign({ sub: product }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    const downloadUrl = `${PUBLIC_BASE_URL}/download?token=${encodeURIComponent(token)}`;

    const { exp } = jwt.decode(token);
    const expiresAt = exp ? new Date(exp * 1000).toISOString() : null;

    res.json({ ok: true, downloadUrl, expiresAt });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: "Fehler beim Ausstellen des Links" });
  }
});

// ======= Einmaliger Download =======
app.get("/download", (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send("Token fehlt");

    if (usedTokens.has(token)) {
      return res.status(410).send("Dieser Link wurde bereits verwendet.");
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).send("Ungültiger oder abgelaufener Token.");
    }

    usedTokens.add(token);
    res.download(FILE_PATH, "Email_Summarizer.zip", (err) => {
      if (err) {
        console.error("Download-Fehler:", err);
        usedTokens.delete(token); // bei Fehler wieder freigeben
        if (!res.headersSent) res.status(500).send("Fehler beim Download.");
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Serverfehler");
  }
});

// ======= Start =======
app.listen(PORT, () => {
  console.log(`Live listening on ${PUBLIC_BASE_URL} (port ${PORT})`);
});



