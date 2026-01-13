import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { Readable } from "node:stream";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = http.createServer(app);

/**
 * ENV (MEDIA SERVER ONLY)
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
 * This ONLY tells Twilio to stream audio to /media
 */
app.post("/twilio/voice", (req, res) => {
  const host = req.get("host");
  const proto = req.get("x-forwarded-proto") || "https";
  const wsProto = proto === "https" ? "wss" : "ws";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsProto}://${host}/media" />
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

/**
 * WEBSOCKET: Twilio Media Stream
 */
const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (ws) => {
  console.log("Twilio media stream connected");

  let streamSid = null;
  let audioBuffer = [];

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
      const audio = Buffer.from(data.media.payload, "base64");
      audioBuffer.push(audio);
      return;
    }

    if (data.event === "stop") {
      console.log("Stream stopped");

      if (audioBuffer.length === 0) return;

      try {
        const pcm = Buffer.concat(audioBuffer);
        audioBuffer = [];

        const text = await transcribe(pcm);

        if (text) {
          console.log("User said:", text);
          await speak(ws, streamSid, `You said: ${text}`);
        }
      } catch (err) {
        console.error("Echo failed:", err.message);
      }
    }
  });

  ws.on("close", () => console.log("Twilio disconnected"));
});

/**
 * OPENAI WHISPER TRANSCRIPTION
 */
async function transcribe(ulawBuffer) {
  // Convert ulaw to wav container (OpenAI requires wav/mp3/etc)
  const wav = ulawToWav(ulawBuffer);

  const form = new FormData();
  form.append("file", new Blob([wav]), "audio.wav");
  form.append("model", "gpt-4o-transcribe");

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: form,
  });

  const json = await resp.json();
  return json.text?.trim();
}

/**
 * ELEVENLABS -> TWILIO (ulaw 8k)
 */
async function speak(ws, streamSid, text) {
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

  const nodeStream = Readable.fromWeb(resp.body);
  const FRAME = 160;
  let buffer = Buffer.alloc(0);

  for await (const chunk of nodeStream) {
    buffer = Buffer.concat([buffer, chunk]);

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
 * MINIMAL ULAW -> WAV HEADER
 * Just enough for Whisper
 */
function ulawToWav(ulaw) {
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + ulaw.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(7, 20); // ulaw
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(ulaw.length, 40);

  return Buffer.concat([header, ulaw]);
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log("Listening on port", PORT);
});
