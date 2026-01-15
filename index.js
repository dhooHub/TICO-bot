const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

/**
 * ============================
 *  VARIABLES (Railway → Variables)
 * ============================
 */
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "tico_verify_123";

// WhatsApp Cloud API
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";

// Número del DUEÑO (para detectar sus comandos)
const OWNER_PHONE = process.env.OWNER_PHONE || "";  // Ej: 50688887777

// Tienda
const STORE_NAME = process.env.STORE_NAME || "TICO-bot";
const CATALOG_URL = process.env.CATALOG_URL || "";
const STORE_TYPE = (process.env.STORE_TYPE || "virtual").toLowerCase(); // virtual | fisica
const STORE_ADDRESS = process.env.STORE_ADDRESS || "";  // Dirección física de la tienda
const MAPS_URL = process.env.MAPS_URL || "";

// Horario de atención
const HOURS_START = Number(process.env.HOURS_START || 9);
const HOURS_END = Number(process.env.HOURS_END || 19);
const HOURS_DAY = process.env.HOURS_DAY || `${HOURS_START}am-${HOURS_END > 12 ? HOURS_END - 12 : HOURS_END}pm`;

// SINPE
const SINPE_NUMBER = process.env.SINPE_NUMBER || "";
const SINPE_NAME = process.env.SINPE_NAME || "";

// Plan / Fichas
const MONTHLY_TOKENS = Number(process.env.MONTHLY_TOKENS || 100);
const PACK_TOKENS = Number(process.env.PACK_TOKENS || 10);
const PACK_PRICE_CRC = Number(process.env.PACK_PRICE_CRC || 1000);

// Admin
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const BASE_URL = process.env.BASE_URL || "";

// Persistencia
const STATS_PERSIST = String(process.env.STATS_PERSIST || "") === "1";
const SESSIONS_PERSIST = String(process.env.SESSIONS_PERSIST || "") === "1";

// Timeout de conversación (BASIC)
const SESSION_TIMEOUT_HOURS = Number(process.env.SESSION_TIMEOUT_HOURS || 2);

// Detección de ráfaga de fotos
const PHOTO_WAIT_SECONDS = Number(process.env.PHOTO_WAIT_SECONDS || 5);

// SINPE SMS (PRO)
const SINPE_SMS_SECRET = process.env.SINPE_SMS_SECRET || "";
const SINPE_SMS_LOOKBACK_MIN = Number(process.env.SINPE_SMS_LOOKBACK_MIN || 30);
const SINPE_WAIT_MINUTES = Number(process.env.SINPE_WAIT_MINUTES || 3);

// PRO Features
const PRO_REMINDER = String(process.env.PRO_REMINDER || "") === "1";

/**
 * ============================
 *  UTILIDADES DE TIEMPO (Costa Rica UTC-6)
 * ============================
 */
function getCostaRicaHour() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  return (utcHour - 6 + 24) % 24;
}

function isDaytime() {
  const hour = getCostaRicaHour();
  return hour >= HOURS_START && hour < HOURS_END;
}

function getTimeGreeting() {
  const hour = getCostaRicaHour();
  if (hour >= 5 && hour < 12) return "Buenos días";
  if (hour >= 12 && hour < 18) return "Buenas tardes";
  return "Buenas noches";
}

/**
 * ============================
 *  ESTADO EN MEMORIA
 * ============================
 */
const sessions = new Map();
const CLOSE_AFTER_MS = SESSION_TIMEOUT_HOURS * 60 * 60 * 1000;

// Para detectar ráfaga de fotos
const photoBuffers = new Map(); // waId -> { photos: [], timer: null }

// Para timeout de verificación SINPE
const sinpeWaitTimers = new Map(); // waId -> timer

function currentMonthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * ============================
 *  PERSISTENCIA
 * ============================
 */
const SESSIONS_FILE = path.join(process.cwd(), "sessions.json");
const STATS_FILE = path.join(process.cwd(), "stats.json");

function loadSessionsFromDisk() {
  if (!SESSIONS_PERSIST) return;
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const arr = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
    if (Array.isArray(arr)) {
      for (const s of arr) {
        if (s?.waId) {
          s.close_timer = null;
          sessions.set(s.waId, s);
        }
      }
      console.log(`📱 Sesiones cargadas: ${sessions.size}`);
    }
  } catch (e) {
    console.log("⚠️ Error cargando sesiones:", e?.message);
  }
}

function saveSessionsToDisk() {
  if (!SESSIONS_PERSIST) return;
  try {
    const arr = Array.from(sessions.values()).map(s => {
      const copy = { ...s };
      delete copy.close_timer;
      return copy;
    });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(arr, null, 2), "utf-8");
  } catch (e) {
    console.log("⚠️ Error guardando sesiones:", e?.message);
  }
}

setInterval(() => {
  if (SESSIONS_PERSIST && sessions.size > 0) {
    saveSessionsToDisk();
  }
}, 5 * 60 * 1000);

loadSessionsFromDisk();

/**
 * ============================
 *  CUENTA / FICHAS
 * ============================
 */
const account = {
  month_key: currentMonthKey(),
  monthly_tokens: MONTHLY_TOKENS,
  tokens_used: 0,
  tokens_packs_added: 0,
  metrics: {
    chats_total: 0,
    new_contacts: 0,
    quotes_requested: 0,
    quotes_sent: 0,
    no_stock: 0,
    intent_yes: 0,
    intent_no: 0,
    delivery_envio: 0,
    delivery_recoger: 0,
    closed_timeout: 0,
    night_leads: 0,
    sinpe_confirmed: 0,
  },
};

