import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
const server = http.createServer(app);

/**
 * ---- CONFIG ----
 * Railway injects PORT automatically
 * PUBLIC_URL must be your Railway domain
 */
const PORT = process.env.PORT || 8080;
const PUBLIC_URL =
  process.env.PUBLIC_URL ||
  "twilio-media-server-production.up.railway.app";

/**
 * ---- HEALTH CHECK ----
 */
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

/**
 * ---- TWILIO VOICE WEBHOOK (TwiML) ----
 * This is what Twilio hits FIRST when a call comes in
 */
app.post("/twilio/voice", (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${PUBLIC_URL}/media" />
  </Connect>
</Response>`;

  res.set("Content-Type", "text/xml");
  res.status(200).send(twiml);
});

/**
 * ---- WEBSOCKET: TWILIO MEDIA STREAM ----
 */
const wss = new WebSocketServer({
  server,
  path: "/media",
});

wss.on("connection", (ws) => {
  console.log("Twilio media stream connected");

  ws.on("message", (msg) => {
    // Twilio sends JSON frames
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === "start") {
        console.log("Stream started", data.start?.streamSid);
      }

      if (data.event === "media") {
        // Audio payload is base64 μ-law
        console.log("Audio frame received", data.media.payload.length);
      }

      if (data.event === "stop") {
        console.log("Stream stopped");
      }
    } catch (err) {
      console.error("Invalid WS message", err);
    }
  });

  ws.on("close", () => {
    console.log("Twilio media stream disconnected");
  });
});

/**
 * ---- START SERVER ----
 */
server.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
