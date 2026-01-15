const express = require("express");
const app = express();

app.use(express.json());

/**
 * ============================
 *  VARIABLES (Railway → Variables)
 * ============================
 */
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "tico_verify_123";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";

const STORE_NAME = process.env.STORE_NAME || "TICO-bot";
const CATALOG_URL = process.env.CATALOG_URL || "";
const HOURS_DAY = process.env.HOURS_DAY || "9am-7pm";
const STORE_TYPE = (process.env.STORE_TYPE || "virtual").toLowerCase(); // virtual | fisica
const MAPS_URL = process.env.MAPS_URL || "";

/**
 * ============================
 *  ESTADO EN MEMORIA (v1)
 * ============================
 */
const sessions = new Map();
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

/**
 * ============================
 *  TEXTO HUMANO TICO (ROTACIÓN)
 * ============================
 */
const FIXED_ASK_DETAILS =
  "¿Qué talla, tamaño, color u otra característica buscás?";

const PREFIXES_TICOS = [
  "Déjame revisar 🙌",
  "Un toque y reviso 👌",
  "Ya te confirmo, dame un chance 😊",
];

function pickPrefix(session) {
  // rota simple: evita repetir el mismo prefijo consecutivo por cliente
  const last = session.last_prefix || "";
  const options = PREFIXES_TICOS.filter((p) => p !== last);
  const chosen = options[Math.floor(Math.random() * options.length)];
  session.last_prefix = chosen;
  return chosen;
}

function msgAskDetails(session) {
  return `${pickPrefix(session)}\n${FIXED_ASK_DETAILS}`;
}

/**
 * ============================
 *  DETECCIÓN DE "DETALLE MÍNIMO"
 * ============================
 * Detalle mínimo = talla o color o tamaño/variante.
 * (reglas simples, baratas y controlables)
 */
const COLORS = [
  "negro",
  "blanco",
  "rojo",
  "azul",
  "verde",
  "gris",
  "beige",
  "café",
  "cafe",
  "morado",
  "rosado",
  "amarillo",
  "naranja",
  "plateado",
  "dorado",
];

function hasSize(text) {
  const t = (text || "").toLowerCase();

  // tallas tipo S M L XL XXL etc (con o sin "talla")
  if (/\b(x{0,3}l|xxl|xl|xs|s|m|l)\b/i.test(t)) return true;
  if (t.includes("talla")) return true;

  // números que suelen ser talla/medida (ej: 36, 38, 40, 42, 7, 8, 9)
  if (/\b(3[0-9]|4[0-9]|[5-9]|1[0-2])\b/.test(t)) return true;

  // tamaños/variantes
  if (t.includes("pequeñ") || t.includes("pequen") || t.includes("mediano") || t.includes("grande")) return true;
  if (t.includes("ml") || t.includes("litro") || t.includes("cm") || t.includes("mm")) return true;

  return false;
}

function hasColor(text) {
  const t = (text || "").toLowerCase();
  return COLORS.some((c) => t.includes(c));
}

function isMinimalDetail(text) {
  const t = (text || "").trim();
  if (!t) return false;
  // Si solo dice "precio / disponible / tienen esta / info", NO es detalle.
  const low = t.toLowerCase();
  const genericOnly =
    low === "?" ||
    low.includes("precio") ||
    low.includes("cuanto") ||
    low.includes("disponible") ||
    low.includes("tienen esta") ||
    low.includes("tiene esta") ||
    low === "info" ||
    low === "información" ||
    low === "informacion";

  if (genericOnly && !hasSize(low) && !hasColor(low)) return false;

  return hasSize(low) || hasColor(low);
}

function isGreeting(text) {
  const t = (text || "").toLowerCase();
  return ["hola", "buenas", "buenos dias", "buen día", "buenas tardes", "buenas noches", "hello"].some((k) =>
    t.includes(k)
  );
}

/**
 * ============================
 *  WHATSAPP / TELEGRAM (helpers)
 * ============================
 */
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
 *  EXTRAER MENSAJE (WhatsApp payload)
 * ============================
 */
function extractMessage(payload) {
  try {
    const value = payload.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    const contact = value?.contacts?.[0];

    if (!msg) return null;

    const waId = contact?.wa_id || msg.from;
    const type = msg.type;

    const text =
      type === "text" ? (msg.text?.body || "").trim() : "";

    // Caption (cuando mandan foto + texto junto)
    const imageId = type === "image" ? (msg.image?.id || null) : null;
    const caption = type === "image" ? (msg.image?.caption || "").trim() : "";

    return { waId, type, text, imageId, caption };
  } catch {
    return null;
  }
}

/**
 * ============================
 *  ENDPOINTS
 * ============================
 */
app.get("/", (req, res) => {
  res.send("OK - TICO-bot vivo ✅");
});

