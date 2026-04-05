const express = require("express");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const fetch = require("node-fetch");
const fs = require("fs");

const app = express();
app.use(express.json());

const API_SECRET = process.env.API_SECRET_KEY;
const BASE44_WEBHOOK_URL = process.env.BASE44_WEBHOOK_URL;
const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";

const sessions = {};

// ── Auth middleware ───────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const auth = req.headers.authorization?.replace("Bearer ", "");
  if (auth !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
});

// ── Helper: webhook ל-BASE44 ─────────────────────────────────────
async function notifyBase44(url, payload) {
  const target = url || BASE44_WEBHOOK_URL;
  if (!target) return console.error("[webhook] no URL");
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-railway-secret": API_SECRET,
      },
      body: JSON.stringify({ ...payload, timestamp: new Date().toISOString() }),
    });
    console.log(`[webhook] ${payload.event || payload.status} → ${res.status}`);
  } catch (e) {
    console.error("[webhook] failed:", e.message);
  }
}

// ── Helper: מחק lock file ─────────────────────────────────────────
function clearLock(sessionId) {
  const paths = [
    `/app/.wwebjs_auth/session-${sessionId}/.wwebjs_auth.lock`,
    `/app/.wwebjs_auth/session-${sessionId}/SingletonLock`,
    `/app/.wwebjs_auth/session-${sessionId}/SingletonCookie`,
  ];
  paths.forEach(p => {
    try { fs.unlinkSync(p); console.log(`[${sessionId}] cleared: ${p}`); } catch (_) {}
  });
}

// ── Helper: אתחל client ───────────────────────────────────────────
async function initClient(sessionId, callbackUrl, attempt = 1) {
  clearLock(sessionId);

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: sessionId,
      dataPath: "/app/.wwebjs_auth",
    }),
    puppeteer: {
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
      ],
    },
  });

  sessions[sessionId] = { client, status: "initializing", qr: null, phone: null, callbackUrl };

  client.on("qr", async (qr) => {
    const qrDataUrl = await qrcode.toDataURL(qr);
    sessions[sessionId].qr = qrDataUrl;
    sessions[sessionId].status = "pending_qr";
    console.log(`[${sessionId}] QR ready`);
    await notifyBase44(callbackUrl, {
      event: "qr_updated",
      sessionId,
      data: { qr: qrDataUrl },
    });
  });

  client.on("ready", async () => {
    const phone = client.info?.wid?.user || null;
    sessions[sessionId].status = "connected";
    sessions[sessionId].qr = null;
    sessions[sessionId].phone = phone;
    sessions[sessionId].connectedAt = new Date().toISOString();
    console.log(`[${sessionId}] Connected — phone: ${phone}`);
    await notifyBase44(callbackUrl, {
      event: "session_connected",
      sessionId,
      data: { phone, connectedAt: sessions[sessionId].connectedAt },
    });
  });

  client.on("disconnected", async (reason) => {
    console.log(`[${sessionId}] Disconnected:`, reason);
    const s = sessions[sessionId];
    await notifyBase44(s?.callbackUrl, {
      event: "session_disconnected",
      sessionId,
      data: { reason },
    });
    try { await client.destroy(); } catch (_) {}
    delete sessions[sessionId];
  });

  client.on("message_ack", async (msg, ack) => {
    const statusMap = { 2: "sent", 3: "delivered", 4: "read" };
    const status = statusMap[ack];
    if (!status) return;
    const s = sessions[sessionId];
    if (!s) return;
    const msgId = msg.id?._serialized || msg.id?.id || null;
    console.log(`[${sessionId}] ACK ${status} — ${msgId}`);
    await notifyBase44(s.callbackUrl, {
      status,
      messageId: msgId,
      data: { timestamp: new Date().toISOString() },
    });
  });

  client.initialize().catch(async (err) => {
    console.error(`[${sessionId}] initialize error (attempt ${attempt}):`, err.message);

    // אם browser תפוס — המתן ונסה שוב פעם אחת
    if (err.message.includes("already running") && attempt === 1) {
      console.log(`[${sessionId}] retrying in 4s...`);
      try { await client.destroy(); } catch (_) {}
      delete sessions[sessionId];
      await new Promise(r => setTimeout(r, 4000));
      return initClient(sessionId, callbackUrl, 2);
    }

    if (sessions[sessionId]) sessions[sessionId].status = "failed";
    await notifyBase44(callbackUrl, {
      event: "session_failed",
      sessionId,
      data: { error: err.message },
    });
  });
}

// ── POST /session/create ─────────────────────────────────────────
app.post("/session/create", async (req, res) => {
  const { sessionId, webhookUrl } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  if (sessions[sessionId]) {
    const s = sessions[sessionId];
    return res.json({ ok: true, existing: true, status: s.status, qr: s.qr, phone: s.phone });
  }

  const callbackUrl = webhookUrl || BASE44_WEBHOOK_URL;
  await initClient(sessionId, callbackUrl);
  res.json({ ok: true, sessionId, status: "initializing" });
});

// ── GET /session/status/:sessionId ───────────────────────────────
app.get("/session/status/:sessionId", (req, res) => {
  const s = sessions[req.params.sessionId];
  if (!s) return res.status(404).json({ error: "Not found", status: "not_found" });
  res.json({
    status: s.status,
    qr: s.qr,
    phone: s.phone || null,
    connectedAt: s.connectedAt || null,
  });
});

// ── DELETE /session/delete/:sessionId ────────────────────────────
app.delete("/session/delete/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const s = sessions[sessionId];
  if (!s) return res.json({ ok: true, message: "Already gone" });
  try { await s.client.destroy(); } catch (e) {
    console.error(`[${sessionId}] destroy error:`, e.message);
  }
  delete sessions[sessionId];
  clearLock(sessionId);
  console.log(`[${sessionId}] Deleted`);
  res.json({ ok: true });
});

// ── POST /message/send ───────────────────────────────────────────
app.post("/message/send", async (req, res) => {
  const { sessionId, to, message, messageId, webhookUrl, mediaUrl } = req.body;
  const s = sessions[sessionId];

  if (!s || s.status !== "connected") {
    return res.status(400).json({
      error: "Not connected",
      sessionStatus: s?.status || "not_found",
    });
  }

  const callbackUrl = webhookUrl || s.callbackUrl || BASE44_WEBHOOK_URL;

  try {
    const digits = to.replace(/\D/g, "");
    const chatId = `${digits}@c.us`;

    if (mediaUrl) {
      const media = await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true });
      await s.client.sendMessage(chatId, media, { caption: message });
    } else {
      await s.client.sendMessage(chatId, message);
    }

    await notifyBase44(callbackUrl, {
      status: "sent",
      messageId,
      data: { to: digits },
    });

    res.json({ ok: true, queued: true });
  } catch (e) {
    console.error(`[${sessionId}] send error:`, e.message);
    await notifyBase44(callbackUrl, {
      status: "failed",
      messageId,
      data: { error: e.message },
    });
    res.status(500).json({ error: e.message });
  }
});

// ── GET /health ──────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    chromium: CHROMIUM_PATH,
    activeSessions: Object.keys(sessions).length,
    sessions: Object.entries(sessions).map(([id, s]) => ({
      id, status: s.status, phone: s.phone || null,
    })),
  });
});

app.listen(process.env.PORT || 8080, "0.0.0.0", () =>
  console.log("WA Server running on port", process.env.PORT || 8080)
);