function tokensTotal() { return account.monthly_tokens + account.tokens_packs_added; }
function tokensRemaining() { return Math.max(0, tokensTotal() - account.tokens_used); }
function canConsumeToken() { return tokensRemaining() > 0; }

function consumeToken(reason = "INTENCION_SI") {
  if (!canConsumeToken()) return false;
  account.tokens_used += 1;
  console.log(`🪙 Ficha consumida (${reason}). Quedan: ${tokensRemaining()}`);
  return true;
}

function ensureMonthlyReset() {
  const key = currentMonthKey();
  if (account.month_key === key) return;
  
  account.month_key = key;
  account.tokens_used = 0;
  account.tokens_packs_added = 0;
  console.log(`🔄 Reset mensual: ${key}`);
}

/**
 * ============================
 *  PENDIENTES (para el dueño)
 * ============================
 */
const pendingQuotes = new Map();

function addPendingQuote(session) {
  pendingQuotes.set(session.waId, {
    waId: session.waId,
    details: session.last_details_text || "(sin detalle)",
    created_at: new Date().toISOString(),
  });
}

function removePendingQuote(waId) {
  pendingQuotes.delete(waId);
}

/**
 * ============================
 *  SESIONES
 * ============================
 */
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
      last_prefix: null,
      last_offer: null,
      delivery_method: null,
      pending_sinpe: null,
      shipping_details: null,
      sinpe_reference: null,
    });
    account.metrics.new_contacts += 1;
  }
  return sessions.get(waId);
}

function resetCloseTimer(session) {
  if (session.close_timer) clearTimeout(session.close_timer);
  if (session.reminder_timer) clearTimeout(session.reminder_timer);
  
  // PRO: Enviar recordatorio antes de cerrar
  if (PRO_REMINDER && session.state === "PRECIO_ENVIADO" && session.last_offer) {
    session.reminder_timer = setTimeout(async () => {
      if (session.state === "PRECIO_ENVIADO") {
        const price = session.last_offer?.price || 0;
        const shipping = session.last_offer?.shipping || 0;
        const total = price + shipping;
        
        await sendWhatsApp(session.waId, `Hola, ¿todavía estás interesad@ en el producto? 🙌\n\nPrecio: ₡${total.toLocaleString()}\n\nEstamos para servirte. Si querés, podés reenviar la foto.`);
      }
    }, CLOSE_AFTER_MS); // Recordatorio al tiempo del timeout
  }
  
  // Timer de cierre (después del recordatorio si PRO, o directo si BASIC)
  const closeDelay = PRO_REMINDER ? CLOSE_AFTER_MS + (60 * 60 * 1000) : CLOSE_AFTER_MS; // +1 hora después del recordatorio
  
  session.close_timer = setTimeout(() => {
    session.state = "CERRADO_TIMEOUT";
    removePendingQuote(session.waId);
    account.metrics.closed_timeout += 1;
    console.log(`⏱️ Timeout: ${session.waId}`);
    if (SESSIONS_PERSIST) saveSessionsToDisk();
  }, closeDelay);
}

function resetCase(session) {
  session.state = "ESPERANDO_DETALLES";
  session.last_image_id = null;
  session.last_details_text = null;
  session.sent_to_seller = false;
  session.last_offer = null;
  session.delivery_method = null;
  session.pending_sinpe = null;
  session.shipping_details = null;
  session.sinpe_reference = null;
  removePendingQuote(session.waId);
}

/**
 * ============================
 *  REFERENCIA SINPE
 * ============================
 */
function generateSinpeReference(waId) {
  const last4 = waId.slice(-4);
  const ts = Date.now().toString(36).slice(-4).toUpperCase();
  return `${last4}${ts}`;
}

/**
 * ============================
 *  RÁFAGA DE FOTOS
 *  Espera PHOTO_WAIT_SECONDS para detectar múltiples fotos
 * ============================
 */
function handlePhotoBuffer(waId, imageId, caption, callback) {
  let buffer = photoBuffers.get(waId);
  
  if (!buffer) {
    buffer = { photos: [], timer: null };
    photoBuffers.set(waId, buffer);
  }
  
  // Agregar foto al buffer
  buffer.photos.push({ imageId, caption });
  
  // Cancelar timer anterior
  if (buffer.timer) clearTimeout(buffer.timer);
  
  // Nuevo timer
  buffer.timer = setTimeout(() => {
    const photos = buffer.photos;
    photoBuffers.delete(waId);
    callback(photos);
  }, PHOTO_WAIT_SECONDS * 1000);
}

/**
 * ============================
 *  TIMEOUT VERIFICACIÓN SINPE (PRO)
 *  Espera SINPE_WAIT_MINUTES para detectar pago automático
 * ============================
 */
function startSinpeWaitTimer(waId, session) {
  // Cancelar timer anterior si existe
  if (sinpeWaitTimers.has(waId)) {
    clearTimeout(sinpeWaitTimers.get(waId));
  }
  
  const timer = setTimeout(async () => {
    sinpeWaitTimers.delete(waId);
    
    // Si todavía está esperando SINPE, no se detectó automáticamente
    if (session.state === "ESPERANDO_SINPE" && session.pending_sinpe?.status === "pending") {
      await notifyOwner(`⚠️ No se detectó SINPE automático

📱 ${waId}
🔑 Ref: ${session.sinpe_reference}
💵 ₡${session.pending_sinpe?.expectedAmount?.toLocaleString() || "?"}

Comprobar manual: ${waId} pagado`);
    }
  }, SINPE_WAIT_MINUTES * 60 * 1000);
  
  sinpeWaitTimers.set(waId, timer);
}

