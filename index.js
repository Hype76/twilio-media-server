import express from "express";
import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

const BASE_URL = "https://twilio-media-server-production.up.railway.app";

const AUDIO_DIR = path.join(process.cwd(), "audio");
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);

app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

/**
 * ENTRY POINT
 */
app.post("/twilio/voice", async (_req, res) => {
  const greetingUrl = await synthesizeWithElevenLabs(
    "Hello, how can I help you today?"
  );

  res.type("text/xml").send(
    `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather
    input="speech"
    action="${BASE_URL}/twilio/gather"
    method="POST"
    speechTimeout="auto">
    <Play>${greetingUrl}</Play>
  </Gather>
</Response>
`.trim()
  );
});

/**
 * HANDLE SPEECH RESULT
 */
app.post("/twilio/gather", async (req, res) => {
  const userText = req.body?.SpeechResult;

  if (!userText || userText.trim().length === 0) {
    return res.type("text/xml").send(
      `
<Response>
  <Gather
    input="speech"
    action="${BASE_URL}/twilio/gather"
    method="POST"
    speechTimeout="auto" />
</Response>
`.trim()
    );
  }

  const assistantText = await callOpenAI(userText);
  const audioUrl = await synthesizeWithElevenLabs(assistantText);

  res.type("text/xml").send(
    `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${audioUrl}</Play>
  <Gather
    input="speech"
    action="${BASE_URL}/twilio/gather"
    method="POST"
    speechTimeout="auto" />
</Response>
`.trim()
  );
});

/**
 * OPENAI
 */
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

  const json = await res.json();
  return json.choices[0].message.content;
}

/**
 * ELEVENLABS
 */
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

  return `${BASE_URL}/audio/${id}.mp3`;
}

app.use("/audio", express.static(AUDIO_DIR));

http.createServer(app).listen(PORT, () => {
  console.log("Listening on", PORT);
});
