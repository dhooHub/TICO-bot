
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

// FAQ Configurables
const SHIPPING_GAM = process.env.SHIPPING_GAM || "₡2,500";
const SHIPPING_RURAL = process.env.SHIPPING_RURAL || "₡3,500";
const DELIVERY_DAYS = process.env.DELIVERY_DAYS || "8 días hábiles";
const WARRANTY_DAYS = process.env.WARRANTY_DAYS || "30 días contra defectos de fábrica";
const NO_PHOTOS_MSG = process.env.NO_PHOTOS_MSG || "";  // Respuesta personalizada cuando piden fotos

// Plan / Fichas
const MONTHLY_TOKENS = Number(process.env.MONTHLY_TOKENS || 100);
const PACK_TOKENS = Number(process.env.PACK_TOKENS || 10);
const PACK_PRICE_CRC = Number(process.env.PACK_PRICE_CRC || 1000);

// Admin
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const BASE_URL = process.env.BASE_URL || "";

// OpenAI (IA conversacional)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

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
      client_zone: null,
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
  session.client_zone = null;
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
 *    506XXXX pausa       → pausar bot para ese cliente
 *    506XXXX bot         → reanudar bot para ese cliente
 *    506XXXX cat         → enviar catálogo al cliente
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
  
  // PAUSA - desactivar bot para ese cliente
  if (cmd === "pausa" || cmd === "pausar" || cmd === "stop") {
    return { type: "PAUSA", clientWaId: clientNum };
  }
  
  // BOT - reanudar bot para ese cliente
  if (cmd === "bot" || cmd === "reanudar" || cmd === "activar") {
    return { type: "REANUDAR", clientWaId: clientNum };
  }
  
  // CAT - enviar catálogo al cliente
  if (cmd === "cat" || cmd === "catalogo" || cmd === "catálogo") {
    return { type: "CATALOGO", clientWaId: clientNum };
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
 *  IA CONVERSACIONAL (OpenAI)
 * ============================
 */

// IA para interpretar mensajes del DUEÑO
async function aiInterpretOwner(text, pendingClients) {
  if (!OPENAI_API_KEY) return null;
  
  const pendingList = pendingClients.length > 0 
    ? pendingClients.map(p => p.waId).join(", ")
    : "ninguno";
  
  const prompt = `Sos un intérprete de comandos para un sistema de ventas WhatsApp.
El vendedor escribe mensajes informales y vos los convertís a comandos.

Clientes pendientes de respuesta: ${pendingList}
${pendingClients.length === 1 ? `(Si no menciona número, asumí que es para: ${pendingClients[0].waId})` : ""}

El vendedor escribió: "${text}"

Interpretá y respondé SOLO en JSON:
{
  "comando": "PRECIO|NO_HAY|PAGADO|PAUSA|REANUDAR|CATALOGO|SALDO|AYUDA|NONE",
  "cliente": "número del cliente o null",
  "precio": número o null,
  "envio": número o null,
  "mensaje_directo": "si quiere mandar mensaje directo al cliente, ponerlo aquí, sino null"
}

Ejemplos:
- "si hay 12 mil" → {"comando":"PRECIO","cliente":"${pendingClients[0]?.waId || "50688881234"}","precio":12000,"envio":null,"mensaje_directo":null}
- "15000 con envío 2500" → {"comando":"PRECIO","cliente":"...","precio":15000,"envio":2500,"mensaje_directo":null}
- "no tengo" o "agotado" → {"comando":"NO_HAY","cliente":"...","precio":null,"envio":null,"mensaje_directo":null}
- "ya pagó" o "confirmado" → {"comando":"PAGADO","cliente":"...","precio":null,"envio":null,"mensaje_directo":null}
- "yo le hablo" o "pausa" → {"comando":"PAUSA","cliente":"...","precio":null,"envio":null,"mensaje_directo":null}
- "activar bot" → {"comando":"REANUDAR","cliente":"...","precio":null,"envio":null,"mensaje_directo":null}
- "mandále el catálogo" → {"comando":"CATALOGO","cliente":"...","precio":null,"envio":null,"mensaje_directo":null}
- "cuántas fichas tengo" → {"comando":"SALDO","cliente":null,"precio":null,"envio":null,"mensaje_directo":null}
- "decile que mañana le confirmo" → {"comando":"NONE","cliente":"...","precio":null,"envio":null,"mensaje_directo":"Mañana te confirmo 🙌"}

Solo respondé el JSON, nada más.`;

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 200
      })
    });

    if (!resp.ok) {
      console.log("⚠️ OpenAI error:", resp.status);
      return null;
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || "";
    
    // Limpiar y parsear JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return null;
  } catch (e) {
    console.log("⚠️ AI Owner error:", e?.message);
    return null;
  }
}