function cancelSinpeWaitTimer(waId) {
  if (sinpeWaitTimers.has(waId)) {
    clearTimeout(sinpeWaitTimers.get(waId));
    sinpeWaitTimers.delete(waId);
  }
}

/**
 * ============================
 *  FRASES TICAS ROTATIVAS
 * ============================
 */
const FRASES = {
  // Cuando el bot va a revisar disponibilidad
  revisando: [
    "Dame un toque, voy a revisar 👍",
    "Dejame chequearlo, ya te digo 👌",
    "Un momento, voy a fijarme 🙌",
    "Ya te confirmo, dame un ratito 😊",
    "Voy a revisar de una vez 👍",
  ],
  
  // Cuando pide talla/color/tamaño
  pidiendo_detalles: [
    "¿Qué talla, color o tamaño buscás?",
    "¿En qué talla o color lo ocupás?",
    "¿Qué talla, color o tamaño te interesa?",
    "Decime la talla, color o tamaño que buscás 👌",
    "¿Cuál talla, color o tamaño necesitás?",
  ],
  
  // Prefijos antes de pedir detalles
  prefijos: [
    "Déjame revisar 🙌",
    "Un toque y reviso 👌", 
    "Ya te confirmo 😊",
    "Con gusto te ayudo 🙌",
    "Claro que sí 👍",
  ],
  
  // Saludo inicial
  saludos: [
    "¡Hola! Pura vida 🙌",
    "¡Hola! ¿Cómo estás? 🙌",
    "¡Hola! Qué gusto 👋",
    "¡Buenas! Pura vida 🙌",
    "¡Hola! Con gusto te ayudo 😊",
  ],
  
  // Cuando sí hay producto
  si_hay: [
    "¡Sí lo tenemos! 🎉",
    "¡Claro que sí! Lo tenemos 🙌",
    "¡Sí hay! 🎉",
    "¡Afirmativo! Sí lo tenemos 👍",
    "¡Qué dicha, sí hay! 🙌",
  ],
  
  // Cuando el cliente confirma que quiere
  confirmacion: [
    "¡Buenísimo! 🙌",
    "¡Perfecto! 🎉",
    "¡Qué bien! 🙌",
    "¡Excelente! 👍",
    "¡Dale! 🙌",
  ],
  
  // Cuando el cliente no quiere
  no_quiere: [
    "Con gusto 🙌 Si ves algo más, mandame la foto.",
    "Está bien 🙌 Cualquier cosa aquí estamos.",
    "No hay problema 👍 Si ocupás algo, me avisás.",
    "Dale 🙌 Si te interesa otra cosa, con gusto.",
    "Perfecto 🙌 Aquí estamos para cuando gustés.",
  ],
  
  // No hay stock
  no_hay: [
    "Gracias por esperar 🙌 No tenemos ese producto ahora. Si querés, mandame foto de otro.",
    "Qué lástima 😔 Ese no lo tenemos. ¿Te interesa ver algo más?",
    "Uy, ese se nos agotó 🙌 ¿Querés ver otra opción?",
    "No lo tenemos disponible 😔 Pero si ves otro, con gusto te ayudo.",
  ],
  
  // Despedida/agradecimiento
  gracias: [
    "¡Gracias! 🙌",
    "¡Pura vida! 🙌", 
    "¡Gracias por la confianza! 💪",
    "¡Tuanis! 🙌",
    "¡Con mucho gusto! 😊",
  ],
  
  // Nocturno - anotado
  nocturno_anotado: [
    "¡Anotado! 🌙 Mañana temprano te confirmo. ¡Gracias!",
    "¡Listo! 🌙 Mañana te respondo primero. ¡Pura vida!",
    "¡Quedó anotado! 🌙 Mañana te confirmo disponibilidad.",
    "¡Perfecto! 🌙 Mañana a primera hora te digo.",
  ],
  
  // Pedir datos envío
  pedir_datos_envio: [
    "Perfecto, te lo enviamos 🚚",
    "¡Dale! Te lo mandamos 🚚",
    "¡Listo! Va para envío 🚚",
    "¡Perfecto! Lo enviamos 🚚",
  ],
  
  // Recoger en tienda
  recoger_tienda: [
    "Perfecto, lo apartamos para que lo recojás 🏪",
    "¡Dale! Te lo guardamos 🏪",
    "¡Listo! Lo tenemos apartado para vos 🏪",
    "¡Perfecto! Queda reservado 🏪",
  ],
};

// Función para obtener frase aleatoria
function frase(tipo) {
  const opciones = FRASES[tipo] || [""];
  return opciones[Math.floor(Math.random() * opciones.length)];
}

// Función para obtener frase sin repetir la última
const lastUsed = new Map();
function fraseNoRepetir(tipo, sessionId = "global") {
  const opciones = FRASES[tipo] || [""];
  const key = `${tipo}_${sessionId}`;
  const last = lastUsed.get(key) || "";
  const disponibles = opciones.filter(f => f !== last);
  const elegida = disponibles.length > 0 
    ? disponibles[Math.floor(Math.random() * disponibles.length)]
    : opciones[0];
  lastUsed.set(key, elegida);
  return elegida;
}

function msgAskDetails(waId) {
  return `${fraseNoRepetir("prefijos", waId)}\n${fraseNoRepetir("pidiendo_detalles", waId)}`;
}

function msgOutOfTokens() {
  return `⚠️ Se acabaron las fichas del mes 🙌\n\nPara seguir, activá un pack: ${PACK_TOKENS} fichas por ₡${PACK_PRICE_CRC}`;
}

function msgNightMode() {
  return `🌙 ${getTimeGreeting()}! A esta hora tenemos cerrada la bodega.\n\nSi te interesa algo, mandame la foto, talla, color o tamaño y mañana te respondemos 👌`;
}

