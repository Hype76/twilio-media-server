import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/**
 * LOG EVERYTHING (HTTP)
 */
app.use((req, _res, next) => {
  const now = new Date().toISOString();
  console.log(`[HTTP] ${now} ${req.method} ${req.originalUrl}`);
  console.log(`[HTTP] headers:`, {
    host: req.get("host"),
    "x-forwarded-proto": req.get("x-forwarded-proto"),
    "user-agent": req.get("user-agent"),
  });
  next();
});

const server = http.createServer(app);

/**
 * HEALTH
 */
app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

/**
 * STREAM STATUS CALLBACK
 */
app.post("/twilio/stream-status", (req, res) => {
  console.log("[STREAM-STATUS] body:", req.body);
  res.status(200).send("ok");
});

/**
 * CALL STATUS CALLBACK
 */
app.post("/twilio/call-status", (req, res) => {
  console.log("[CALL-STATUS] body:", req.body);
  res.status(200).send("ok");
});

/**
 * BUILD TWIML
 */
function buildTwiml(req) {
  const host = req.get("host");
  const proto = (req.get("x-forwarded-proto") || "https").toLowerCase();
  const wsProto = proto === "https" ? "wss" : "ws";

  const streamUrl = `${wsProto}://${host}/media`;
  const statusCb = `${proto}://${host}/twilio/stream-status`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream
      url="${streamUrl}"
      statusCallback="${statusCb}"
      statusCallbackMethod="POST" />
  </Connect>
</Response>`;
}

/**
 * TWILIO VOICE WEBHOOK
 */
app.post("/twilio/voice", (req, res) => {
  try {
    const twiml = buildTwiml(req);
    console.log("[TwiML] returning:", twiml);
    res.type("text/xml").status(200).send(twiml);
  } catch (err) {
    console.error("[/twilio/voice] failed:", err?.message || err);
    res
      .status(200)
      .type("text/xml")
      .send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  }
});

app.get("/twilio/voice", (req, res) => {
  try {
    const twiml = buildTwiml(req);
    res.type("text/xml").status(200).send(twiml);
  } catch {
    res.status(500).send("error");
  }
});

/**
 * BLOCK HTTP ACCESS TO /media
 */
app.get("/media", (_req, res) => {
  res.status(426).send("WebSocket required");
});

/**
 * WEBSOCKET MEDIA STREAM
 */
const wss = new WebSocketServer({
  server,
  path: "/media",
});

wss.on("connection", (ws, req) => {
  console.log("Twilio media stream connected");
  console.log("[WS] headers:", {
    host: req.headers.host,
    origin: req.headers.origin,
    "user-agent": req.headers["user-agent"],
    "x-forwarded-for": req.headers["x-forwarded-for"],
  });

  let streamSid = null;
  let callSid = null;

  const pingInterval = setInterval(() => {
    try {
      ws.ping();
    } catch {}
  }, 15000);

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      console.log("[WS] non-json message");
      return;
    }

    if (data.event === "start") {
      streamSid = data.start?.streamSid || null;
      callSid = data.start?.callSid || null;
      console.log("Stream started:", { streamSid, callSid });
      return;
    }

    if (data.event === "media") {
      if (!data.media?.payload) return;
      return;
    }

    if (data.event === "stop") {
      console.log("Stream stopped:", { streamSid, callSid });
      return;
    }

    console.log("[WS] event:", data.event);
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    console.log("Twilio disconnected:", { streamSid, callSid });
  });

  ws.on("error", (err) => {
    console.error("WS error:", err?.message || err);
  });
});

/**
 * START SERVER
 */
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log("Listening on port", PORT);
});
