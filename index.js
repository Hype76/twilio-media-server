import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
const server = http.createServer(app);

const wss = new WebSocketServer({
  server,
  path: "/media",
});

wss.on("connection", (ws) => {
  console.log("Twilio connected");

  ws.on("message", (msg) => {
    console.log("audio frame");
  });

  ws.on("close", () => {
    console.log("Twilio disconnected");
  });
});

app.get("/health", (req, res) => {
  res.send("ok");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Listening on", PORT);
});