/**
 * ============================
 *  DETECCIÓN DE DETALLES
 * ============================
 */
const COLORS = ["negro","blanco","rojo","azul","verde","gris","beige","café","morado","rosado","amarillo","naranja","plateado","dorado","celeste","vino"];

function hasSize(text) {
  const t = (text || "").toLowerCase();
  if (/\b(x{0,3}l|xxl|xl|xs|s|m|l)\b/i.test(t)) return true;
  if (t.includes("talla") || /\b(3[0-9]|4[0-9])\b/.test(t)) return true;
  if (t.includes("pequeñ") || t.includes("mediano") || t.includes("grande")) return true;
  return false;
}

function hasColor(text) {
  const t = (text || "").toLowerCase();
  return COLORS.some(c => t.includes(c));
}

function isMinimalDetail(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return false;
  
  // Si solo dice "disponible", "precio", "tienen?" NO es suficiente
  const genericOnly = t === "?" || 
         t === "precio" ||
         t === "precio?" ||
         t === "disponible" ||
         t === "disponible?" ||
         t === "tienen" ||
         t === "tienen?" ||
         t === "hay" ||
         t === "hay?" ||
         t === "info";
  
  if (genericOnly) return false;
  
  // Solo es válido si menciona talla, color o tamaño específico
  return hasSize(t) || hasColor(t);
}

function isGreeting(text) {
  const t = (text || "").toLowerCase();
  return ["hola","buenas","buenos dias","buen día"].some(k => t.includes(k));
}

function isYes(text) {
  const t = (text || "").trim().toLowerCase();
  return ["si","sí","sii","claro","lo quiero","dale","va","listo","ok","de una"].some(k => t === k || t.startsWith(k));
}

function isNo(text) {
  const t = (text || "").trim().toLowerCase();
  return ["no","nop","solo viendo","gracias","luego"].some(k => t === k || t.startsWith(k));
}

/**
 * ============================
 *  DETECTAR COMANDO DEL DUEÑO
 *  Formatos:
 *    506XXXX 5000        → precio
 *    506XXXX 5000-2000   → precio + envío
 *    506XXXX 0           → no hay
 *    506XXXX no          → no hay
 *    506XXXX pagado      → confirmar pago
 * ============================
 */
function parseOwnerCommand(text) {
  const t = (text || "").trim();
  const parts = t.split(/\s+/);
  
  if (parts.length < 2) return null;
  
  // Primer parte: número del cliente (8+ dígitos)
  const clientNum = parts[0].replace(/[^\d]/g, "");
  if (clientNum.length < 8) return null;
  
  const cmd = parts[1].toLowerCase();
  
  // Confirmar pago
  if (cmd === "pagado" || cmd === "pago" || cmd === "ok") {
    return { type: "PAGADO", clientWaId: clientNum };
  }
  
  // No hay stock
  if (cmd === "0" || cmd === "no" || cmd === "nohay" || cmd === "agotado") {
    return { type: "NO_HAY", clientWaId: clientNum };
  }
  
  // Precio: 5000 o 5000-2000
  const priceStr = parts[1].replace(/[^\d\-]/g, "");
  if (priceStr.includes("-")) {
    const [p, s] = priceStr.split("-");
    const price = Number(p);
    const shipping = Number(s);
    if (price > 0) {
      return { type: "PRECIO", clientWaId: clientNum, price, shipping: shipping > 0 ? shipping : null };
    }
  } else {
    const price = Number(priceStr);
    if (price > 0) {
      return { type: "PRECIO", clientWaId: clientNum, price, shipping: null };
    }
  }
  
  return null;
}

/**
 * ============================
 *  DETECTAR MÉTODO ENTREGA (cliente)
 *  SI = envío, NO = recoger
 * ============================
 */
function detectDeliveryMethod(text) {
  const t = (text || "").trim().toLowerCase();
  
  if (t.includes("envio") || t.includes("envío") || t === "si" || t === "sí") {
    return "envio";
  }
  if (t.includes("recoger") || t.includes("retiro") || t.includes("tienda") || t === "no") {
    return "recoger";
  }
  return null;
}

/**
 * ============================
 *  WHATSAPP API
 * ============================
 */
async function sendWhatsApp(toWaId, bodyText) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.log("📤 [SIM]", toWaId, ":", bodyText.slice(0, 80));
    return;
  }

  try {
    await fetch(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
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
  } catch (e) {
    console.log("⚠️ Error WhatsApp:", e?.message);
  }
}

/**
 * ============================
 *  NOTIFICAR AL DUEÑO (por WhatsApp)
 * ============================
 */
async function notifyOwner(message) {
  if (!OWNER_PHONE) {
    console.log("📢 [DUEÑO]:", message);
    return;
  }
  await sendWhatsApp(OWNER_PHONE, message);
}

async function notifyNewQuote(session) {
  const msg = `📦 Nueva consulta

📱 ${session.waId}
📝 ${session.last_details_text || "(sin detalle)"}

Respondé:
• ${session.waId} 5000 (precio)
• ${session.waId} 5000-2000 (precio+envío)
• ${session.waId} 0 (no hay)`;

  await notifyOwner(msg);
}

async function notifyIntentConfirmed(session) {
  const method = session.delivery_method === "recoger" ? "🏪 RECOGER" : "🚚 ENVÍO";
  const total = (session.last_offer?.price || 0) + (session.delivery_method === "envio" ? (session.last_offer?.shipping || 0) : 0);

  const msg = `✅ ¡Intención confirmada!

📱 ${session.waId}
💰 ₡${total.toLocaleString()}
📦 ${method}
${session.shipping_details ? `📍 ${session.shipping_details}` : ""}
🔑 Ref: ${session.sinpe_reference || "N/A"}`;

  await notifyOwner(msg);
}

