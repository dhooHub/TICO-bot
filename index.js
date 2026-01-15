const express = require("express");
const app = express();

app.use(express.json());

/**
 * ============================
 *  ENV (Railway Variables)
 * ============================
 */
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "tico_verify_123";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";

const STORE_NAME = process.env.STORE_NAME || "TICO-bot";
const CATALOG_URL = process.env.CATALOG_URL || "";
const SINPE_NUMBER = process.env.SINPE_NUMBER || "";
const SINPE_NAME = process.env.SINPE_NAME || "";
const STORE_TYPE = (process.env.STORE_TYPE || "virtual").toLowerCase(); // virtual | fisica
const MAPS_URL = process.env.MAPS_URL || "";
const HOURS_DAY = process.env.HOURS_DAY || "9am-7pm";

/**
 * ============================
 *  Estado en memoria (v1)
 * ============================
 * Nota: en producción real luego lo pasamos a DB.
 */
const sessions = new Map(); // key: wa_id, value: session object

const CLOSE_AFTER_MS = 2 * 60 * 60 * 1000; // 2 horas

function getSession(waId) {
  if (!sessions.has(waId)) {
    sessions.set(waId, {
      waId,
      state: "NEW",
      catalog_sent: false,
      last_image_id: null,
      last_details_text: null,
      sent_to_seller: false,
      last_activity: Date.now(),
      close_timer: null,
    });
  }
  return sessions.get(waId);
}

function resetCloseTimer(session) {
  if (session.close_timer) clearTimeout(session.close_timer);
  session.close_timer = setTimeout(() => {
    session.state = "CERRADO_SIN_COSTO";
    session.sent_to_seller = false;
    session.last_image_id = null;
    session.last_details_text = null;
    console.log(`⏱️ Caso cerrado por timeout (2h): ${session.waId}`);
  }, CLOSE_AFTER_MS);
}

function extractMessage(payload) {
  try {
    const entry = payload.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    const contact = value?.contacts?.[0];

    if (!msg) return null;

    const waId = contact?.wa_id || msg.from; // fallback
    const type = msg.type;

    const text =
      type === "text" ? (msg.text?.body || "").trim() : "";

    const imageId =
      type === "image" ? (msg.image?.id || null) : null;

    return { waId, type, text, imageId };
  } catch (e) {
    return null;
  }
}

function isGreeting(text) {
  const t = (text || "").toLowerCase();
  return ["hola", "buenas", "buenos dias", "buen día", "buenas tardes", "buenas noches", "hello"].some(k => t.includes(k));
}

function looksLikeDetails(text) {
  // Regla simple: menciona talla/color/tamaño o algo como "M", "L", "rojo", números, etc.
  const t = (text || "").toLowerCase();
  if (!t) return false;

  const keywords = ["talla", "color", "tamaño", "tamano", "medida", "m ", "l ", "s ", "xl", "xxl", "rojo", "negro", "blanco", "azul", "verde", "gris"];
  const hasKeyword = keywords.some(k => t.includes(k));
  const hasNumber = /\d/.test(t);

  return hasKeyword || hasNumber || t.length >= 4;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("⚠️ Telegram no configurado (faltan variables).");
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });
}

async function sendWhatsAppText(toWaId, bodyText) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.log("⚠️ WhatsApp send desactivado (faltan WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID).");
    console.log("↳ Respuesta que se hubiera enviado:", { toWaId, bodyText });
    return;
  }

  const url = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toWaId,
      type: "text",
      text: { body: bodyText },
    }),
  });
}

/**
 * ============================
 *  Rutas base
 * ============================
 */
app.get("/", (req, res) => {
  res.send("OK - TICO-bot vivo ✅");
});

/**
 * Verificación webhook (Meta)
 */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado correctamente");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/**
 * Recepción de mensajes (Meta)
 */
