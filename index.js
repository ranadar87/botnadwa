const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");

const app = express();
app.use(express.json());

const API_SECRET = process.env.API_SECRET_KEY;
const BASE44_WEBHOOK_URL = process.env.BASE44_WEBHOOK_URL; // הוסף ב-Railway Variables
const sessions = {};

// ── Auth middleware ───────────────────────────────────────────────
app.use((req, res, next) => {
  const auth = req.headers.authorization?.replace("Bearer ", "");
  if (auth !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
});

// ── Helper: שלח webhook ל-BASE44 עם auth header ──────────────────
async function notifyBase44(url, payload) {
  const target = url || BASE44_WEBHOOK_URL;
  if (!target) return;
  try {
    await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-railway-secret": API_SECRET,   // ← BASE44 מאמת עם זה
      },
      body: JSON.stringify({ ...payload, timestamp: new Date().toISOString() }),
    });
  } catch (e) {
    console.error("[webhook] failed:", e.message);
  }
}

// ── POST /session/create ─────────────────────────────────────────
app.post("/session/create", async (req, res) => {
  const { sessionId, webhookUrl } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  // אם session קיימת — החזר סטטוס נוכחי
  if (sessions[sessionId]) {
    const s = sessions[sessionId];
    return res.json({ ok: true, existing: true, status: s.status, qr: s.qr, phone: s.phone });
  }

  const callbackUrl = webhookUrl || BASE44_WEBHOOK_URL;

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId }),
    puppeteer: { args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"] }
  });

  sessions[sessionId] = { client, status: "initializing", qr: null, phone: null, callbackUrl };

  // QR מוכן → שלח -BASE44 מיידית
  client.on("qr", async (qr) => {
    const qrDataUrl = await qrcode.toDataURL(qr);
    sessions[sessionId].qr = qrDataUrl;
    sessions[sessionId].status = "pending_qr";
    console.log(`[${sessionId}] QR ready`);

    // FIX 1: push QR ל-BASE44 — UI יתעדכן מיד בלי לחכות לפולינג
    await notifyBase44(callbackUrl, {
      event: "qr_updated",
      sessionId,
      qr: qrDataUrl,
    });
  });

  // חובר! → שמור phone + הודע ל-BASE44 מיידית
  client.on("ready", async () => {
    const phone = client.info?.wid?.user || null;
    sessions[sessionId].status = "connected";
    sessions[sessionId].qr = null;
    sessions[sessionId].phone = phone;
    sessions[sessionId].connectedAt = new Date().toISOString();
    console.log(`[${sessionId}] Connected, phone: ${phone}`);

    // FIX 1: push "connected" ל-BASE44 — זה פותר את עיכוב הUI לאחר סריקה
    await notifyBase44(callbackUrl, {
      event: "session_connected",
      sessionId,
      status: "connected",
      phone,
      connectedAt: sessions[sessionId].connectedAt,
    });
  });

  // ניתוק → נקה ועדכן
  client.on("disconnected", async (reason) => {
    console.log(`[${sessionId}] Disconnected:`, reason);
    const s = sessions[sessionId];
    await notifyBase44(s?.callbackUrl, {
      event: "session_disconnected",
      sessionId,
      status: "disconnected",
      reason,
    });
    try { await client.destroy(); } catch (_) {}
    delete sessions[sessionId];
  });

  // FIX 2: ACK handler → delivered / read webhooks
  client.on("message_ack", async (msg, ack) => {
    // ack: 1=clock(pending), 2=sent(checkmark), 3=delivered, 4=read(blue)
    const statusMap = { 2: "sent", 3: "delivered", 4: "read" };
    const status = statusMap[ack];
    if (!status) return;

    const s = sessions[sessionId];
    const msgId = msg.id?._serialized || msg.id?.id || null;
    console.log(`[${sessionId}] ACK ${status} for ${msgId}`);

    await notifyBase44(s?.callbackUrl, {
      // FIX 3: שלח "status" לא "event" — זה מה שBASE44 מצפה
      status,
      messageId: msgId,
    });
  });

  client.initialize();
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
// FIX 4: endpoint חסר — נדרש לכפתור ה"נתק" ב-BASE44
app.delete("/session/delete/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const s = sessions[sessionId];
  if (!s) return res.json({ ok: true, message: "Already gone" });

  try { await s.client.destroy(); } catch (e) {
    console.error(`[${sessionId}] destroy error:`, e.message);
  }
  delete sessions[sessionId];
  console.log(`[${sessionId}] Deleted by request`);
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

  try {
    // נקה מספר טלפון — הסר הכל חוץ מספרות
    const digits = to.replace(/\D/g, "");
    const chatId = `${digits}@c.us`;

    await s.client.sendMessage(chatId, message);

    // FIX 3: שלח status:"sent" ולא event:"sent"
    const callbackUrl = webhookUrl || s.callbackUrl || BASE44_WEBHOOK_URL;
    await notifyBase44(callbackUrl, {
      status: "sent",
      messageId,
      to: digits,
    });

    res.json({ ok: true, queued: true });
  } catch (e) {
    console.error(`[${sessionId}] send error:`, e.message);
    const callbackUrl = webhookUrl || s.callbackUrl || BASE44_WEBHOOK_URL;
    await notifyBase44(callbackUrl, {
      status: "failed",
      messageId,
      error: e.message,
    });
    res.status(500).json({ error: e.message });
  }
});

// ── GET /health ──────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    activeSessions: Object.keys(sessions).length,
    sessions: Object.entries(sessions).map(([id, s]) => ({
      id, status: s.status, phone: s.phone || null
    })),
  });
});

app.listen(process.env.PORT || 8002, () =>
  console.log("WA Server running on port", process.env.PORT || 8002)
);
