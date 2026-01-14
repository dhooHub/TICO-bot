const express = require("express");
const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.send("OK - TICO-bot vivo ✅");
});

// Verificación de Meta (GET)
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = "tico_verify_123";

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// Recepción de eventos/mensajes (POST)
app.post("/webhook", (req, res) => {
  console.log("Mensaje recibido:", JSON.stringify(req.body, null, 2));
  return res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on port", PORT));





