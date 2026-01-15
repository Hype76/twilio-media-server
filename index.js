import express from "express";
import http from "http";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import crypto from "crypto";
import FormData from "form-data";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/**
 * CONFIG
 */
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

/**
 * AUDIO CACHE
 */
const AUDIO_DIR = path.join(process.cwd(), "audio");
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);

/**
 * HEALTH
 */
app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

/**
 * TWILIO ENTRY POINT
 */
app.post("/twilio/voice", (_req, res) => {
  const twiml = `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather
    input="speech"
    action="/twilio/gather"
    method="POST"
    speechTimeout="auto"
    record="record-from-answer">
    <Play>${buildGreetingAudio()}</Play>
  </Gather>
</Response>
`.trim();

  res.type("text/xml").status(200).send(twiml);
});

/**
 * HANDLE USER SPEECH
 */
app.post("/twilio/gather", async (req, res) => {
  try {
    const recordingUrl = req.body?.RecordingUrl;

    if (!recordingUrl) {
      return res.type("text/xml").send(emptyGather());
    }

    const audioBuffer = await downloadTwilioRecording(recordingUrl);
    const transcript = await transcribeWithWhisper(audioBuffer);

    if (!transcript) {
      return res.type("text/xml").send(emptyGather());
    }

    const assistantText = await callOpenAI(transcript);
    if (!assistantText) {
      return res.type("text/xml").send(emptyGather());
    }

    const audioUrl = await synthesizeWithElevenLabs(assistantText);

    const twiml = `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${audioUrl}</Play>
  <Gather
    input="speech"
    action="/twilio/gather"
    method="POST"
    speechTimeout="auto"
    record="record-from-answer" />
</Response>
`.trim();

    res.type("text/xml").status(200).send(twiml);
  } catch (err) {
    console.error("gather error:", err);
    res.type("text/xml").send(emptyGather());
  }
});

/**
 * HELPERS
 */

function emptyGather() {
  return `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather
    input="speech"
    action="/twilio/gather"
    method="POST"
    speechTimeout="auto"
    record="record-from-answer" />
</Response>
`.trim();
}

function buildGreetingAudio() {
  // MUST be a publicly accessible ElevenLabs MP3
  return "https://your-domain.com/static/greeting.mp3";
}

async function downloadTwilioRecording(url) {
  const res = await fetch(`${url}.wav`);
  return Buffer.from(await res.arrayBuffer());
}

async function transcribeWithWhisper(audioBuffer) {
  const form = new FormData();
  form.append("file", audioBuffer, "audio.wav");
  form.append("model", "whisper-1");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: form,
  });

  if (!res.ok) return null;
  const json = await res.json();
  return json.text?.trim() || null;
}

async function callOpenAI(userText) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful voice assistant." },
        { role: "user", content: userText },
      ],
    }),
  });

  if (!res.ok) return null;
  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() || null;
}

async function synthesizeWithElevenLabs(text) {
  const id = crypto.randomUUID();
  const filePath = path.join(AUDIO_DIR, `${id}.mp3`);

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_monolingual_v1",
      }),
    }
  );

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filePath, buffer);

  return `https://your-domain.com/audio/${id}.mp3`;
}

/**
 * STATIC AUDIO
 */
app.use("/audio", express.static(AUDIO_DIR));

/**
 * START SERVER
 */
http.createServer(app).listen(PORT, () => {
  console.log("Listening on", PORT);
});
