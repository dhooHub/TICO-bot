const express = require("express");
const app = express();

// Necesario para leer JSON de WhatsApp
app.use(express.json());

// Ruta base para probar que el servidor está vivo
app.get("/", (req, res) => {
  res.send("OK - TICO-bot vivo ✅");
});

/*
==============================
  VERIFICACIÓN DEL WEBHOOK
  (Meta llama por GET)
==============================
*/
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = "tico_verify_123";

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado correctamente");
    return res.status(200).send(challenge);
  }

  console.log("Fallo verificación webhook");
  return res.sendStatus(403);
});

/*
==============================
  RECEPCIÓN DE MENSAJES
  (Meta llama por POST)
==============================
*/
app.post("/webhook", (req, res) => {
  console.log("Mensaje recibido:");
  console.log(JSON.stringify(req.body, null, 2));

  res.sendStatus(200);
});

// Puerto (Railway lo inyecta)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});








