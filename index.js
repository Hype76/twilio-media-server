import express from "express";
import http from "http";
import WebSocket from "ws";

const app = express();
const server = http.createServer(app);

// Health check
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

// WebSocket server (Twilio Media Streams)
const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (ws, req) => {
  console.log("Twilio connected");

  ws.on("message", (msg) => {
    // Twilio sends JSON frames
    console.log("frame received");
  });

  ws.on("close", () => {
    console.log("Twilio disconnected");
  });

  ws.on("error", (err) => {
    console.error("WebSocket error", err);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});