// IA para generar respuestas al CLIENTE
async function aiDraftReply(waId, text, session, hasImage) {
  if (!OPENAI_API_KEY) return null;

  const stateDescriptions = {
    "NEW": "Cliente nuevo, primera interacción",
    "ESPERANDO_DETALLES": "Esperando que diga talla/color/tamaño",
    "ESPERANDO_RESPUESTA_DUENO": "Esperando que el dueño confirme precio",
    "ESPERANDO_ZONA": "Esperando que diga de dónde es para calcular envío",
    "PRECIO_ENVIADO": "Ya le mandamos precio, esperando SI/NO",
    "ESPERANDO_METODO": "Esperando si quiere ENVÍO o RECOGER",
    "ESPERANDO_DATOS_ENVIO": "Esperando dirección completa",
    "ESPERANDO_SINPE": "Esperando que pague por SINPE",
    "LEAD_NOCTURNO": "Es de noche, ya le dijimos que mañana contactamos"
  };

  const systemPrompt = `Sos un asistente de ventas para una tienda en Costa Rica. Hablás español tico natural.

REGLAS ESTRICTAS:
- NUNCA inventés precios ni confirmés stock
- NUNCA digás "el precio es X" a menos que esté en last_offer
- Si falta talla/color: pedilo en UNA pregunta corta
- Si pide precio sin foto: pedí foto/captura del producto
- Máximo 2 líneas, 1 emoji máximo
- Usá expresiones ticas (pura vida, mae, un toque) pero sin exagerar
- Sé amable pero directo

TIENDA:
- Nombre: ${STORE_NAME}
- Tipo: ${STORE_TYPE}
- Catálogo: ${CATALOG_URL || "no configurado"}
- Horario: ${HOURS_DAY}

Respondé SOLO en JSON:
{
  "reply": "texto para el cliente (máx 2 líneas)",
  "action": "REPLY|ASK_DETAILS|ASK_PHOTO|WAIT_OWNER|ESCALATE",
  "detected_details": "talla/color detectados o null"
}`;

  const userContext = {
    mensaje_cliente: text || (hasImage ? "[envió una imagen]" : "[vacío]"),
    tiene_imagen: hasImage,
    estado_actual: session?.state || "NEW",
    estado_descripcion: stateDescriptions[session?.state] || "Desconocido",
    ultimo_precio: session?.last_offer || null,
    detalles_previos: session?.last_details_text || null,
    metodo_entrega: session?.delivery_method || null
  };

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(userContext) }
        ],
        temperature: 0.4,
        max_tokens: 200
      })
    });

    if (!resp.ok) {
      console.log("⚠️ OpenAI error:", resp.status);
      return null;
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || "";
    
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return null;
  } catch (e) {
    console.log("⚠️ AI Client error:", e?.message);
    return null;
  }
}

