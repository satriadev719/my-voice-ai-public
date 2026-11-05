require("dotenv").config();

const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const crypto = require("crypto");
const path = require("path");

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT || 3000);
const MAX_AUDIO_MB = Math.max(1, Number(process.env.MAX_AUDIO_MB || 20));
const GENERATION_LIMIT = Math.max(1, Number(process.env.DAILY_GENERATION_LIMIT || 10));
const CLONE_LIMIT = Math.max(1, Number(process.env.DAILY_CLONE_LIMIT || 1));

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!process.env.ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY is required");
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  throw new Error("SESSION_SECRET must contain at least 32 characters");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: process.env.DATABASE_URL.includes("sslmode=require") ? { rejectUnauthorized: true } : undefined
});

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      mediaSrc: ["'self'", "blob:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));

app.use(session({
  store: new PgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true
  }),
  name: "myvoice.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: "draft-7", legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      voice_id TEXT UNIQUE,
      voice_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS usage_daily (
      user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK (action IN ('clone','generate')),
      usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, action, usage_date)
    );
  `);
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Silakan login terlebih dahulu." });
  next();
}
function issueCsrf(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  return req.session.csrfToken;
}
function csrfProtection(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const supplied = req.get("x-csrf-token");
  if (!supplied || !req.session.csrfToken || supplied !== req.session.csrfToken) {
    return res.status(403).json({ error: "Sesi keamanan tidak valid. Muat ulang halaman." });
  }
  next();
}
app.use(csrfProtection);

async function reserveUsage(userId, action, limit) {
  const result = await pool.query(
    `INSERT INTO usage_daily (user_id, action, usage_date, count)
     VALUES ($1, $2, CURRENT_DATE, 1)
     ON CONFLICT (user_id, action, usage_date)
     DO UPDATE SET count = usage_daily.count + 1
     WHERE usage_daily.count < $3
     RETURNING count`,
    [userId, action, limit]
  );
  return result.rowCount ? result.rows[0].count : null;
}
async function usageFor(userId) {
  const result = await pool.query(
    `SELECT action, count FROM usage_daily WHERE user_id=$1 AND usage_date=CURRENT_DATE`,
    [userId]
  );
  const values = Object.fromEntries(result.rows.map(r => [r.action, Number(r.count)]));
  return {
    cloneUsed: values.clone || 0,
    cloneLimit: CLONE_LIMIT,
    generationUsed: values.generate || 0,
    generationLimit: GENERATION_LIMIT
  };
}
async function elevenLabs(pathname, options = {}) {
  const response = await fetch(`https://api.elevenlabs.io${pathname}`, {
    ...options,
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, ...(options.headers || {}) }
  });
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    const err = new Error(`ElevenLabs menolak permintaan (${response.status}). ${message.slice(0, 500)}`);
    err.status = response.status === 429 ? 429 : 502;
    throw err;
  }
  return response;
}

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: MAX_AUDIO_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const allowed = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/mp4", "audio/x-m4a", "audio/webm", "audio/ogg"];
    if (!allowed.includes(file.mimetype)) return cb(new Error("Format audio tidak didukung. Gunakan MP3, WAV, M4A, WEBM, atau OGG."));
    cb(null, true);
  }
});

app.get("/health", (req, res) => res.json({ ok: true, service: "my-voice-ai-public-v2" }));
app.get("/api/csrf", (req, res) => res.json({ csrfToken: issueCsrf(req) }));

app.post("/api/register", authLimiter, asyncRoute(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: "Masukkan alamat email yang valid." });
  }
  if (password.length < 10 || password.length > 128) {
    return res.status(400).json({ error: "Password harus 10–128 karakter." });
  }
  const hash = await bcrypt.hash(password, 12);
  try {
    const result = await pool.query(
      "INSERT INTO app_users (email,password_hash) VALUES ($1,$2) RETURNING id,email",
      [email, hash]
    );
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: "Tidak dapat membuat sesi." });
      req.session.userId = String(result.rows[0].id);
      req.session.email = result.rows[0].email;
      issueCsrf(req);
      req.session.save(saveErr => {
        if (saveErr) return res.status(500).json({ error: "Tidak dapat menyimpan sesi." });
        res.status(201).json({ user: { email: result.rows[0].email }, csrfToken: req.session.csrfToken });
      });
    });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Email sudah terdaftar. Silakan login." });
    throw e;
  }
}));

app.post("/api/login", authLimiter, asyncRoute(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const result = await pool.query("SELECT id,email,password_hash FROM app_users WHERE email=$1", [email]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Email atau password salah." });
  }
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "Tidak dapat membuat sesi." });
    req.session.userId = String(user.id);
    req.session.email = user.email;
    issueCsrf(req);
    req.session.save(saveErr => {
      if (saveErr) return res.status(500).json({ error: "Tidak dapat menyimpan sesi." });
      res.json({ user: { email: user.email }, csrfToken: req.session.csrfToken });
    });
  });
}));

