import express from "express";
import http from "http";
import WebSocket from "ws";

const app = express();
const server = http.createServer(app);

const wss = new WebSocket.Server({
  server,
  path: "/media",
});

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

wss.on("connection", (ws) => {
  console.log("Twilio media stream connected");

  let streamSid = null;

  ws.on("message", async (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.event === "start") {
      streamSid = data.start.streamSid;
      console.log("Stream started", streamSid);

      // Speak immediately so you hear something
      await speak(ws, streamSid, "Hello. I can hear you now.");
    }

    if (data.event === "media") {
      // Audio is arriving from caller (ignored for now)
    }

    if (data.event === "stop") {
      console.log("Stream stopped");
    }
  });

  ws.on("close", () => {
    console.log("Twilio disconnected");
  });
});

async function speak(ws, streamSid, text) {
  console.log("Sending ElevenLabs speech");

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_monolingual_v1",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.8,
        },
      }),
    }
  );

  for await (const chunk of response.body) {
    ws.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: {
          payload: Buffer.from(chunk).toString("base64"),
        },
      })
    );
  }

  console.log("Finished speaking");
}

app.get("/health", (req, res) => {
  res.send("ok");
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log("Listening on port", PORT);
});
