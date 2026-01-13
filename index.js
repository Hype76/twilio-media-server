import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
const server = http.createServer(app);

/**
 * 1️⃣ HEALTH CHECK
 */
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

/**
 * 2️⃣ TWILIO VOICE WEBHOOK (RETURNS TWIML)
 * THIS is what your Twilio phone number must point to
 */
app.post("/twilio/voice", (req, res) => {
  const host = req.headers.host;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media" />
  </Connect>
</Response>`;

  res.type("text/xml");
  res.send(twiml);
});

/**
 * 3️⃣ WEBSOCKET MEDIA STREAM
 */
const wss = new WebSocketServer({
  server,
  path: "/media",
});

wss.on("connection", (ws) => {
  console.log("Twilio media stream connected");

  ws.on("message", (msg) => {
    console.log("Audio frame received", msg.length);
  });

  ws.on("close", () => {
    console.log("Twilio media stream disconnected");
  });

  ws.on("error", (err) => {
    console.error("WebSocket error", err);
  });
});

/**
 * 4️⃣ START SERVER
 */
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