async function notifyPaymentClaim(session) {
  const msg = `💰 Cliente dice que pagó

📱 ${session.waId}
🔑 Ref: ${session.sinpe_reference}
💵 ₡${session.pending_sinpe?.expectedAmount?.toLocaleString() || "?"}

Para confirmar: ${session.waId} pagado`;

  await notifyOwner(msg);
}

/**
 * ============================
 *  EXTRAER MENSAJE
 * ============================
 */
function extractMessage(payload) {
  try {
    const value = payload.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    const contact = value?.contacts?.[0];
    if (!msg) return null;

    let waId = (contact?.wa_id || msg.from || "").replace(/[^\d]/g, "");
    if (waId.length < 8 || waId.length > 15) return null;

    const type = msg.type;
    const text = type === "text" ? (msg.text?.body || "").trim() : "";
    const imageId = type === "image" ? (msg.image?.id || null) : null;
    const caption = type === "image" ? (msg.image?.caption || "").trim() : "";

    return { waId, type, text, imageId, caption };
  } catch {
    return null;
  }
}

/**
 * ============================
 *  ES EL DUEÑO?
 * ============================
 */
function isOwner(waId) {
  if (!OWNER_PHONE) return false;
  const ownerClean = OWNER_PHONE.replace(/[^\d]/g, "");
  return waId === ownerClean;
}

/**
 * ============================
 *  ENDPOINTS
 * ============================
 */
app.get("/", (req, res) => res.send("TICO-bot v4 ✅"));

app.get("/status", (req, res) => {
  ensureMonthlyReset();
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(403).send("Forbidden");

  return res.json({
    store: STORE_NAME,
    hour_cr: getCostaRicaHour(),
    is_daytime: isDaytime(),
    tokens: { total: tokensTotal(), used: account.tokens_used, remaining: tokensRemaining() },
    metrics: account.metrics,
    sessions: sessions.size,
    pending: pendingQuotes.size,
  });
});

app.get("/admin/inbox", (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(403).send("Forbidden");
  const list = Array.from(pendingQuotes.values());
  return res.json({ pending: list });
});

app.get("/admin/add-pack", (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(403).send("Forbidden");
  const packs = Math.max(1, Number(req.query.packs || 1));
  account.tokens_packs_added += packs * PACK_TOKENS;
  return res.json({ ok: true, remaining: tokensRemaining() });
});

/**
 * ============================
 *  WEBHOOK VERIFICACIÓN
 * ============================
 */
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

/**
 * ============================
 *  WEBHOOK MENSAJES
 * ============================
 */
