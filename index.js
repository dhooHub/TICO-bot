const express = require("express");
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "tico_verify_123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const OWNER_PHONE = process.env.OWNER_PHONE || "";

const PORT = process.env.PORT || 8080;

// Enviar mensaje WhatsApp
async function sendWhatsApp(to, text) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.log("⚠️ Falta WHATSAPP_TOKEN o PHONE_NUMBER_ID");
    return;
  }
  
  const url = `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    });
    
    const data = await resp.json();
    console.log("📤 Enviado:", resp.status, JSON.stringify(data).slice(0, 100));
  } catch (e) {
    console.log("⚠️ Error enviando:", e.message);
  }
}

// Raíz
app.get("/", (req, res) => {
  res.send("TICO-bot MINI ✅");
});

// Webhook verificación
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Webhook mensajes
app.post("/webhook", async (req, res) => {
  console.log("📩 Webhook recibido");
  
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const msg = change?.value?.messages?.[0];
    
    if (!msg) {
      console.log("⏭️ No es mensaje");
      return res.sendStatus(200);
    }
    
    const waId = msg.from;
    const text = msg.text?.body || "";
    const type = msg.type;
    
    console.log("📱 Mensaje:", { waId, type, text });
    
    // Responder
    await sendWhatsApp(waId, `¡Hola! Recibí tu mensaje: "${text}" 🙌`);
    
    return res.sendStatus(200);
  } catch (e) {
    console.log("❌ Error:", e.message);
    return res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 TICO-bot MINI | Puerto ${PORT}`);
  console.log(`👤 Dueño: ${OWNER_PHONE || "no configurado"}`);
});