app.post("/api/logout", requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("myvoice.sid", { httpOnly: true, secure: isProduction, sameSite: "lax" });
    res.json({ ok: true });
  });
});

app.get("/api/me", requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query("SELECT email,voice_id,voice_name FROM app_users WHERE id=$1", [req.session.userId]);
  if (!result.rowCount) return res.status(401).json({ error: "Akun tidak ditemukan." });
  res.json({
    user: { email: result.rows[0].email, hasVoice: Boolean(result.rows[0].voice_id), voiceName: result.rows[0].voice_name },
    usage: await usageFor(req.session.userId),
    csrfToken: issueCsrf(req)
  });
}));

app.post("/api/voice/clone", requireAuth, apiLimiter, upload.single("audio"), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Pilih file audio terlebih dahulu." });
  if (req.body.consent !== "true") return res.status(400).json({ error: "Konfirmasi bahwa suara ini milikmu atau kamu memiliki izin penggunaannya." });
  const name = String(req.body.name || "Suara Saya").trim().slice(0, 80);
  const existing = await pool.query("SELECT voice_id FROM app_users WHERE id=$1", [req.session.userId]);
  if (!existing.rowCount) return res.status(401).json({ error: "Akun tidak ditemukan." });
  if (existing.rows[0].voice_id) return res.status(409).json({ error: "Akun ini sudah memiliki voice clone. Hubungi admin jika perlu menggantinya." });
  const used = await reserveUsage(req.session.userId, "clone", CLONE_LIMIT);
  if (!used) return res.status(429).json({ error: `Batas clone harian tercapai (${CLONE_LIMIT}/hari).` });

  const form = new FormData();
  form.append("name", name);
  form.append("description", "Voice clone milik pengguna MY VOICE AI");
  form.append("files", new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname || "voice-sample");
  const upstream = await elevenLabs("/v1/voices/add", { method: "POST", body: form });
  const data = await upstream.json();
  if (!data.voice_id) throw new Error("ElevenLabs tidak mengembalikan Voice ID.");
  await pool.query("UPDATE app_users SET voice_id=$1,voice_name=$2 WHERE id=$3", [data.voice_id, name, req.session.userId]);
  res.json({ ok: true, voiceName: name, usage: await usageFor(req.session.userId) });
}));

app.post("/api/voice/generate", requireAuth, apiLimiter, asyncRoute(async (req, res) => {
  const text = String(req.body.text || "").trim();
  if (!text) return res.status(400).json({ error: "Masukkan teks yang ingin diubah menjadi suara." });
  if (text.length > 3000) return res.status(400).json({ error: "Teks maksimal 3.000 karakter." });
  const user = await pool.query("SELECT voice_id FROM app_users WHERE id=$1", [req.session.userId]);
  const voiceId = user.rows[0]?.voice_id;
  if (!voiceId) return res.status(400).json({ error: "Buat voice clone terlebih dahulu." });
  const used = await reserveUsage(req.session.userId, "generate", GENERATION_LIMIT);
  if (!used) return res.status(429).json({ error: `Batas generasi harian tercapai (${GENERATION_LIMIT}/hari).` });

  const response = await elevenLabs(`/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true }
    })
  });
  const audio = Buffer.from(await response.arrayBuffer());
  res.set({
    "Content-Type": "audio/mpeg",
    "Content-Disposition": 'attachment; filename="my-voice-ai.mp3"',
    "Content-Length": audio.length,
    "Cache-Control": "no-store"
  });
  res.send(audio);
}));

app.use(express.static(path.join(__dirname, "public"), { etag: true, maxAge: isProduction ? "1h" : 0 }));
app.use((err, req, res, next) => {
  console.error(err.message);
  if (err instanceof multer.MulterError) {
    const message = err.code === "LIMIT_FILE_SIZE" ? `Ukuran audio maksimal ${MAX_AUDIO_MB} MB.` : "Upload audio gagal.";
    return res.status(400).json({ error: message });
  }
  if (err.message?.includes("Format audio")) return res.status(400).json({ error: err.message });
  const status = err.status || 500;
  res.status(status).json({ error: status === 500 ? "Terjadi kesalahan server. Coba lagi nanti." : err.message });
});

initDb().then(() => {
  app.listen(PORT, "0.0.0.0", () => console.log(`MY VOICE AI listening on ${PORT}`));
}).catch(err => {
  console.error("Database initialization failed:", err);
  process.exit(1);
});
