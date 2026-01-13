import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
const server = http.createServer(app);

/**
 * Twilio Media Stream (WSS)
 */
const wss = new WebSocketServer({
  server,
  path: "/media",
});

wss.on("connection", (ws) => {
  console.log("Twilio connected");

  ws.on("message", (msg) => {
    console.log("audio frame");
  });

  ws.on("close", () => {
    console.log("Twilio disconnected");
  });
});

/**
 * Voice webhook (HTTPS -> returns TwiML)
 * THIS is what Twilio calls first
 */
app.post(
  "/voice",
  express.urlencoded({ extended: false }),
  (req, res) => {
    res.type("text/xml");
    res.send(`
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media" />
  </Connect>
</Response>
    `.trim());
  }
);

/**
 * Health check
 */
app.get("/health", (req, res) => {
  res.send("ok");
});

import twilio from "twilio";

app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.start().stream({
    url: "wss://twilio-media-server-production.up.railway.app/media",
  });

  twiml.say("You are connected.");

  res.type("text/xml");
  res.send(twiml.toString());
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Listening on", PORT);
});
