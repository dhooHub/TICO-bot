const express = require("express");
const app = express();

app.use(express.json());

const VERIFY_TOKEN = "tico_verify_123";

// Ruta raíz (solo para comprobar que vive)
app.get("/", (req, res) => {
  res.send("OK - TICO-bot vivo ✅");
});

// 🔹 VERIFICACIÓN DE WEBHOOK (Meta)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// 🔹 RECEPCIÓN DE MENSAJES
app.post("/webhook", (req, res) => {
  console.log("📩 Mensaje recibido:");
  console.log(JSON.stringify(req.body, null, 2));

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 TICO-bot corriendo"));











