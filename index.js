import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = http.createServer(app);

/**
 * ENV
 */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

if (!OPENAI_API_KEY) console.warn("Missing OPENAI_API_KEY");
if (!ELEVENLABS_API_KEY) console.warn("Missing ELEVENLABS_API_KEY");
if (!ELEVENLABS_VOICE_ID) console.warn("Missing ELEVENLABS_VOICE_ID");

/**
 * HEALTH
 */
app.get("/health", (_req, res) => res.status(200).send("ok"));

/**
 * TWILIO VOICE WEBHOOK
 * Twilio will HTTP POST here on inbound calls
 */
function buildTwiml(req) {
  const host = req.get("host");
  const proto = req.get("x-forwarded-proto") || "https";
  const wsProto = proto === "https" ? "wss" : "ws";
  const streamUrl = `${wsProto}://${host}/media`;

  // track="inbound" means we only receive inbound audio from Twilio
  // We can still send audio back to Twilio over the same WS connection.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" track="inbound" />
  </Connect>
</Response>`;
}

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(buildTwiml(req));
});

// Helpful for browser testing
app.get("/twilio/voice", (req, res) => {
  res.type("text/xml").send(buildTwiml(req));
});

/**
 * BLOCK HTTP ACCESS TO /media
 */
app.get("/media", (_req, res) => res.status(426).send("WebSocket required"));

/**
 * WEBSOCKET: Twilio Media Stream
 */
const wss = new WebSocketServer({ server, path: "/media" });

// 20ms at 8kHz mu-law = 160 bytes
const FRAME_BYTES = 160;
const FRAME_MS = 20;

// "end of utterance" detection: if we stop receiving inbound frames for this long
const SILENCE_MS = 700;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

wss.on("connection", (ws) => {
  console.log("Twilio media stream connected");

  let streamSid = null;
  let callSid = null;

  let inboundChunks = [];
  let silenceTimer = null;
  let processing = false;

  // Make sure we never overlap audio sends
  let speakQueue = Promise.resolve();

  function queueSpeak(text) {
    speakQueue = speakQueue
      .then(() => speak(ws, streamSid, text))
      .catch((err) => console.error("Speak failed:", err?.message || err));
    return speakQueue;
  }

  function resetSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(async () => {
      if (processing) return;
      if (!streamSid) return;
      if (inboundChunks.length === 0) return;

      processing = true;
      const ulaw = Buffer.concat(inboundChunks);
      inboundChunks = [];

      try {
        const text = await transcribeUlawToText(ulaw);
        if (text) {
          console.log("User said:", text);
          await queueSpeak(`You said: ${text}`);
        }
      } catch (err) {
        console.error("Transcribe pipeline failed:", err?.message || err);
      } finally {
        processing = false;
      }
    }, SILENCE_MS);
  }

  ws.on("message", async (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      streamSid = data.start?.streamSid || null;
      callSid = data.start?.callSid || null;

      console.log("Stream started:", streamSid, "CallSid:", callSid);

      // Greeting (NO Twilio voice)
      if (ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID) {
        await queueSpeak("Hello. I can hear you now.");
      } else {
        console.warn("Skipping greeting (missing ElevenLabs env)");
      }
      return;
    }

    if (data.event === "media") {
      // inbound audio frames are mu-law 8k, base64
      if (!data.media?.payload) return;

      const audio = Buffer.from(data.media.payload, "base64");
      inboundChunks.push(audio);
      resetSilenceTimer();
      return;
    }

    if (data.event === "stop") {
      console.log("Stream stopped");
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = null;
      return;
    }
  });

  ws.on("close", () => {
    console.log("Twilio disconnected");
    if (silenceTimer) clearTimeout(silenceTimer);
  });

  ws.on("error", (err) => {
    console.error("WS error:", err?.message || err);
  });
});

/**
 * OPENAI TRANSCRIBE (expects wav)
 */
async function transcribeUlawToText(ulaw) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const wav = ulawToWav(ulaw);

  const form = new FormData();
  form.append("file", new Blob([wav]), "audio.wav");
  form.append("model", "gpt-4o-transcribe");

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });

  const json = await resp.json();
  const text = json?.text?.trim();
  return text || "";
}

/**
 * ELEVENLABS TTS -> send to Twilio as ulaw 8k frames, paced at 20ms
 */
async function speak(ws, streamSid, text) {
  if (!streamSid) throw new Error("No streamSid yet");
  if (!ELEVENLABS_API_KEY) throw new Error("Missing ELEVENLABS_API_KEY");
  if (!ELEVENLABS_VOICE_ID) throw new Error("Missing ELEVENLABS_VOICE_ID");

  console.log("Speaking:", text);

  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?output_format=ulaw_8000`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    }
  );

  if (!resp.ok) {
    const errTxt = await safeText(resp);
    throw new Error(`ElevenLabs HTTP ${resp.status}: ${errTxt}`);
  }

  if (!resp.body) throw new Error("ElevenLabs returned no body");

  const reader = resp.body.getReader();
  let buffer = Buffer.alloc(0);

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;

    buffer = Buffer.concat([buffer, Buffer.from(value)]);

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

      // pacing matters
      await sleep(FRAME_MS);
    }
  }

  // flush partial frame if any (pad with silence)
  if (buffer.length > 0) {
    const padded = Buffer.concat([buffer, Buffer.alloc(FRAME_BYTES - buffer.length)]);
    ws.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: padded.toString("base64") },
      })
    );
    await sleep(FRAME_MS);
  }
}

async function safeText(resp) {
  try {
    return (await resp.text())?.slice(0, 500) || "";
  } catch {
    return "";
  }
}

/**
 * ULAW -> WAV header (8kHz, 8-bit mu-law)
 */
function ulawToWav(ulaw) {
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + ulaw.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(7, 20); // mu-law
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000, 28); // byte rate (8k * 1ch * 1 byte)
  header.writeUInt16LE(1, 32); // block align
  header.writeUInt16LE(8, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(ulaw.length, 40);

  return Buffer.concat([header, ulaw]);
}

/**
 * START SERVER
 */
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log("Listening on port", PORT);
});
