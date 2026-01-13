import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { Readable } from "node:stream";

const app = express();
app.use(express.urlencoded({ extended: false }));

const server = http.createServer(app);

/**
 * ENV (set these in Railway for the MEDIA SERVER service)
 * - ELEVENLABS_API_KEY
 * - ELEVENLABS_VOICE_ID   (you set Nathaniel already: Wq15xSaY3gWvazBRaGEU)
 * Optional:
 * - ELEVENLABS_MODEL_ID   (default below)
 */
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_monolingual_v1";

if (!ELEVENLABS_API_KEY) console.warn("Missing ELEVENLABS_API_KEY");
if (!ELEVENLABS_VOICE_ID) console.warn("Missing ELEVENLABS_VOICE_ID");

/**
 * HEALTH
 */
app.get("/health", (_req, res) => res.status(200).send("ok"));

/**
 * IMPORTANT: Twilio needs an HTTP webhook that returns TwiML.
 * This is NOT "Twilio Voice near it" as in AI logic, it is simply the hook that tells Twilio
 * to start streaming audio to /media.
 *
 * In Twilio, set your phone number Voice webhook to:
 *   https://YOUR-RAILWAY-URL/twilio/voice
 */
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

/**
 * If something hits /media over HTTP (not WS), make it obvious.
 */
app.get("/media", (_req, res) => {
  res.status(426).send("Upgrade Required (WebSocket only)");
});

/**
 * WEBSOCKET: Twilio Media Stream endpoint
 */
const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (ws) => {
  console.log("Twilio media stream connected");

  let streamSid = null;
  let started = false;

  ws.on("message", async (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      streamSid = data.start?.streamSid || null;
      started = true;
      console.log("Stream started:", streamSid);

      // Speak immediately so you hear something
      try {
        await speakToTwilio(ws, streamSid, "Hello. I can hear you now.");
        console.log("Finished speaking");
      } catch (e) {
        console.error("Speak failed:", e?.message || e);
      }
      return;
    }

    if (data.event === "stop") {
      console.log("Stream stopped");
      return;
    }

    // We are not processing inbound audio yet (STT later)
    if (data.event === "media") return;
  });

  ws.on("close", () => {
    console.log("Twilio disconnected");
  });

  ws.on("error", (err) => {
    console.error("WS error:", err?.message || err);
  });

  // If Twilio connects but never sends "start", log it
  setTimeout(() => {
    if (!started) console.warn("WS connected but no start event received yet");
  }, 2000);
});

/**
 * ElevenLabs -> Twilio
 *
 * Key point:
 * Twilio Media Streams expects mulaw (PCMU) at 8000 Hz.
 * We request ulaw_8000 directly from ElevenLabs to avoid conversion issues.
 *
 * We then frame it into 20ms chunks (160 bytes) before sending to Twilio.
 */
async function speakToTwilio(ws, streamSid, text) {
  if (!streamSid) throw new Error("Missing streamSid");
  if (!ELEVENLABS_API_KEY) throw new Error("Missing ELEVENLABS_API_KEY");
  if (!ELEVENLABS_VOICE_ID) throw new Error("Missing ELEVENLABS_VOICE_ID");

  console.log("Sending ElevenLabs speech");

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
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
      },
    }),
  });

  if (!resp.ok) {
    const body = await safeText(resp);
    throw new Error(`ElevenLabs HTTP ${resp.status}: ${body}`);
  }

  if (!resp.body) throw new Error("ElevenLabs response has no body stream");

  // Convert Web stream -> Node stream so for-await works reliably in Node 22
  const nodeStream = Readable.fromWeb(resp.body);

  const FRAME_BYTES = 160; // 20ms at 8kHz, 1 byte per sample for ulaw
  let buffer = Buffer.alloc(0);

  for await (const chunk of nodeStream) {
    if (ws.readyState !== ws.OPEN) break;

    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = Buffer.concat([buffer, b]);

    while (buffer.length >= FRAME_BYTES) {
      const frame = buffer.subarray(0, FRAME_BYTES);
      buffer = buffer.subarray(FRAME_BYTES);

      ws.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: {
            payload: frame.toString("base64"),
          },
        })
      );
    }
  }

  // Send any remaining bytes (pad to frame size so Twilio does not choke)
  if (ws.readyState === ws.OPEN && buffer.length > 0) {
    const padded = Buffer.concat([buffer, Buffer.alloc(FRAME_BYTES - buffer.length, 0xff)]);
    ws.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: {
          payload: padded.toString("base64"),
        },
      })
    );
  }
}

async function safeText(resp) {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log("Listening on port", PORT);
});