// Verificación webhook (Meta)
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

// Recepción de mensajes (Meta)
app.post("/webhook", async (req, res) => {
  const msg = extractMessage(req.body);
  if (!msg) return res.sendStatus(200);

  const { waId, type, text, imageId, caption } = msg;

  const session = getSession(waId);
  session.last_activity = Date.now();
  resetCloseTimer(session);

  console.log("📩 Mensaje:", { waId, type, text, imageId, caption });

  /**
   * 1) SALUDO
   */
  if (type === "text" && isGreeting(text)) {
    if (!session.catalog_sent && CATALOG_URL) {
      session.catalog_sent = true;
      session.state = "CATALOGO_ENVIADO";
      await sendWhatsAppText(
        waId,
        `¡Hola! Pura vida 🙌 Qué gusto que nos escribís.\nAquí te dejo el catálogo: ${CATALOG_URL}\n\nSi algo te gusta, mandame la captura/foto y me decís talla, color o tamaño 👌`
      );
    } else {
      await sendWhatsAppText(
        waId,
        `¡Hola! 🙌 Mandame la captura/foto del producto y me decís talla, color o tamaño para ayudarte.`
      );
    }
    return res.sendStatus(200);
  }

  /**
   * 2) FOTO (siempre trae texto, pero puede ser genérico o con detalle)
   */
  if (type === "image") {
    session.last_image_id = imageId;
    session.sent_to_seller = false;

    const captionText = (caption || "").trim();

    // 2A) Si caption ya trae detalle mínimo -> se manda al vendedor
    if (captionText && isMinimalDetail(captionText)) {
      session.last_details_text = captionText;
      session.sent_to_seller = true;
      session.state = "ENVIADO_A_VENDEDOR";

      await sendWhatsAppText(waId, `Dame un toque, voy a revisar si lo tenemos 👍`);

      const waLink = `https://wa.me/${waId}`;
      const telegramMsg =
`📦 Nueva consulta - ${STORE_NAME}

👤 Cliente: ${waId}
📝 Detalles: ${captionText}

Respondé con:
- 7000 2000   (precio envío)
- NO          (no hay stock)

👉 ${waLink}`;

      await sendTelegram(telegramMsg);
      return res.sendStatus(200);
    }

    // 2B) Caption genérico (o vacío) -> pedir detalle mínimo (humano tico)
    session.state = "ESPERANDO_DETALLES";
    await sendWhatsAppText(waId, msgAskDetails(session));
    return res.sendStatus(200);
  }

  /**
   * 3) TEXTO DESPUÉS DE UNA FOTO (detalle mínimo)
   * Ej: "la querés en M?" "en L" "plateado"
   */
  if (type === "text" && session.last_image_id && !session.sent_to_seller) {
    if (isMinimalDetail(text)) {
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
      return res.sendStatus(200);
    }

    // Texto pero no trae detalle mínimo -> pedirlo (tico humano)
    session.state = "ESPERANDO_DETALLES";
    await sendWhatsAppText(waId, msgAskDetails(session));
    return res.sendStatus(200);
  }

  /**
   * 4) TEXTO SIN FOTO (curioso / FAQ)
   */
  if (type === "text") {
    const t = (text || "").toLowerCase();

    // FAQ horario
    if (t.includes("horario") || t.includes("abren") || t.includes("cierran")) {
      await sendWhatsAppText(waId, `🕘 Horario: ${HOURS_DAY}`);
      return res.sendStatus(200);
    }

    // FAQ ubicación
    if (t.includes("ubic") || t.includes("donde") || t.includes("direc")) {
      if (STORE_TYPE === "fisica" && MAPS_URL) {
        await sendWhatsAppText(waId, `📍 Ubicación: ${MAPS_URL}`);
      } else {
        await sendWhatsAppText(
          waId,
          `Somos tienda virtual 🙌 Mandame la captura/foto del producto y te ayudo con gusto.`
        );
      }
      return res.sendStatus(200);
    }

    // Si pregunta precio/disponibilidad pero no manda foto
    if (t.includes("precio") || t.includes("cuanto") || t.includes("disponible") || t.includes("tienen")) {
      await sendWhatsAppText(
        waId,
        `De una 🙌 Mandame la foto/captura del producto y me decís talla, color o tamaño para confirmarte.`
      );
      return res.sendStatus(200);
    }

    // Default
    await sendWhatsAppText(
      waId,
      `Dale 🙌 Mandame la foto/captura del producto y me decís talla, color o tamaño para ayudarte.`
    );
    return res.sendStatus(200);
  }

  return res.sendStatus(200);
});

/**
 * ============================
 *  SERVER
 * ============================
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 TICO-bot corriendo en puerto", PORT);
});