app.post("/webhook", async (req, res) => {
  ensureMonthlyReset();

  const msg = extractMessage(req.body);
  if (!msg) return res.sendStatus(200);

  const { waId, type, text, imageId, caption } = msg;
  
  console.log("📩", { waId, type, text: text?.slice(0, 40), isOwner: isOwner(waId) });

  // ============================================
  // MENSAJE DEL DUEÑO (comandos)
  // ============================================
  if (isOwner(waId)) {
    const cmd = parseOwnerCommand(text);
    
    if (!cmd) {
      // No es comando válido, mostrar pendientes
      if (pendingQuotes.size === 0) {
        await sendWhatsApp(waId, "📭 No hay consultas pendientes.");
      } else {
        let list = "📋 Pendientes:\n\n";
        for (const p of pendingQuotes.values()) {
          list += `📱 ${p.waId}\n📝 ${p.details}\n\n`;
        }
        list += "Respondé: [número] [precio] o [número] 0";
        await sendWhatsApp(waId, list);
      }
      return res.sendStatus(200);
    }

    const clientSession = sessions.get(cmd.clientWaId);
    if (!clientSession) {
      await sendWhatsApp(waId, `⚠️ No encontré cliente ${cmd.clientWaId}`);
      return res.sendStatus(200);
    }

    // PRECIO
    if (cmd.type === "PRECIO") {
      account.metrics.quotes_sent += 1;
      clientSession.state = "PRECIO_ENVIADO";
      clientSession.last_offer = { price: cmd.price, shipping: cmd.shipping };
      removePendingQuote(cmd.clientWaId);

      const shipText = cmd.shipping ? ` (+ envío ₡${cmd.shipping.toLocaleString()})` : "";
      
      await sendWhatsApp(cmd.clientWaId, 
        `${frase("si_hay")}\n\nPrecio: ₡${cmd.price.toLocaleString()}${shipText}\n\n¿Te interesa?\n👉 SI = Lo quiero\n👉 NO = Solo viendo`
      );
      await sendWhatsApp(waId, `✅ Precio enviado a ${cmd.clientWaId}`);
      
      if (SESSIONS_PERSIST) saveSessionsToDisk();
      return res.sendStatus(200);
    }

    // NO HAY
    if (cmd.type === "NO_HAY") {
      account.metrics.no_stock += 1;
      clientSession.state = "CERRADO_SIN_STOCK";
      removePendingQuote(cmd.clientWaId);

      await sendWhatsApp(cmd.clientWaId, fraseNoRepetir("no_hay", cmd.clientWaId));
      await sendWhatsApp(waId, `❌ Sin stock notificado a ${cmd.clientWaId}`);
      
      if (SESSIONS_PERSIST) saveSessionsToDisk();
      return res.sendStatus(200);
    }

    // PAGADO
    if (cmd.type === "PAGADO") {
      if (clientSession.state !== "ESPERANDO_SINPE") {
        await sendWhatsApp(waId, `⚠️ ${cmd.clientWaId} no está esperando pago.`);
        return res.sendStatus(200);
      }

      clientSession.pending_sinpe.status = "paid";
      clientSession.state = "PAGO_CONFIRMADO";
      account.metrics.sinpe_confirmed += 1;
      
      // Cancelar timer de espera
      cancelSinpeWaitTimer(cmd.clientWaId);

      await sendWhatsApp(cmd.clientWaId, `¡Listo! 🙌 Pago confirmado. ${frase("gracias")} Ya coordinamos tu pedido.`);
      await sendWhatsApp(waId, `✅ Pago confirmado para ${cmd.clientWaId}`);
      
      if (SESSIONS_PERSIST) saveSessionsToDisk();
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  }

  // ============================================
  // MENSAJE DE CLIENTE
  // ============================================
  account.metrics.chats_total += 1;
  const session = getSession(waId);
  session.last_activity = Date.now();
  
  // Si la conversación estaba abandonada, se toma como chat nuevo (sin costo)
  if (session.state === "CERRADO_TIMEOUT" || session.state === "CERRADO_SIN_INTERES" || session.state === "CERRADO_SIN_STOCK") {
    session.state = "NEW";
    resetCase(session);
    console.log(`🔄 Nuevo chat (cliente volvió): ${waId}`);
  }
  
  resetCloseTimer(session);

  const isNight = !isDaytime();

  // ---- MODO NOCTURNO ----
  if (isNight) {
    if (type === "text" && isGreeting(text)) {
      await sendWhatsApp(waId, msgNightMode());
      return res.sendStatus(200);
    }

    if (type === "image") {
      resetCase(session);
      session.last_image_id = imageId;
      const cap = (caption || "").trim();

      // Solo si tiene talla/color/tamaño específico, pasa directo
      if (cap && isMinimalDetail(cap)) {
        session.last_details_text = cap;
        session.state = "LEAD_NOCTURNO";
        account.metrics.night_leads += 1;
        addPendingQuote(session);
        
        await sendWhatsApp(waId, fraseNoRepetir("nocturno_anotado", waId));
        await notifyNewQuote(session);
        if (SESSIONS_PERSIST) saveSessionsToDisk();
        return res.sendStatus(200);
      }

      // Si no tiene detalles específicos, preguntar
      session.state = "ESPERANDO_DETALLES_NOCHE";
      await sendWhatsApp(waId, `🌙 ¡Gracias! ${fraseNoRepetir("pidiendo_detalles", waId)}`);
      return res.sendStatus(200);
    }

    if (type === "text" && session.state === "ESPERANDO_DETALLES_NOCHE" && session.last_image_id) {
      if (isMinimalDetail(text)) {
        session.last_details_text = text;
        session.state = "LEAD_NOCTURNO";
        account.metrics.night_leads += 1;
        addPendingQuote(session);
        
        await sendWhatsApp(waId, fraseNoRepetir("nocturno_anotado", waId));
        await notifyNewQuote(session);
        if (SESSIONS_PERSIST) saveSessionsToDisk();
        return res.sendStatus(200);
      }
      await sendWhatsApp(waId, `🌙 Solo ocupo: ${fraseNoRepetir("pidiendo_detalles", waId)}`);
      return res.sendStatus(200);
    }

    await sendWhatsApp(waId, msgNightMode());
    return res.sendStatus(200);
  }

  // ---- MODO DIURNO ----

  // Nueva foto cuando ya tenía precio
  if (type === "image" && session.state === "PRECIO_ENVIADO") {
    resetCase(session);
    session.last_image_id = imageId;
    const cap = (caption || "").trim();

    await sendWhatsApp(waId, `¡Pura vida! 🙌 ¿Ese otro te interesa? Decime talla, color o tamaño.`);

    if (cap && isMinimalDetail(cap)) {
      session.last_details_text = cap;
      session.sent_to_seller = true;
      session.state = "ENVIADO_A_VENDEDOR";
      account.metrics.quotes_requested += 1;
      addPendingQuote(session);
      await notifyNewQuote(session);
    }
    if (SESSIONS_PERSIST) saveSessionsToDisk();
    return res.sendStatus(200);
  }

  // Saludo
  if (type === "text" && isGreeting(text)) {
    if (!session.catalog_sent && CATALOG_URL) {
      session.catalog_sent = true;
      await sendWhatsApp(waId, `${fraseNoRepetir("saludos", waId)}\n\nCatálogo: ${CATALOG_URL}\n\nSi algo te gusta, mandame la foto y decime talla/color/tamaño 👌`);
    } else {
      await sendWhatsApp(waId, `${fraseNoRepetir("saludos", waId)} Mandame la foto del producto y decime talla, color o tamaño.`);
    }
    return res.sendStatus(200);
  }

  // Foto - usar buffer para detectar ráfaga
  if (type === "image") {
    handlePhotoBuffer(waId, imageId, caption, async (photos) => {
      const session = getSession(waId);
      
      // Si hay múltiples fotos, pedir una por una
      if (photos.length > 1) {
        await sendWhatsApp(waId, `Vi que mandaste varias fotos 🙌 Para darte precio exacto, mandame una por una con la talla/color que buscás de cada una.`);
        return;
      }
      
      // Una sola foto - flujo normal
      const photo = photos[0];
      resetCase(session);
      session.last_image_id = photo.imageId;
      const cap = (photo.caption || "").trim();

      if (cap && isMinimalDetail(cap)) {
        session.last_details_text = cap;
        session.sent_to_seller = true;
        session.state = "ENVIADO_A_VENDEDOR";
        account.metrics.quotes_requested += 1;

        await sendWhatsApp(waId, fraseNoRepetir("revisando", waId));
        addPendingQuote(session);
        await notifyNewQuote(session);
        if (SESSIONS_PERSIST) saveSessionsToDisk();
        return;
      }

      session.state = "ESPERANDO_DETALLES";
      await sendWhatsApp(waId, msgAskDetails(waId));
      if (SESSIONS_PERSIST) saveSessionsToDisk();
    });
    
    return res.sendStatus(200);
  }

  // Texto
  if (type === "text") {

    // PRECIO_ENVIADO: cliente dice SI/NO
    if (session.state === "PRECIO_ENVIADO") {
      if (isYes(text)) {
        if (!consumeToken("INTENCION_SI")) {
          await sendWhatsApp(waId, msgOutOfTokens());
          return res.sendStatus(200);
        }

        account.metrics.intent_yes += 1;

        if (STORE_TYPE === "fisica") {
          session.state = "ESPERANDO_METODO";
          await sendWhatsApp(waId, `${frase("confirmacion")}\n\n¿Cómo lo querés?\n👉 SI = Envío\n👉 NO = Recoger en tienda`);
        } else {
          session.state = "PIDIENDO_DATOS";
          session.delivery_method = "envio";
          await sendWhatsApp(waId, `${frase("confirmacion")}\n\nPara enviártelo, pasame los datos así:\n\n📍 Provincia:\n📍 Cantón:\n📍 Distrito:\n📍 Otras señas:\n📞 Teléfono:\n\n(Podés escribirlo todo en un solo mensaje)`);
        }
        if (SESSIONS_PERSIST) saveSessionsToDisk();
        return res.sendStatus(200);
      }

      if (isNo(text)) {
        account.metrics.intent_no += 1;
        session.state = "CERRADO_SIN_INTERES";
        await sendWhatsApp(waId, fraseNoRepetir("no_quiere", waId));
        return res.sendStatus(200);
      }

      await sendWhatsApp(waId, `¿Te interesa? Escribí SI o NO 🙌`);
      return res.sendStatus(200);
    }

    // ESPERANDO_METODO: SI=envío, NO=recoger
    if (session.state === "ESPERANDO_METODO") {
      const method = detectDeliveryMethod(text);

      if (method === "envio") {
        session.delivery_method = "envio";
        session.state = "PIDIENDO_DATOS";
        account.metrics.delivery_envio += 1;
        await sendWhatsApp(waId, `${frase("pedir_datos_envio")}\n\nPasame los datos así:\n\n📍 Provincia:\n📍 Cantón:\n📍 Distrito:\n📍 Otras señas:\n📞 Teléfono:\n\n(Podés escribirlo todo en un solo mensaje)`);
        return res.sendStatus(200);
      }

      if (method === "recoger") {
        session.delivery_method = "recoger";
        account.metrics.delivery_recoger += 1;

        const price = session.last_offer?.price || 0;
        const ref = generateSinpeReference(waId);
        session.sinpe_reference = ref;
        session.state = "ESPERANDO_SINPE";
        session.pending_sinpe = { expectedAmount: price, status: "pending", created_ms: Date.now() };

        const sinpe = SINPE_NUMBER ? `💳 SINPE: ${SINPE_NUMBER}${SINPE_NAME ? ` (${SINPE_NAME})` : ""}` : "";
        
        // Dirección de la tienda
        let ubicacion = "";
        if (STORE_ADDRESS) {
          ubicacion = `\n\n📍 Dirección: ${STORE_ADDRESS}`;
          if (MAPS_URL) {
            ubicacion += `\n🗺️ Mapa: ${MAPS_URL}`;
          }
        }

        await sendWhatsApp(waId, `${frase("recoger_tienda")}\n\nTotal: ₡${price.toLocaleString()}\n\n${sinpe}\n\n⚠️ Poné de descripción: ${ref}${ubicacion}\n\nCuando pagues, escribí "listo" y coordinamos la hora 👌`);
        await notifyIntentConfirmed(session);
        if (SESSIONS_PERSIST) saveSessionsToDisk();
        return res.sendStatus(200);
      }

      await sendWhatsApp(waId, `¿Cómo lo preferís?\n👉 SI = Envío\n👉 NO = Recoger`);
      return res.sendStatus(200);
    }

    // PIDIENDO_DATOS: recibir dirección
    if (session.state === "PIDIENDO_DATOS") {
      session.shipping_details = text.trim();

      const price = session.last_offer?.price || 0;
      const ship = session.last_offer?.shipping || 0;
      const total = price + ship;
      const ref = generateSinpeReference(waId);
      
      session.sinpe_reference = ref;
      session.state = "ESPERANDO_SINPE";
      session.pending_sinpe = { expectedAmount: total, status: "pending", created_ms: Date.now() };

      const sinpe = SINPE_NUMBER ? `💳 SINPE: ${SINPE_NUMBER}${SINPE_NAME ? ` (${SINPE_NAME})` : ""}` : "";
      const shipText = ship > 0 ? `\nEnvío: ₡${ship.toLocaleString()}` : "";

      await sendWhatsApp(waId, `¡Perfecto! 🙌\n\nProducto: ₡${price.toLocaleString()}${shipText}\nTotal: ₡${total.toLocaleString()}\n\n${sinpe}\n\n⚠️ Poné de descripción: ${ref}\n\nCuando pagues, escribí "listo" 👌`);
      await notifyIntentConfirmed(session);
      if (SESSIONS_PERSIST) saveSessionsToDisk();
      return res.sendStatus(200);
    }

    // ESPERANDO_SINPE: cliente avisa que pagó
    if (session.state === "ESPERANDO_SINPE") {
      const low = text.toLowerCase();
      if (low.includes("listo") || low.includes("ya") || low.includes("pagu") || low.includes("hice") || low.includes("transferí")) {
        await sendWhatsApp(waId, `¡Gracias! 🙌 Verificando...`);
        await notifyPaymentClaim(session);
        
        // PRO: Iniciar timer para verificación automática
        if (SINPE_SMS_SECRET) {
          startSinpeWaitTimer(waId, session);
        }
        
        return res.sendStatus(200);
      }
    }

    // Después de foto: esperar detalle
    if (session.last_image_id && !session.sent_to_seller) {
      if (isMinimalDetail(text)) {
        session.last_details_text = text;
        session.sent_to_seller = true;
        session.state = "ENVIADO_A_VENDEDOR";
        account.metrics.quotes_requested += 1;

        await sendWhatsApp(waId, fraseNoRepetir("revisando", waId));
        addPendingQuote(session);
        await notifyNewQuote(session);
        if (SESSIONS_PERSIST) saveSessionsToDisk();
        return res.sendStatus(200);
      }

      await sendWhatsApp(waId, msgAskDetails(waId));
      return res.sendStatus(200);
    }

    // FAQ
    const low = text.toLowerCase();
    if (low.includes("horario")) {
      await sendWhatsApp(waId, `🕘 Horario: ${HOURS_DAY}`);
      return res.sendStatus(200);
    }
    if (low.includes("ubic") || low.includes("donde")) {
      if (STORE_TYPE === "fisica" && MAPS_URL) {
        await sendWhatsApp(waId, `📍 ${MAPS_URL}`);
      } else {
        await sendWhatsApp(waId, `Somos tienda virtual 🙌 Mandame la foto y te ayudo.`);
      }
      return res.sendStatus(200);
    }
    if (low.includes("precio") || low.includes("cuanto")) {
      await sendWhatsApp(waId, `Mandame la foto del producto y decime talla/color/tamaño 🙌`);
      return res.sendStatus(200);
    }

    // Default
    await sendWhatsApp(waId, `Dale 🙌 Mandame la foto y decime talla, color o tamaño.`);
    return res.sendStatus(200);
  }

  return res.sendStatus(200);
});

/**
 * ============================
 *  SINPE SMS (PRO)
 * ============================
 */
app.post("/sinpe-sms", async (req, res) => {
  try {
    if (!SINPE_SMS_SECRET || req.headers["x-sinpe-secret"] !== SINPE_SMS_SECRET) {
      return res.status(403).send("Forbidden");
    }

    const body = String(req.body?.body || "");
    const amountMatch = body.match(/(\d[\d.,]+)\s*Colones/i);
    const amount = amountMatch ? Number(amountMatch[1].replace(/,/g, "")) : null;
    
    const refMatch = body.match(/(?:Descripci[oó]n|Detalle)[\s:]+([A-Z0-9]{6,12})/i);
    const ref = refMatch ? refMatch[1].toUpperCase() : null;

    if (!amount) return res.json({ ok: true, matched: false });

    // Buscar por referencia
    if (ref) {
      for (const s of sessions.values()) {
        if (s?.state === "ESPERANDO_SINPE" && s?.sinpe_reference === ref) {
          s.pending_sinpe.status = "paid";
          s.state = "PAGO_CONFIRMADO";
          account.metrics.sinpe_confirmed += 1;
          
          // Cancelar timer de espera
          cancelSinpeWaitTimer(s.waId);

          await sendWhatsApp(s.waId, `¡Listo! 🙌 Recibimos tu pago. ¡Gracias!`);
          await notifyOwner(`💰 Pago confirmado automático: ${s.waId} - ₡${amount.toLocaleString()}`);
          if (SESSIONS_PERSIST) saveSessionsToDisk();
          return res.json({ ok: true, matched: true, waId: s.waId });
        }
      }
    }

    // Buscar por monto
    const lookback = Date.now() - SINPE_SMS_LOOKBACK_MIN * 60 * 1000;
    const candidates = [];
    for (const s of sessions.values()) {
      if (s?.state === "ESPERANDO_SINPE" && s?.pending_sinpe?.status === "pending") {
        if ((s.pending_sinpe.created_ms || 0) < lookback) continue;
        if (s.pending_sinpe.expectedAmount === amount) candidates.push(s);
      }
    }

    if (candidates.length === 1) {
      const s = candidates[0];
      s.pending_sinpe.status = "paid";
      s.state = "PAGO_CONFIRMADO";
      account.metrics.sinpe_confirmed += 1;
      
      // Cancelar timer de espera
      cancelSinpeWaitTimer(s.waId);

      await sendWhatsApp(s.waId, `¡Listo! 🙌 Recibimos tu pago. ¡Gracias!`);
      await notifyOwner(`💰 Pago confirmado automático: ${s.waId} - ₡${amount.toLocaleString()}`);
      if (SESSIONS_PERSIST) saveSessionsToDisk();
      return res.json({ ok: true, matched: true, waId: s.waId });
    }

    return res.json({ ok: true, matched: false, candidates: candidates.length });
  } catch (e) {
    console.log("❌ sinpe-sms error:", e?.message);
    return res.sendStatus(200);
  }
});

/**
 * ============================
 *  SERVER
 * ============================
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 TICO-bot v4 | Puerto ${PORT}`);
  console.log(`⏰ CR: ${getCostaRicaHour()}h | ${isDaytime() ? "☀️ DÍA" : "🌙 NOCHE"}`);
  console.log(`👤 Dueño: ${OWNER_PHONE || "(no configurado)"}`);
});

process.on("SIGTERM", () => {
  if (SESSIONS_PERSIST) saveSessionsToDisk();
  process.exit(0);
});








