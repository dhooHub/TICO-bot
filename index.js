const express = require("express");
const app = express();

// Permite leer JSON (necesario para WhatsApp)
app.use(express.json());

// Ruta base
app.get("/", (req, res) => {
  res.send("OK - TICO-bot vivo ✅");
});

// Webhook GET - Verificación de Meta
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

// Webhook POST - Mensajes entrantes
app.post("/webhook", (req, res) => {
  console.log("Mensaje recibido:");
  console.log(JSON.stringify(req.body, null, 2));

  res.sendStatus(200);
});

// Servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});







