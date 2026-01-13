import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { Readable } from "node:stream";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = http.createServer(app);

/**
 * ENV (Railway variables on MEDIA SERVER service)
 */
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVENLABS_MODEL_ID =
  process.env.ELEVENLABS_MODEL_ID || "eleven_monolingual_v1";

/**
 * HEALTH
 */
app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

/**
 * Twilio Voice Webhook
 * IMPORTANT:
 * - MUST accept GET AND POST
 * - MUST return TwiML
 */
app.all("/twilio/voice", (req, res) => {
  const host = req.get("host");
  const proto = req.get("x-forwarded-proto") || "https";
  const wsProto = proto === "https" ? "wss" : "ws";

  const streamUrl = `${wsProto}://${host}/media`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" track="both"/>
  </Connect>
</Response>`;

  res.set("Content-Type", "text/xml");
  res.status(200).send(twiml);
});

/**
 * Guard against HTTP hits on /media
 */
app.get("/media", (_req, res) => {
  res.status(426).send("WebSocket required");
});

/**
 * WebSocket Media Stream
 */
const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (ws) => {
  console.log("Twilio media stream connected");

  let streamSid = null;

  ws.on("message", async (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      streamSid = data.start.streamSid;
      console.log("Stream started:", streamSid);

      await speakToTwilio(ws, streamSid, "Hello. I can hear you now.");
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
});

/**
 * ElevenLabs → Twilio (PCMU / 8k)
 */
async function speakToTwilio(ws, streamSid, text) {
  console.log("Speaking:", text);

  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream` +
    `?output_format=ulaw_8000`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      model_id: ELEVENLABS_MODEL_ID,
    }),
  });

  const nodeStream = Readable.fromWeb(resp.body);

  const FRAME = 160;
  let buffer = Buffer.alloc(0);

  for await (const chunk of nodeStream) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (buffer.length >= FRAME) {
      const frame = buffer.subarray(0, FRAME);
      buffer = buffer.subarray(FRAME);

      ws.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: frame.toString("base64") },
        })
      );
    }
  }
}

/**
 * START
 */
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log("Listening on port", PORT);
});
