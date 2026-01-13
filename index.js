import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { Readable } from "node:stream";

const app = express();
app.use(express.urlencoded({ extended: false }));

const server = http.createServer(app);

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVENLABS_MODEL_ID =
  process.env.ELEVENLABS_MODEL_ID || "eleven_monolingual_v1";

/* -------------------- HEALTH -------------------- */
app.get("/health", (_req, res) => res.status(200).send("ok"));

/* -------------------- TWILIO VOICE WEBHOOK -------------------- */
app.post("/twilio/voice", (req, res) => {
  const host = req.get("host");
  const proto = req.get("x-forwarded-proto") || "https";
  const wsProto = proto === "https" ? "wss" : "ws";
  const streamUrl = `${wsProto}://${host}/media`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;

  res.set("Content-Type", "text/xml");
  res.status(200).send(twiml);
});

/* -------------------- WEBSOCKET -------------------- */
const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (ws) => {
  console.log("Twilio media stream connected");

  let streamSid = null;
  let callActive = true;
  let speaking = false;
  let lastAudioAt = null;
  let silenceTimer = null;

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

      await speak(ws, streamSid, "Hello. I can hear you now.");
      return;
    }

    if (data.event === "media") {
      if (speaking) return;

      lastAudioAt = Date.now();

      if (silenceTimer) clearTimeout(silenceTimer);

      silenceTimer = setTimeout(async () => {
        if (!callActive || speaking) return;

        speaking = true;
        console.log("Detected silence, echoing");

        try {
          await speak(ws, streamSid, "You said something. I am listening.");
        } catch (e) {
          console.error("Speak failed:", e);
        }

        speaking = false;
      }, 500);

      return;
    }

    if (data.event === "stop") {
      callActive = false;
      console.log("Stream stopped");
      return;
    }
  });

  ws.on("close", () => {
    callActive = false;
    console.log("Twilio disconnected");
  });
});

/* -------------------- SPEAK -------------------- */
async function speak(ws, streamSid, text) {
  if (!streamSid) return;
  if (ws.readyState !== ws.OPEN) return;

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

  const FRAME_BYTES = 160;
  let buffer = Buffer.alloc(0);

  for await (const chunk of nodeStream) {
    if (ws.readyState !== ws.OPEN) break;

    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);

    while (buffer.length >= FRAME_BYTES) {
      const frame = buffer.subarray(0, FRAME_BYTES);
      buffer = buffer.subarray(FRAME_BYTES);

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

/* -------------------- SERVER -------------------- */
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log("Listening on port", PORT);
});
