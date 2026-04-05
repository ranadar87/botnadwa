const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");

const app = express();
app.use(express.json());

const API_SECRET = process.env.API_SECRET_KEY;
const sessions = {};

// Auth middleware
app.use((req, res, next) => {
  const auth = req.headers.authorization?.replace("Bearer ", "");
  if (auth !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
});

// Create session
app.post("/session/create", async (req, res) => {
  const { sessionId } = req.body;
  if (sessions[sessionId]) return res.json({ ok: true, existing: true });

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId }),
    puppeteer: { args: ["--no-sandbox", "--disable-setuid-sandbox"] }
  });

  sessions[sessionId] = { client, status: "pending_qr", qr: null };

  client.on("qr", async (qr) => {
    sessions[sessionId].qr = await qrcode.toDataURL(qr);
    sessions[sessionId].status = "pending_qr";
  });

  client.on("ready", () => {
    sessions[sessionId].status = "connected";
    sessions[sessionId].qr = null;
  });

  client.on("disconnected", () => {
    sessions[sessionId].status = "disconnected";
    delete sessions[sessionId];
  });

  client.initialize();
  res.json({ ok: true, sessionId });
});

// Status
app.get("/session/status/:sessionId", (req, res) => {
  const s = sessions[req.params.sessionId];
  if (!s) return res.status(404).json({ error: "Not found" });
  const phone = s.client?.info?.wid?.user || null;
  res.json({ status: s.status, qr: s.qr, phone });
});

// Delete session
app.delete("/session/delete/:sessionId", async (req, res) => {
  const s = sessions[req.params.sessionId];
  if (s?.client) {
    await s.client.logout().catch(() => {});
  }
  delete sessions[req.params.sessionId];
  res.json({ ok: true });
});

// Send message
app.post("/message/send", async (req, res) => {
  const { sessionId, to, message, messageId } = req.body;
  const webhookUrl = req.headers["x-webhook-url"];
  const webhookSecret = req.headers["x-webhook-secret"];
  const s = sessions[sessionId];
  
  if (!s || s.status !== "connected") return res.status(400).json({ error: "Not connected" });

  const phone = to.replace(/\D/g, "") + "@c.us";
  await s.client.sendMessage(phone, message);

  if (webhookUrl && webhookSecret) {
    fetch(webhookUrl, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "X-Railway-Secret": webhookSecret,
      },
      body: JSON.stringify({ 
        messageId, 
        status: "sent",
        timestamp: new Date().toISOString(),
      }),
    }).catch(() => {});
  }

  res.json({ ok: true, queued: true });
});

app.listen(process.env.PORT || 8002, () => console.log("WA Server running"));