// IA para clasificar preguntas FAQ del cliente
async function aiClassifyFAQ(text) {
  if (!OPENAI_API_KEY) return null;

  const prompt = `Clasificá esta pregunta de un cliente en Costa Rica.

Pregunta: "${text}"

Categorías posibles:
- HORARIO (hora de atención, cuándo abren/cierran, días)
- UBICACION (dónde están, dirección, cómo llegar)
- METODO_PAGO (tarjeta, efectivo, SINPE, cómo pagar)
- COSTO_ENVIO (cuánto cuesta el envío, precio de envío)
- ZONA_ENVIO (si hacen envíos, a dónde envían, cobertura)
- TIEMPO_ENTREGA (cuánto tarda, cuándo llega, días de entrega)
- GARANTIA (cambios, devoluciones, garantía, si no queda)
- CATALOGO (qué tienen, mostrar productos, ver fotos, catálogo)
- SINPE_INFO (número de SINPE, a dónde pagar)
- PRECIO_SIN_FOTO (pregunta precio pero no ha mandado foto)
- SALUDO (hola, buenas, buenos días)
- OTRO (no encaja en ninguna)

Respondé SOLO con la categoría, nada más. Ejemplo: HORARIO`;

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 20
      })
    });

    if (!resp.ok) return null;

    const data = await resp.json();
    const category = (data.choices?.[0]?.message?.content || "").trim().toUpperCase();
    
    const validCategories = ["HORARIO", "UBICACION", "METODO_PAGO", "COSTO_ENVIO", "ZONA_ENVIO", 
                            "TIEMPO_ENTREGA", "GARANTIA", "CATALOGO", "SINPE_INFO", "PRECIO_SIN_FOTO", "SALUDO", "OTRO"];
    
    return validCategories.includes(category) ? category : null;
  } catch (e) {
    console.log("⚠️ AI FAQ error:", e?.message);
    return null;
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

📱 Cliente: ${session.waId}
📝 ${session.last_details_text || "(sin detalle)"}

━━━━━━━━━━━━━━━
COPIAR Y RESPONDER:

${session.waId} 5000
(cambiar 5000 por el precio)

${session.waId} 0
(si no hay stock)
━━━━━━━━━━━━━━━`;

  await notifyOwner(msg);
}

async function notifyIntentConfirmed(session) {
  const method = session.delivery_method === "recoger" ? "🏪 RECOGER" : "🚚 ENVÍO";
  const total = (session.last_offer?.price || 0) + (session.delivery_method === "envio" ? (session.last_offer?.shipping || 0) : 0);

  const msg = `🎯 ¡INTENCIÓN CONFIRMADA!

📱 Cliente: ${session.waId}
💰 Total: ₡${total.toLocaleString()}
📦 Método: ${method}
${session.shipping_details ? `📍 Datos: ${session.shipping_details}` : ""}

Esperando comprobante SINPE...`;

  await notifyOwner(msg);
}

async function notifyPaymentClaim(session) {
  const msg = `💰 ¡CLIENTE DICE QUE PAGÓ!

📱 Cliente: ${session.waId}
💵 Monto: ₡${session.pending_sinpe?.expectedAmount?.toLocaleString() || "?"}
📦 Método: ${session.delivery_method === "recoger" ? "🏪 RECOGER" : "🚚 ENVÍO"}
${session.shipping_details ? `📍 Datos: ${session.shipping_details}` : ""}

━━━━━━━━━━━━━━━
VERIFICAR Y RESPONDER:

${session.waId} pagado
━━━━━━━━━━━━━━━`;

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
    const lowText = (text || "").toLowerCase().trim();
    
    // Comando SALDO
    if (lowText === "saldo" || lowText === "fichas") {
      const remaining = tokensRemaining();
      const used = account.tokens_used;
      const total = tokensTotal();
      await sendWhatsApp(waId, `📊 Tu saldo TICO-bot\n\n🎟️ Fichas: ${remaining} de ${total}\n📈 Usadas: ${used}\n\n${remaining < 20 ? "⚠️ Te quedan pocas fichas" : "✅ Vas bien"}`);
      return res.sendStatus(200);
    }
    
    // Comando AYUDA
    if (lowText === "ayuda" || lowText === "help" || lowText === "comandos") {
      await sendWhatsApp(waId, `🤖 *Comandos TICO-bot*

━━━━━━━━━━━━━━━
*RESPONDER CONSULTAS:*
\`50688881234 5000\` = Enviar precio
\`50688881234 0\` = No hay stock

*CONFIRMAR PAGO:*
\`50688881234 pagado\` = Confirmar SINPE

*CONTROL DEL BOT:*
\`50688881234 pausa\` = Hablar vos directo
\`50688881234 bot\` = Reactivar bot
\`50688881234 cat\` = Enviar catálogo

*OTROS:*
\`saldo\` = Ver fichas restantes
\`ayuda\` = Ver estos comandos
━━━━━━━━━━━━━━━`);
      return res.sendStatus(200);
    }
    
    const cmd = parseOwnerCommand(text);
    
    // Si no es comando directo, intentar con IA
    if (!cmd && OPENAI_API_KEY) {
      const pendingList = Array.from(pendingQuotes.values());
      const aiResult = await aiInterpretOwner(text, pendingList);
      
      if (aiResult && aiResult.comando !== "NONE") {
        console.log("🤖 IA interpretó:", aiResult);
        
        // Convertir resultado de IA a comando interno
        if (aiResult.comando === "SALDO") {
          const remaining = tokensRemaining();
          const used = account.tokens_used;
          const total = tokensTotal();
          await sendWhatsApp(waId, `📊 Tu saldo TICO-bot\n\n🎟️ Fichas: ${remaining} de ${total}\n📈 Usadas: ${used}\n\n${remaining < 20 ? "⚠️ Te quedan pocas fichas" : "✅ Vas bien"}`);
          return res.sendStatus(200);
        }
        
        if (aiResult.comando === "AYUDA") {
          await sendWhatsApp(waId, `🤖 *TICO-bot*\n\nSolo escribí natural:\n• "sí hay 12 mil"\n• "no tengo"\n• "ya pagó"\n• "yo le hablo" (pausa)\n• "activar bot"\n• "mandá catálogo"\n\nO usá comandos:\n• 50688881234 5000\n• 50688881234 0\n• saldo\n• ayuda`);
          return res.sendStatus(200);
        }
        
        // Para comandos que necesitan cliente
        let clientWaId = aiResult.cliente;
        
        // Si no especificó cliente y hay solo uno pendiente, usar ese
        if (!clientWaId && pendingList.length === 1) {
          clientWaId = pendingList[0].waId;
        }
        
        // Si quiere mandar mensaje directo
        if (aiResult.mensaje_directo && clientWaId) {
          const clientSession = sessions.get(clientWaId);
          if (clientSession) {
            await sendWhatsApp(clientWaId, aiResult.mensaje_directo);
            await sendWhatsApp(waId, `✅ Mensaje enviado a ${clientWaId}`);
            return res.sendStatus(200);
          }
        }
        
        if (clientWaId) {
          const clientSession = sessions.get(clientWaId);
          if (!clientSession) {
            await sendWhatsApp(waId, `⚠️ No encontré cliente ${clientWaId}`);
            return res.sendStatus(200);
          }
          
          // PRECIO
          if (aiResult.comando === "PRECIO" && aiResult.precio) {
            account.metrics.quotes_sent += 1;
            removePendingQuote(clientWaId);
            
            if (aiResult.envio) {
              // Con envío incluido
              clientSession.state = "PRECIO_TOTAL_ENVIADO";
              clientSession.last_offer = { price: aiResult.precio, shipping: aiResult.envio };
              const total = aiResult.precio + aiResult.envio;
              
              await sendWhatsApp(clientWaId, 
                `${frase("si_hay")}\n\nProducto: ₡${aiResult.precio.toLocaleString()}\nEnvío: ₡${aiResult.envio.toLocaleString()}\nTotal: ₡${total.toLocaleString()}\n\n¿Te interesa? 🙌`
              );
              await sendWhatsApp(waId, `✅ Precio ₡${total.toLocaleString()} enviado a ${clientWaId}`);
            } else {
              // Solo precio, pedir zona
              clientSession.state = "ESPERANDO_ZONA";
              clientSession.last_offer = { price: aiResult.precio, shipping: null };
              
              await sendWhatsApp(clientWaId, 
                `${frase("si_hay")}\n\nPrecio: ₡${aiResult.precio.toLocaleString()}\n\n¿De dónde nos escribís?`
              );
              await sendWhatsApp(waId, `✅ Precio ₡${aiResult.precio.toLocaleString()} enviado a ${clientWaId}`);
            }
            
            if (SESSIONS_PERSIST) saveSessionsToDisk();
            return res.sendStatus(200);
          }
          
          // NO HAY
          if (aiResult.comando === "NO_HAY") {
            account.metrics.no_stock += 1;
            clientSession.state = "CERRADO_SIN_STOCK";
            removePendingQuote(clientWaId);
            
            await sendWhatsApp(clientWaId, fraseNoRepetir("no_hay", clientWaId));
            await sendWhatsApp(waId, `❌ Sin stock notificado a ${clientWaId}`);
            
            if (SESSIONS_PERSIST) saveSessionsToDisk();
            return res.sendStatus(200);
          }
          
          // PAGADO
          if (aiResult.comando === "PAGADO") {
            if (clientSession.state !== "ESPERANDO_SINPE") {
              await sendWhatsApp(waId, `⚠️ ${clientWaId} no está esperando pago.`);
              return res.sendStatus(200);
            }
            
            clientSession.pending_sinpe.status = "paid";
            clientSession.state = "PAGO_CONFIRMADO";
            account.metrics.sinpe_confirmed += 1;
            cancelSinpeWaitTimer(clientWaId);
            
            if (clientSession.delivery_method === "recoger") {
              let ubicacion = "";
              if (STORE_ADDRESS) {
                ubicacion = `\n\n📍 Dirección: ${STORE_ADDRESS}`;
                if (MAPS_URL) ubicacion += `\n🗺️ Mapa: ${MAPS_URL}`;
              }
              const horario = `Lunes a Sábado de ${HOURS_START}am a ${HOURS_END > 12 ? HOURS_END - 12 : HOURS_END}pm`;
              await sendWhatsApp(clientWaId, `¡Pago confirmado! 🙌\n\nPodés recoger tu pedido:${ubicacion}\n🕐 Horario: ${horario}\n\n¡Pura vida! 🇨🇷`);
            } else {
              await sendWhatsApp(clientWaId, `¡Listo! 🙌 Pago confirmado. Ya coordinamos tu envío.`);
            }
            
            await sendWhatsApp(waId, `✅ Pago confirmado para ${clientWaId}`);
            
            if (SESSIONS_PERSIST) saveSessionsToDisk();
            return res.sendStatus(200);
          }
          
          // PAUSA
          if (aiResult.comando === "PAUSA") {
            clientSession.paused = true;
            clientSession.paused_at = Date.now();
            clientSession.paused_until = Date.now() + (24 * 60 * 60 * 1000);
            
            await sendWhatsApp(waId, `⏸️ Bot PAUSADO para ${clientWaId}\n\nPodés chatear directo. El bot se reactiva en 24h o escribí "activar bot ${clientWaId}"`);
            
            if (SESSIONS_PERSIST) saveSessionsToDisk();
            return res.sendStatus(200);
          }
          
          // REANUDAR
          if (aiResult.comando === "REANUDAR") {
            clientSession.paused = false;
            clientSession.paused_at = null;
            clientSession.paused_until = null;
            
            await sendWhatsApp(waId, `▶️ Bot ACTIVO para ${clientWaId}`);
            
            if (SESSIONS_PERSIST) saveSessionsToDisk();
            return res.sendStatus(200);
          }
          
          // CATALOGO
          if (aiResult.comando === "CATALOGO") {
            if (!CATALOG_URL) {
              await sendWhatsApp(waId, `⚠️ No tenés CATALOG_URL configurado.`);
              return res.sendStatus(200);
            }
            
            await sendWhatsApp(clientWaId, `¡Hola! 🙌 Aquí podés ver todo:\n\n👉 ${CATALOG_URL}\n\nSi ves algo que te gusta, mandame la foto.`);
            await sendWhatsApp(waId, `📋 Catálogo enviado a ${clientWaId}`);
            return res.sendStatus(200);
          }
        } else if (aiResult.comando !== "NONE") {
          // Comando que necesita cliente pero no lo especificó
          await sendWhatsApp(waId, `⚠️ ¿Para cuál cliente? Hay ${pendingList.length} pendientes.`);
          return res.sendStatus(200);
        }
      }
    }
    
    if (!cmd) {
      // No es comando válido ni IA pudo interpretar
      if (pendingQuotes.size === 0) {
        await sendWhatsApp(waId, "📭 No hay consultas pendientes.\n\nEscribí natural: \"sí hay 12 mil\" o \"no tengo\"");
      } else {
        let list = "📋 Pendientes:\n\n";
        for (const p of pendingQuotes.values()) {
          list += `📱 ${p.waId}\n📝 ${p.details}\n\n`;
        }
        list += "Respondé natural: \"sí hay 12 mil\" o \"no tengo\"";
        await sendWhatsApp(waId, list);
      }
      return res.sendStatus(200);
    }

    const clientSession = sessions.get(cmd.clientWaId);
    if (!clientSession) {
      await sendWhatsApp(waId, `⚠️ No encontré cliente ${cmd.clientWaId}`);
      return res.sendStatus(200);
    }

    // PRECIO (solo producto, sin envío aún)
    if (cmd.type === "PRECIO" && !cmd.shipping) {
      account.metrics.quotes_sent += 1;
      clientSession.state = "ESPERANDO_ZONA";
      clientSession.last_offer = { price: cmd.price, shipping: null };
      removePendingQuote(cmd.clientWaId);
      
      await sendWhatsApp(cmd.clientWaId, 
        `${frase("si_hay")}\n\nPrecio: ₡${cmd.price.toLocaleString()}\n\n¿De dónde nos escribís? (escriba el lugar donde vive)`
      );
      await sendWhatsApp(waId, `✅ Precio enviado a ${cmd.clientWaId}. Esperando zona para calcular envío.`);
      
      if (SESSIONS_PERSIST) saveSessionsToDisk();
      return res.sendStatus(200);
    }

    // PRECIO TOTAL (producto + envío ya calculado)
    if (cmd.type === "PRECIO" && cmd.shipping !== null) {
      clientSession.state = "PRECIO_TOTAL_ENVIADO";
      clientSession.last_offer = { price: cmd.price, shipping: cmd.shipping };
      
      const total = cmd.price + cmd.shipping;
      
      await sendWhatsApp(cmd.clientWaId, 
        `Perfecto 🙌\n\nProducto: ₡${cmd.price.toLocaleString()}\nEnvío: ₡${cmd.shipping.toLocaleString()}\nTotal: ₡${total.toLocaleString()}\n\n¿Te interesa?\n👉 SI = Me interesa\n👉 NO = Solo estoy viendo\n\nSi te interesa, ¿cómo lo querés?\n👉 ENVÍO = Te lo enviamos\n👉 RECOGER = Pasás a tienda`
      );
      await sendWhatsApp(waId, `✅ Precio total enviado a ${cmd.clientWaId}`);
      
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

      // Si es RECOGER, ahora sí damos la dirección
      if (clientSession.delivery_method === "recoger") {
        let ubicacion = "";
        if (STORE_ADDRESS) {
          ubicacion = `\n\n📍 Dirección: ${STORE_ADDRESS}`;
          if (MAPS_URL) {
            ubicacion += `\n🗺️ Mapa: ${MAPS_URL}`;
          }
        }
        const horario = `Lunes a Sábado de ${HOURS_START}am a ${HOURS_END > 12 ? HOURS_END - 12 : HOURS_END}pm`;
        
        await sendWhatsApp(cmd.clientWaId, `¡Pago confirmado! 🙌\n\nPodés recoger tu pedido:${ubicacion}\n🕐 Horario: ${horario}\n\n📋 Presentá tu cédula al recoger.\n\n¡Pura vida! 🇨🇷`);
      } else {
        await sendWhatsApp(cmd.clientWaId, `¡Listo! 🙌 Pago confirmado. ${frase("gracias")} Ya coordinamos tu envío.`);
      }
      
      await sendWhatsApp(waId, `✅ Pago confirmado para ${cmd.clientWaId}`);
      
      if (SESSIONS_PERSIST) saveSessionsToDisk();
      return res.sendStatus(200);
    }

    // PAUSA - Desactivar bot para ese cliente
    if (cmd.type === "PAUSA") {
      clientSession.paused = true;
      clientSession.paused_at = Date.now();
      clientSession.paused_until = Date.now() + (24 * 60 * 60 * 1000); // 24 horas
      
      await sendWhatsApp(waId, `⏸️ Bot PAUSADO para ${cmd.clientWaId}\n\nPodés chatear directo con el cliente.\nEl bot se reactiva en 24h o escribí:\n${cmd.clientWaId} bot`);
      
      if (SESSIONS_PERSIST) saveSessionsToDisk();
      return res.sendStatus(200);
    }

    // REANUDAR - Reactivar bot para ese cliente
    if (cmd.type === "REANUDAR") {
      clientSession.paused = false;
      clientSession.paused_at = null;
      clientSession.paused_until = null;
      
      await sendWhatsApp(waId, `▶️ Bot ACTIVO para ${cmd.clientWaId}\n\nEl bot vuelve a responder automáticamente.`);
      
      if (SESSIONS_PERSIST) saveSessionsToDisk();
      return res.sendStatus(200);
    }

    // CATALOGO - Enviar catálogo al cliente
    if (cmd.type === "CATALOGO") {
      if (!CATALOG_URL) {
        await sendWhatsApp(waId, `⚠️ No tenés CATALOG_URL configurado.`);
        return res.sendStatus(200);
      }
      
      await sendWhatsApp(cmd.clientWaId, `¡Hola! 🙌 Aquí podés ver todo lo que tenemos:\n\n👉 ${CATALOG_URL}\n\nSi ves algo que te gusta, mandame la foto y te ayudo.`);
      await sendWhatsApp(waId, `📋 Catálogo enviado a ${cmd.clientWaId}`);
      
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
  
  // ---- VERIFICAR SI EL BOT ESTÁ PAUSADO PARA ESTE CLIENTE ----
  if (session.paused) {
    // Verificar si ya pasaron 24 horas
    if (session.paused_until && Date.now() > session.paused_until) {
      // Expiró la pausa, reactivar
      session.paused = false;
      session.paused_at = null;
      session.paused_until = null;
      console.log(`▶️ Pausa expirada, bot reactivado para: ${waId}`);
    } else {
      // Bot sigue pausado - no responder, solo notificar al dueño
      await notifyOwner(`💬 MENSAJE (bot pausado)\n📱 ${waId}\n💬 "${text || "[imagen]"}"`);
      console.log(`⏸️ Bot pausado para ${waId}, mensaje pasado al dueño`);
      return res.sendStatus(200);
    }
  }
  
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

    // ESPERANDO_ZONA: cliente dice de dónde es
    if (session.state === "ESPERANDO_ZONA") {
      session.client_zone = text.trim();
      session.state = "ZONA_RECIBIDA";
      
      const price = session.last_offer?.price || 0;
      
      // Notificar al dueño para que calcule envío
      await notifyOwner(
        `📍 ZONA RECIBIDA\n📱 ${waId}\n📍 Zona: ${session.client_zone}\n💰 Producto: ₡${price.toLocaleString()}\n\n→ Respondé: ${waId} ${price}-[envío]`
      );
      
      await sendWhatsApp(waId, `¡Gracias! 🙌 Ya te confirmo el costo de envío...`);
      
      if (SESSIONS_PERSIST) saveSessionsToDisk();
      return res.sendStatus(200);
    }

    // PRECIO_TOTAL_ENVIADO: cliente dice SI+ENVÍO, SI+RECOGER, o NO
    if (session.state === "PRECIO_TOTAL_ENVIADO") {
      const low = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      
      // Cliente dice NO / solo viendo
      if (low.includes("no") || low.includes("solo") || low.includes("viendo") || low.includes("luego")) {
        account.metrics.intent_no += 1;
        session.state = "CERRADO_SIN_INTERES";
        await sendWhatsApp(waId, fraseNoRepetir("no_quiere", waId));
        return res.sendStatus(200);
      }
      
      // Cliente quiere ENVÍO
      if (low.includes("envio") || low.includes("enviar") || low.includes("enviame") || low.includes("envíe")) {
        if (!consumeToken("INTENCION_SI")) {
          await sendWhatsApp(waId, msgOutOfTokens());
          return res.sendStatus(200);
        }
        
        account.metrics.intent_yes += 1;
        account.metrics.delivery_envio += 1;
        session.delivery_method = "envio";
        session.state = "PIDIENDO_DATOS";
        
        const price = session.last_offer?.price || 0;
        const ship = session.last_offer?.shipping || 0;
        const total = price + ship;
        const sinpe = SINPE_NUMBER ? `💳 SINPE: ${SINPE_NUMBER}${SINPE_NAME ? ` (${SINPE_NAME})` : ""}` : "";
        
        await sendWhatsApp(waId, 
          `¡Perfecto! 🙌\n\n${sinpe}\nTotal: ₡${total.toLocaleString()}\n\nPorfa pasame estos datos y el comprobante del SINPE:\n\n👤 Nombre completo:\n📍 Provincia:\n📍 Cantón:\n📍 Distrito:\n📍 Otras señas:\n📞 Teléfono:\n\n⚠️ En la descripción del SINPE poné tu nombre`
        );
        await notifyIntentConfirmed(session);
        if (SESSIONS_PERSIST) saveSessionsToDisk();
        return res.sendStatus(200);
      }
      
      // Cliente quiere RECOGER
      if (low.includes("recoger") || low.includes("tienda") || low.includes("retiro") || low.includes("paso")) {
        if (!consumeToken("INTENCION_SI")) {
          await sendWhatsApp(waId, msgOutOfTokens());
          return res.sendStatus(200);
        }
        
        account.metrics.intent_yes += 1;
        account.metrics.delivery_recoger += 1;
        session.delivery_method = "recoger";
        session.state = "PIDIENDO_DATOS_RECOGER";
        
        const price = session.last_offer?.price || 0;
        session.pending_sinpe = { expectedAmount: price, status: "pending", created_ms: Date.now() };
        
        const sinpe = SINPE_NUMBER ? `💳 SINPE: ${SINPE_NUMBER}${SINPE_NAME ? ` (${SINPE_NAME})` : ""}` : "";
        
        // NO damos dirección hasta que pague
        await sendWhatsApp(waId, 
          `¡Perfecto! 🙌\n\nTotal: ₡${price.toLocaleString()}\n\n${sinpe}\n\nPorfa pasame estos datos y el comprobante del SINPE:\n\n👤 Nombre completo:\n🪪 Cédula:\n\n⚠️ En la descripción del SINPE poné tu nombre\n\nCuando confirme tu pago, te envío la dirección y horario para recoger 📍`
        );
        await notifyIntentConfirmed(session);
        if (SESSIONS_PERSIST) saveSessionsToDisk();
        return res.sendStatus(200);
      }
      
      // Si dice solo "SI" sin especificar método
      if (low === "si" || low === "sí" || low === "dale" || low === "va" || low === "claro") {
        await sendWhatsApp(waId, `¿Cómo lo querés?\n👉 ENVÍO = Te lo enviamos\n👉 RECOGER = Pasás a tienda`);
        return res.sendStatus(200);
      }
      
      // No entendió
      await sendWhatsApp(waId, `¿Te interesa?\n👉 SI + ENVÍO = Te lo enviamos\n👉 SI + RECOGER = Pasás a tienda\n👉 NO = Solo estoy viendo`);
      return res.sendStatus(200);
    }

    // PRECIO_ENVIADO: (estado legacy, por si quedó alguna conversación vieja)
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

    // PIDIENDO_DATOS: recibir datos de envío + comprobante
    if (session.state === "PIDIENDO_DATOS") {
      session.shipping_details = text.trim();
      session.state = "ESPERANDO_SINPE";

      await sendWhatsApp(waId, `¡Recibido! 🙌 Estamos verificando el pago. En un momento te confirmamos.`);
      await notifyPaymentClaim(session);
      if (SESSIONS_PERSIST) saveSessionsToDisk();
      return res.sendStatus(200);
    }

    // PIDIENDO_DATOS_RECOGER: recibir nombre, cédula + comprobante
    if (session.state === "PIDIENDO_DATOS_RECOGER") {
      session.shipping_details = text.trim(); // nombre + cédula
      session.state = "ESPERANDO_SINPE";

      await sendWhatsApp(waId, `¡Recibido! 🙌 Estamos verificando el pago. En un momento te confirmamos.`);
      await notifyPaymentClaim(session);
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

    // =====================================
    // FAQ CON IA - Detecta intención
    // =====================================
    const low = text.toLowerCase();
    
    // Intentar clasificar con IA primero
    let faqCategory = null;
    if (OPENAI_API_KEY) {
      faqCategory = await aiClassifyFAQ(text);
      console.log("🤖 FAQ IA detectó:", faqCategory);
    }
    
    // Fallback a keywords si no hay IA
    if (!faqCategory) {
      if (low.includes("horario") || low.includes("hora") || low.includes("abierto") || low.includes("atienden") || low.includes("cierran")) {
        faqCategory = "HORARIO";
      } else if (low.includes("ubic") || low.includes("donde estan") || low.includes("direcci") || low.includes("local") || low.includes("llegar")) {
        faqCategory = "UBICACION";
      } else if (low.includes("tarjeta") || low.includes("visa") || low.includes("efectivo") || low.includes("como pago") || low.includes("cómo pago")) {
        faqCategory = "METODO_PAGO";
      } else if (low.includes("costo envio") || low.includes("precio envio") || low.includes("cuanto cobran envio") || low.includes("valor del envio")) {
        faqCategory = "COSTO_ENVIO";
      } else if (low.includes("envian") || low.includes("envían") || low.includes("hacen envio") || low.includes("mandan a") || low.includes("llegan a")) {
        faqCategory = "ZONA_ENVIO";
      } else if (low.includes("cuanto tarda") || low.includes("cuando llega") || low.includes("tiempo de entrega") || low.includes("demora")) {
        faqCategory = "TIEMPO_ENTREGA";
      } else if (low.includes("garantia") || low.includes("garantía") || low.includes("devolucion") || low.includes("cambio") || low.includes("no queda") || low.includes("defecto")) {
        faqCategory = "GARANTIA";
      } else if (low.includes("catalogo") || low.includes("catálogo") || low.includes("que tienen") || low.includes("qué tienen") || low.includes("fotos") || low.includes("mostrar")) {
        faqCategory = "CATALOGO";
      } else if (low.includes("sinpe") || low.includes("numero para pagar") || low.includes("a donde pago")) {
        faqCategory = "SINPE_INFO";
      } else if ((low.includes("precio") || low.includes("cuanto") || low.includes("cuesta")) && !session.last_image_id) {
        faqCategory = "PRECIO_SIN_FOTO";
      }
    }
    
    // Responder según categoría detectada
    if (faqCategory) {
      switch (faqCategory) {
        case "HORARIO":
          await sendWhatsApp(waId, `🕘 Horario: ${HOURS_DAY}`);
          return res.sendStatus(200);
          
        case "UBICACION":
          if (STORE_TYPE === "fisica" && (STORE_ADDRESS || MAPS_URL)) {
            await sendWhatsApp(waId, `📍 Estamos en: ${STORE_ADDRESS || ""}${MAPS_URL ? `\n🗺️ ${MAPS_URL}` : ""}`);
          } else {
            await sendWhatsApp(waId, `Somos tienda virtual 🙌 Hacemos envíos a todo el país.`);
          }
          return res.sendStatus(200);
          
        case "METODO_PAGO":
          if (STORE_TYPE === "fisica") {
            await sendWhatsApp(waId, `💳 En tienda: tarjeta o efectivo\n📱 Para envíos: SINPE Móvil`);
          } else {
            await sendWhatsApp(waId, `📱 Por el momento solo SINPE Móvil`);
          }
          return res.sendStatus(200);
          
        case "COSTO_ENVIO":
          await sendWhatsApp(waId, `🚚 Envíos:\n• GAM: ${SHIPPING_GAM}\n• Fuera de GAM: ${SHIPPING_RURAL}`);
          return res.sendStatus(200);
          
        case "ZONA_ENVIO":
          await sendWhatsApp(waId, `🚚 Sí, hacemos envíos a todo el país 🇨🇷\n• GAM: ${SHIPPING_GAM}\n• Fuera de GAM: ${SHIPPING_RURAL}`);
          return res.sendStatus(200);
          
        case "TIEMPO_ENTREGA":
          await sendWhatsApp(waId, `📦 Tiempo de entrega: ${DELIVERY_DAYS} después de confirmado el pago.\n\n⚠️ Pueden haber atrasos por Correos de CR.`);
          return res.sendStatus(200);
          
        case "GARANTIA":
          await sendWhatsApp(waId, `✅ Garantía: ${WARRANTY_DAYS}`);
          return res.sendStatus(200);
          
        case "CATALOGO":
          if (NO_PHOTOS_MSG) {
            await sendWhatsApp(waId, NO_PHOTOS_MSG);
          } else if (CATALOG_URL) {
            await sendWhatsApp(waId, `Hola 🙌 Todos nuestros productos están en:\n\n👉 ${CATALOG_URL}\n\nSi ves algo que te gusta, mandame la foto y te ayudo con precio y disponibilidad.`);
          } else {
            await sendWhatsApp(waId, `Hola 🙌 Si ya viste algo en nuestras redes, mandame la foto del producto y con gusto te ayudo.`);
          }
          return res.sendStatus(200);
          
        case "SINPE_INFO":
          if (SINPE_NUMBER) {
            await sendWhatsApp(waId, `📱 SINPE: ${SINPE_NUMBER}${SINPE_NAME ? ` (${SINPE_NAME})` : ""}\n\n⚠️ Primero mandame la foto del producto para confirmar disponibilidad.`);
          } else {
            await sendWhatsApp(waId, `El SINPE te lo paso cuando confirmemos tu pedido 🙌 Mandame la foto del producto.`);
          }
          return res.sendStatus(200);
          
        case "PRECIO_SIN_FOTO":
          await sendWhatsApp(waId, `Mandame la foto del producto y decime talla/color/tamaño 🙌`);
          return res.sendStatus(200);
          
        case "SALUDO":
          // No hacer nada, dejar que siga al greeting normal o IA
          break;
          
        // OTRO - continúa al IA fallback
      }
    }

    // =====================================
    // IA FALLBACK - Intentar responder con IA
    // =====================================
    if (OPENAI_API_KEY) {
      const aiReply = await aiDraftReply(waId, text, session, false);
      
      if (aiReply?.reply) {
        console.log("🤖 IA respondió al cliente:", aiReply.action);
        
        // Si IA detectó detalles, guardarlos
        if (aiReply.detected_details) {
          session.last_details_text = aiReply.detected_details;
        }
        
        // Si IA quiere escalar al dueño
        if (aiReply.action === "ESCALATE") {
          await notifyOwner(`❓ IA ESCALÓ\n📱 ${waId}\n💬 "${text}"\n\n→ Respondé dentro de 24h`);
        }
        
        // Si IA quiere que esperemos al dueño (ej: piden precio)
        if (aiReply.action === "WAIT_OWNER" && !session.sent_to_seller) {
          session.sent_to_seller = true;
          session.state = "ENVIADO_A_VENDEDOR";
          account.metrics.quotes_requested += 1;
          addPendingQuote(session);
          await notifyNewQuote(session);
        }
        
        await sendWhatsApp(waId, aiReply.reply);
        if (SESSIONS_PERSIST) saveSessionsToDisk();
        return res.sendStatus(200);
      }
    }

    // =====================================
    // SALIDA DE EMERGENCIA
    // Todo lo demás que no entendemos (y IA falló)
    // =====================================
    await notifyOwner(`❓ MENSAJE MANUAL\n📱 ${waId}\n💬 "${text}"\n\n→ Respondé dentro de 24h para no pagar extra`);
    await sendWhatsApp(waId, `Ahorita no te puedo contestar eso 🙌 Pero ya le paso tu consulta y te contactamos.`);
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