app.post("/webhook", async (req, res) => {
  const msg = extractMessage(req.body);
  if (!msg) {
    res.sendStatus(200);
    return;
  }

  const { waId, type, text, imageId } = msg;

  const session = getSession(waId);
  session.last_activity = Date.now();
  resetCloseTimer(session);

  console.log("📩 Mensaje:", { waId, type, text, imageId });

  // 1) Saludo -> catálogo (solo 1 vez por sesión)
  if (type === "text" && isGreeting(text)) {
    if (!session.catalog_sent && CATALOG_URL) {
      session.catalog_sent = true;
      session.state = "CATALOGO_ENVIADO";
      await sendWhatsAppText(
        waId,
        `¡Hola! Pura vida 🙌 Qué gusto que nos escribís.\nAquí te dejo el catálogo: ${CATALOG_URL}\n\nSi algo te gusta, mandame la captura/foto y los detalles (talla, color o tamaño) y te ayudo.`
      );
    } else {
      await sendWhatsAppText(
        waId,
        `¡Hola! 🙌 ¿Te interesa algún producto hoy? Mandame la captura/foto y decime talla, color o tamaño para ayudarte.`
      );
    }
    res.sendStatus(200);
    return;
  }

  // 2) Si manda FOTO sin detalles -> pedir talla/color/tamaño
  if (type === "image") {
    session.last_image_id = imageId;
    session.sent_to_seller = false;
    session.state = "ESPERANDO_DETALLES";

    await sendWhatsAppText(
      waId,
      `¡Pura vida! 🙌 Qué chiva está ese.\nPara confirmarte si lo tenemos y darte el precio, decime: ¿qué talla, color o tamaño ocupás?`
    );

    res.sendStatus(200);
    return;
  }

  // 3) Si manda texto y parece detalles, y ya tenemos foto -> notificar a vendedor (Telegram)
  if (type === "text" && looksLikeDetails(text) && session.last_image_id && !session.sent_to_seller) {
    session.last_details_text = text;
    session.sent_to_seller = true;
    session.state = "ENVIADO_A_VENDEDOR";

    await sendWhatsAppText(waId, `Dame un toque, voy a revisar si lo tenemos 👍`);

    const waLink = `https://wa.me/${waId}`;
    const telegramMsg =
`📦 Nueva consulta - ${STORE_NAME}

👤 Cliente: ${waId}
📝 Detalles: ${text}

Respondé con:
- 7000 2000   (precio envío)
- NO          (no hay stock)

👉 ${waLink}`;

    await sendTelegram(telegramMsg);

    res.sendStatus(200);
    return;
  }

  // 4) Texto sin foto/detalles -> tratar como “curioso” (gratis)
  if (type === "text") {
    // FAQ básico mínimo (luego lo hacemos configurable)
    const t = (text || "").toLowerCase();

    if (t.includes("horario") || t.includes("abren") || t.includes("cierran")) {
      await sendWhatsAppText(waId, `🕘 Horario: ${HOURS_DAY}`);
      res.sendStatus(200);
      return;
    }

    if (t.includes("ubic") || t.includes("donde") || t.includes("direc")) {
      if (STORE_TYPE === "fisica" && MAPS_URL) {
        await sendWhatsAppText(waId, `📍 Ubicación: ${MAPS_URL}`);
      } else {
        await sendWhatsAppText(waId, `Somos tienda virtual 🙌 Si querés, mandame la captura/foto del producto y te ayudo con precio y disponibilidad.`);
      }
      res.sendStatus(200);
      return;
    }

    // Si pregunta “precio” sin foto/detalles
    if (t.includes("precio") || t.includes("cuanto") || t === "?") {
      await sendWhatsAppText(
        waId,
        `Para darte el precio exacto necesito la captura/foto del producto y el detalle (talla, color o tamaño). Mandámelo y con gusto 🙌`
      );
      res.sendStatus(200);
      return;
    }

    // Default
    await sendWhatsAppText(
      waId,
      `De una 🙌 Mandame la captura/foto del producto y decime talla, color o tamaño para confirmarte disponibilidad y precio.`
    );
    res.sendStatus(200);
    return;
  }

  res.sendStatus(200);
});

/**
 * Server
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 TICO-bot corriendo en puerto", PORT);
});













