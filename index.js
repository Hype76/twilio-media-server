import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
app.use(express.urlencoded({ extended: false }));

const server = http.createServer(app);

/**
 * HEALTH CHECK
 */
app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

/**
 * TWILIO VOICE WEBHOOK
 * This ONLY tells Twilio to start streaming audio to /media
 */
app.post("/twilio/voice", (req, res) => {
  const host = req.get("host");
  const proto = req.get("x-forwarded-proto") || "https";
  const wsProto = proto === "https" ? "wss" : "ws";

  const streamUrl = `${wsProto}://${host}/media`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" track="inbound"/>
  </Connect>
</Response>`;

  res.type("text/xml");
  res.send(twiml);
});

/**
 * BLOCK HTTP ACCESS TO /media
 */
app.get("/media", (_req, res) => {
  res.status(426).send("WebSocket required");
});

/**
 * WEBSOCKET MEDIA STREAM
 * Pure echo server
 */
const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (ws) => {
  console.log("Twilio media stream connected");

  let streamSid = null;

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      streamSid = data.start.streamSid;
      console.log("Stream started:", streamSid);
      return;
    }

    if (data.event === "media") {
      // ECHO BACK EXACTLY WHAT TWILIO SENT
      ws.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: {
            payload: data.media.payload,
          },
        })
      );
      return;
    }

    if (data.event === "stop") {
      console.log("Stream stopped");
      return;
    }
  });

  ws.on("close", () => {
    console.log("Twilio disconnected");
  });

  ws.on("error", (err) => {
    console.error("WS error:", err.message);
  });
});

/**
 * START SERVER
 */
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log("Listening on port", PORT);
});
