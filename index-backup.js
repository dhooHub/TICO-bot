const express = require("express");
const fs = require("fs");
const path = require("path");
const app = express();
app.use(express.json());

/**
 ============================
 FIX CORRECTO: Polyfill fetch
 ============================
 */
let fetchFn = globalThis.fetch;

if (!fetchFn) {
  fetchFn = (...args) =>
    import("node-fetch").then(({ default: f }) => f(...args));
}

/**
 ============================
 VARIABLES (Railway → Variables)
 ============================
 */
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "tico_verify_123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const OWNER_PHONE = process.env.OWNER_PHONE || "";

const STORE_NAME = process.env.STORE_NAME || "TICO-bot";

// Múltiples links separados por coma (máximo 5)
const CATALOG_URLS = process.env.CATALOG_URLS || "";
const CATALOG_URL = process.env.CATALOG_URL || "";

const STORE_TYPE = (process.env.STORE_TYPE || "virtual").toLowerCase(); 
// Opciones: "virtual", "fisica_con_envios", "fisica_solo_recoger"

const STORE_ADDRESS = process.env.STORE_ADDRESS || "";
const MAPS_URL = process.env.MAPS_URL || "";

const HOURS_START = Number(process.env.HOURS_START || 9);
const HOURS_END = Number(process.env.HOURS_END || 19);
const HOURS_DAY = process.env.HOURS_DAY || `${HOURS_START}am-${HOURS_END > 12 ? HOURS_END - 12 : HOURS_END}pm`;

const SINPE_NUMBER = process.env.SINPE_NUMBER || "";
const SINPE_NAME = process.env.SINPE_NAME || "";

const SHIPPING_GAM = process.env.SHIPPING_GAM || "₡2,500";
const SHIPPING_RURAL = process.env.SHIPPING_RURAL || "₡3,500";
const DELIVERY_DAYS = process.env.DELIVERY_DAYS || "8 días hábiles";
const WARRANTY_DAYS = process.env.WARRANTY_DAYS || "30 días contra defectos de fábrica";

const MONTHLY_TOKENS = Number(process.env.MONTHLY_TOKENS || 100);
const PACK_TOKENS = Number(process.env.PACK_TOKENS || 10);
const PACK_PRICE_CRC = Number(process.env.PACK_PRICE_CRC || 1000);

const ADMIN_KEY = process.env.ADMIN_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const STATS_PERSIST = String(process.env.STATS_PERSIST || "") === "1";
const SESSIONS_PERSIST = String(process.env.SESSIONS_PERSIST || "") === "1";

const SESSION_TIMEOUT_HOURS = Number(process.env.SESSION_TIMEOUT_HOURS || 2);
const PHOTO_WAIT_SECONDS = Number(process.env.PHOTO_WAIT_SECONDS || 5);

const SINPE_SMS_SECRET = process.env.SINPE_SMS_SECRET || "";
const SINPE_WAIT_MINUTES = Number(process.env.SINPE_WAIT_MINUTES || 3);

const PRO_REMINDER = String(process.env.PRO_REMINDER || "") === "1";

/**
 ============================
 HELPERS PARA TIPO DE TIENDA
 ============================
 */
function hasPhysicalLocation() {
  return STORE_TYPE === "fisica_con_envios" || STORE_TYPE === "fisica_solo_recoger";
}

function offersShipping() {
  return STORE_TYPE === "virtual" || STORE_TYPE === "fisica_con_envios";
}

function offersPickup() {
  return STORE_TYPE === "fisica_con_envios" || STORE_TYPE === "fisica_solo_recoger";
}

/**
 ============================
 HELPER PARA CATÁLOGOS (FIX: máximo 5)
 ============================
 */
function getCatalogLinks(maxLinks = 5) {
  const urls = CATALOG_URLS ? CATALOG_URLS.split(',').map(u => u.trim()).filter(u => u) : 
               CATALOG_URL ? [CATALOG_URL] : [];
  
  if (urls.length === 0) return "";
  
  const toShow = urls.slice(0, maxLinks);
  
  if (toShow.length === 1) {
    return `Mirá nuestro catálogo: ${toShow[0]}`;
  }
  
  return `Mirá nuestros catálogos:\n${toShow.map((u, i) => `${i + 1}. ${u}`).join('\n')}`;
}

/**
 ============================
 UTILIDADES DE TIEMPO
 ============================
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

/**
 ============================
 ESTADO EN MEMORIA
 ============================
 */
const sessions = new Map();
const CLOSE_AFTER_MS = SESSION_TIMEOUT_HOURS * 60 * 60 * 1000;
const photoBuffers = new Map();
const sinpeWaitTimers = new Map();

function currentMonthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 ============================
 PERSISTENCIA
 ============================
 */
const SESSIONS_FILE = path.join(process.cwd(), "sessions.json");

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
 ============================
 CUENTA / FICHAS
 ============================
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
    ai_calls: 0,
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
 ============================
 PENDIENTES
 ============================
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
 ============================
 SESIONES
 ============================
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
      paused: false,
      ai_used_count: 0,
      message_history: [],
    });
    account.metrics.new_contacts += 1;
  }
  return sessions.get(waId);
}

function resetCloseTimer(session) {
  if (session.close_timer) clearTimeout(session.close_timer);
  if (session.reminder_timer) clearTimeout(session.reminder_timer);

  if (PRO_REMINDER && session.state === "PRECIO_ENVIADO" && session.last_offer) {
    session.reminder_timer = setTimeout(async () => {
      if (session.state === "PRECIO_ENVIADO") {
        const price = session.last_offer?.price || 0;
        const shipping = session.last_offer?.shipping || 0;
        const total = price + shipping;
        
        await sendWhatsApp(session.waId, `Hola, ¿todavía estás interesad@ en el producto? 🙌\n\nPrecio: ₡${total.toLocaleString()}\n\nEstamos para servirte. Si querés, podés reenviar la foto.`);
      }
    }, CLOSE_AFTER_MS);
  }

  const closeDelay = PRO_REMINDER ? CLOSE_AFTER_MS + (60 * 60 * 1000) : CLOSE_AFTER_MS;
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
  session.ai_used_count = 0;
  session.message_history = [];
  removePendingQuote(session.waId);
}

/**
 ============================
 HISTORIAL DE MENSAJES
 ============================
 */
function addToMessageHistory(session, role, content) {
  if (!session.message_history) {
    session.message_history = [];
  }
  
  session.message_history.push({
    role,
    content,
    timestamp: Date.now()
  });
  
  if (session.message_history.length > 5) {
    session.message_history = session.message_history.slice(-5);
  }
}

function getRecentMessages(session) {
  if (!session.message_history || session.message_history.length === 0) {
    return "";
  }
  
  const recent = session.message_history.slice(-5);
  return recent.map(m => `${m.role}: ${m.content}`).join("\n");
}

/**
 ============================
 REFERENCIA SINPE
 ============================
 */
function generateSinpeReference(waId) {
  const last4 = waId.slice(-4);
  const ts = Date.now().toString(36).slice(-4).toUpperCase();
  return `${last4}${ts}`;
}

/**
 ============================
 RÁFAGA DE FOTOS
 ============================
 */
function handlePhotoBuffer(waId, imageId, caption, callback) {
  let buffer = photoBuffers.get(waId);
  if (!buffer) {
    buffer = { photos: [], timer: null };
    photoBuffers.set(waId, buffer);
  }

  buffer.photos.push({ imageId, caption });
  if (buffer.timer) clearTimeout(buffer.timer);

  buffer.timer = setTimeout(() => {
    const photos = buffer.photos;
    photoBuffers.delete(waId);
    callback(photos);
  }, PHOTO_WAIT_SECONDS * 1000);
}

/**
 ============================
 TIMEOUT VERIFICACIÓN SINPE
 ============================
 */
function startSinpeWaitTimer(waId, session) {
  if (sinpeWaitTimers.has(waId)) {
    clearTimeout(sinpeWaitTimers.get(waId));
  }

  const timer = setTimeout(async () => {
    sinpeWaitTimers.delete(waId);
    if (session.state === "ESPERANDO_SINPE" && session.pending_sinpe?.status === "pending") {
      await notifyOwner(`⚠️ No se detectó SINPE automático\n📱 ${waId}\n🔑 Ref: ${session.sinpe_reference}\n💵 ₡${session.pending_sinpe?.expectedAmount?.toLocaleString() || "?"}\n\nComprobar manual: ${waId} pagado`);
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
 ============================
 FRASES TICAS
 ============================
 */
const FRASES = {
  revisando: ["Dame un toque, voy a revisar 👍", "Dejame chequearlo, ya te digo 👌", "Un momento, voy a fijarme 🙌", "Ya te confirmo, dame un ratito 😊", "Voy a revisar de una vez 👍"],
  pidiendo_detalles: [
    "Perfecto 🙌\nDecime un poquito más del producto para revisarlo bien:\npor ejemplo (escribí lo que aplique): talla, tamaño, color, sabor o presentación 😊",
    "Dale 🙌\n¿Me das más detalles del producto?\nPor ejemplo: talla, tamaño, color, sabor o presentación 👌",
    "Claro 🙌\nAyudame con más info:\n¿talla, tamaño, color, sabor o presentación? 😊"
  ],
  prefijos: ["Déjame revisar 🙌", "Un toque y reviso 👌", "Ya te confirmo 😊", "Con gusto te ayudo 🙌", "Claro que sí 👍"],
  saludos: ["¡Hola! Pura vida 🙌", "¡Hola! ¿Cómo estás? 🙌", "¡Hola! Qué gusto 👋", "¡Buenas! Pura vida 🙌", "¡Hola! Con gusto te ayudo 😊"],
  si_hay: ["¡Sí lo tenemos! 🎉", "¡Claro que sí! Lo tenemos 🙌", "¡Sí hay! 🎉", "¡Afirmativo! Sí lo tenemos 👍", "¡Qué dicha, sí hay! 🙌"],
  confirmacion: ["¡Buenísimo! 🙌", "¡Perfecto! 🎉", "¡Qué bien! 🙌", "¡Excelente! 👍", "¡Dale! 🙌"],
  no_quiere: ["Con gusto 🙌 Si ves algo más, mandame la foto.", "Está bien 🙌 Cualquier cosa aquí estamos.", "No hay problema 👍 Si ocupás algo, me avisás.", "Dale 🙌 Si te interesa otra cosa, con gusto.", "Perfecto 🙌 Aquí estamos para cuando gustés."],
  no_hay: ["Gracias por esperar 🙌 No tenemos ese producto ahora. Si querés, mandame foto de otro.", "Qué lástima 😔 Ese no lo tenemos. ¿Te interesa ver algo más?", "Uy, ese se nos agotó 🙌 ¿Querés ver otra opción?", "No lo tenemos disponible 😔 Pero si ves otro, con gusto te ayudo."],
  gracias: ["¡Gracias! 🙌", "¡Pura vida! 🙌", "¡Gracias por la confianza! 💪", "¡Tuanis! 🙌", "¡Con mucho gusto! 😊"],
  pedir_datos_envio: ["Perfecto, te lo enviamos 🚚", "¡Dale! Te lo mandamos 🚚", "¡Listo! Va para envío 🚚", "¡Perfecto! Lo enviamos 🚚"],
  recoger_tienda: ["Perfecto, lo apartamos para que lo recojás 🏪", "¡Dale! Te lo guardamos 🏪", "¡Listo! Lo tenemos apartado para vos 🏪", "¡Perfecto! Queda reservado 🏪"],
};

const lastUsed = new Map();

function fraseNoRepetir(tipo, sessionId = "global") {
  const opciones = FRASES[tipo] || [""];
  const key = `${tipo}_${sessionId}`;
  const last = lastUsed.get(key) || "";
  const disponibles = opciones.filter(f => f !== last);
  const elegida = disponibles.length > 0 ? disponibles[Math.floor(Math.random() * disponibles.length)] : opciones[0];
  lastUsed.set(key, elegida);
  return elegida;
}

function msgOutOfTokens() {
  return `⚠️ Se acabaron las fichas del mes 🙌\n\nPara seguir, activá un pack: ${PACK_TOKENS} fichas por ₡${PACK_PRICE_CRC}`;
}

/**
 ============================
 DETECCIÓN
 ============================
 */
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
 ============================
 COMANDO DEL DUEÑO
 ============================
 */
function parseOwnerCommand(text) {
  const t = (text || "").trim();
  const parts = t.split(/\s+/);
  if (parts.length < 2) return null;

  const clientNum = parts[0].replace(/[^\d]/g, "");
  if (clientNum.length < 8) return null;

  const cmd = parts[1].toLowerCase();

  if (cmd === "pagado" || cmd === "pago" || cmd === "ok") {
    return { type: "PAGADO", clientWaId: clientNum };
  }
  if (cmd === "0" || cmd === "no" || cmd === "nohay" || cmd === "agotado") {
    return { type: "NO_HAY", clientWaId: clientNum };
  }
  if (cmd === "pausa" || cmd === "pausar" || cmd === "stop") {
    return { type: "PAUSA", clientWaId: clientNum };
  }
  if (cmd === "bot" || cmd === "reanudar" || cmd === "activar") {
    return { type: "REANUDAR", clientWaId: clientNum };
  }
  if (cmd === "cat" || cmd === "catalogo" || cmd === "catálogo") {
    return { type: "CATALOGO", clientWaId: clientNum };
  }

  const priceStr = parts[1].replace(/[^\d-]/g, "");
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

function detectDeliveryMethod(text) {
  const t = (text || "").trim().toLowerCase();
  if (t.includes("envio") || t.includes("envío") || t === "si" || t === "sí") return "envio";
  if (t.includes("recoger") || t.includes("retiro") || t.includes("tienda") || t === "no") return "recoger";
  return null;
}

/**
 ============================
 WHATSAPP API (FIX: fetch correcto)
 ============================
 */
async function sendWhatsApp(toWaId, bodyText) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.log("📤 [SIM]", toWaId, ":", bodyText.slice(0, 80));
    return;
  }

  try {
    await fetchFn(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
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
 ═══════════════════════════════════════════════════════════
 IA CONVERSACIONAL
 ═══════════════════════════════════════════════════════════
 */

function norm(s = "") {
  return s.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function shouldUseAI(session, text, hasImage) {
  if (!OPENAI_API_KEY) return false;
  
  const t = norm(text);
  if (!t || t.length < 8) return false;
  if (hasImage) return false;
  if (session.paused) return false;
  if ((session.ai_used_count || 0) >= 3) return false;

  const criticalStates = ["ESPERANDO_ZONA", "PRECIO_ENVIADO", "PREGUNTANDO_METODO", "PIDIENDO_DATOS", "PIDIENDO_DATOS_RECOGER", "ESPERANDO_SINPE", "PAGO_CONFIRMADO", "CERRADO_TIMEOUT", "ESPERANDO_CONFIRMACION_VENDEDOR"];
  if (criticalStates.includes(session.state)) return false;

  if (/\b(precio|cuanto|cuesta|vale|costo)\b/.test(t)) return false;
  if (/\b(sinpe|pago|pague|transferi|listo|comprobante|ya)\b/.test(t)) return false;
  if (/\b(hay|tienen|disponible|stock)\b/.test(t)) return false;
  if (/^(hola|buenas|pura vida|hey|ey|buenos dias|buen dia)$/.test(t)) return false;
  if (/^(si|no|ok|dale|va|listo|claro)$/.test(t)) return false;
  if (isGreeting(text) || isYes(text) || isNo(text)) return false;

  return true;
}

async function aiHandleMessage(text, session) {
  const recentContext = getRecentMessages(session);
  
  const systemPrompt = `Sos un asistente de ventas de ${STORE_NAME} en WhatsApp.

REGLA CRÍTICA:
- Si el usuario pregunta algo técnico, de precio o de stock, respondé: "Dejame revisar eso con los compañeros y ya te confirmo 🙌"
- NUNCA inventes datos
- Máximo 2 líneas
- 1 emoji al final
- Tono tico casual

INFO:
- Horario: ${HOURS_DAY}
${offersShipping() ? `- Envíos: GAM ${SHIPPING_GAM}, Rural ${SHIPPING_RURAL}` : '- NO hacemos envíos'}
${hasPhysicalLocation() ? `- Dirección: ${STORE_ADDRESS}` : ''}
- Garantía: ${WARRANTY_DAYS}

CONTEXTO:
${recentContext || 'Primera interacción'}

Devolvé SOLO JSON:
{
  "action": "FAQ_HORARIO|FAQ_ENVIO|FAQ_METODOS_PAGO|FAQ_GARANTIA|ASK_PHOTO|WAIT_OWNER|CLARIFY",
  "reply": "Tu respuesta 1-2 líneas con emoji"
}`;

  try {
    const response = await fetchFn('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ],
        temperature: 0.3,
        max_tokens: 150,
        response_format: { type: 'json_object' }
      }),
    });

    if (!response.ok) {
      console.error('❌ OpenAI error:', response.status);
      return null;
    }

    const data = await response.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    
    console.log(`🧠 IA: ${parsed.action} | "${parsed.reply}"`);
    account.metrics.ai_calls += 1;
    return parsed;
    
  } catch (error) {
    console.error('❌ Error IA:', error);
    return null;
  }
}

async function notifyOwner(message) {
  console.log("📢 DUEÑO:", message);
}

/**
 ════════════════════════════════════════════════════
 HANDLER PRINCIPAL
 ════════════════════════════════════════════════════
 */
async function handleClientMessage(waId, text, hasImage, imageId) {
  ensureMonthlyReset();
  
  const session = getSession(waId);
  session.last_activity = Date.now();

  console.log(`\n━━━ ${waId} ━━━\n📝 "${text?.substring(0, 40) || '[imagen]'}..."\n📊 ${session.state} | 🎟️ ${tokensRemaining()} | 🤖 ${session.ai_used_count}/3`);

  if (session.paused) return;

  if (session.state === "CERRADO_TIMEOUT") {
    resetCase(session);
    session.state = "NEW";
  }

  if (hasImage) {
    handlePhotoBuffer(waId, imageId, text, async (photos) => {
      const details = text || "(sin detalles)";
      session.last_image_id = photos[0].imageId;
      session.last_details_text = details;
      session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
      session.sent_to_seller = true;
      account.metrics.quotes_requested += 1;
      
      await sendWhatsApp(waId, fraseNoRepetir("revisando", waId));
      addPendingQuote(session);
      await notifyOwner(`📸 ${waId}\n📝 ${details}\n\nResponder: ${waId} [precio] o ${waId} 0`);
      resetCloseTimer(session);
    });
    return;
  }

  addToMessageHistory(session, 'user', text);

  if (session.state === "ESPERANDO_CONFIRMACION_VENDEDOR") return;

  // FIX VERIFICADO: Flujo según STORE_TYPE
  if (session.state === "PRECIO_ENVIADO") {
    if (isYes(text)) {
      if (!canConsumeToken()) {
        await sendWhatsApp(waId, msgOutOfTokens());
        return;
      }
      consumeToken("INTENCION_SI");
      account.metrics.intent_yes += 1;
      
      // LÓGICA CORRECTA
      if (offersShipping() && offersPickup()) {
        await sendWhatsApp(waId, `${fraseNoRepetir("confirmacion", waId)}\n\n¿Querés que te lo enviemos o preferís recogerlo en tienda?`);
        session.state = "PREGUNTANDO_METODO";
        resetCloseTimer(session);
        return;
      }

      if (offersShipping() && !offersPickup()) {
        session.delivery_method = "envio";
        account.metrics.delivery_envio += 1;
        await sendWhatsApp(waId, `${fraseNoRepetir("confirmacion", waId)}\n\n¡Dale! Te lo enviamos 🚚\n\nPasame nombre completo, dirección exacta y teléfono 📝`);
        session.state = "PIDIENDO_DATOS";
        resetCloseTimer(session);
        return;
      }

      if (!offersShipping() && offersPickup()) {
        session.delivery_method = "recoger";
        account.metrics.delivery_recoger += 1;
        const msg = hasPhysicalLocation()
          ? `${fraseNoRepetir("confirmacion", waId)}\n\n¡Listo! Queda apartado 🏪\n📍 ${STORE_ADDRESS}\n🕒 ${HOURS_DAY}\n\nNombre y teléfono:`
          : `${fraseNoRepetir("confirmacion", waId)}\n\n¡Listo! Nombre y teléfono:`;
        await sendWhatsApp(waId, msg);
        session.state = "PIDIENDO_DATOS_RECOGER";
        resetCloseTimer(session);
        return;
      }
    }
    
    if (isNo(text)) {
      account.metrics.intent_no += 1;
      await sendWhatsApp(waId, fraseNoRepetir("no_quiere", waId));
      resetCase(session);
      return;
    }
  }

  if (session.state === "PREGUNTANDO_METODO") {
    const method = detectDeliveryMethod(text);
    
    if (method === "envio") {
      session.delivery_method = "envio";
      account.metrics.delivery_envio += 1;
      await sendWhatsApp(waId, `${fraseNoRepetir("pedir_datos_envio", waId)}\n\nNombre completo, dirección exacta y teléfono 📝`);
      session.state = "PIDIENDO_DATOS";
      resetCloseTimer(session);
      return;
    }
    
    if (method === "recoger") {
      session.delivery_method = "recoger";
      account.metrics.delivery_recoger += 1;
      await sendWhatsApp(waId, `${fraseNoRepetir("recoger_tienda", waId)}\n\n📍 ${STORE_ADDRESS}\n🕒 ${HOURS_DAY}\n\nNombre y teléfono:`);
      session.state = "PIDIENDO_DATOS_RECOGER";
      resetCloseTimer(session);
      return;
    }
  }

  if (session.state === "PIDIENDO_DATOS" || session.state === "PIDIENDO_DATOS_RECOGER") {
    session.shipping_details = text;
    session.sinpe_reference = generateSinpeReference(waId);
    
    const price = session.last_offer?.price || 0;
    const shipping = session.last_offer?.shipping || 0;
    const total = price + shipping;
    
    await sendWhatsApp(waId, `¡Perfecto! 🙌\n\nTotal: ₡${total.toLocaleString()}\n\nSINPE: ${SINPE_NUMBER}\nTitular: ${SINPE_NAME}\nRef: ${session.sinpe_reference}\n\nAvisáme cuando hagas el SINPE 💳`);
    
    session.pending_sinpe = { status: "pending", expectedAmount: total, created_at: new Date().toISOString() };
    session.state = "ESPERANDO_SINPE";
    
    if (SINPE_SMS_SECRET) startSinpeWaitTimer(waId, session);
    await notifyOwner(`💳 ${waId}\n🔑 ${session.sinpe_reference}\n💵 ₡${total.toLocaleString()}\n📝 ${session.shipping_details}\n\nResponder: ${waId} pagado`);
    resetCloseTimer(session);
    return;
  }

  if (session.state === "ESPERANDO_SINPE") {
    const lower = norm(text);
    if (lower.includes("listo") || lower.includes("pague") || lower.includes("transferi") || lower.includes("ya")) {
      await sendWhatsApp(waId, "Recibido! Déjame verificarlo 🙌");
      await notifyOwner(`⚠️ ${waId} dice que pagó\n🔑 ${session.sinpe_reference}\n\nResponder: ${waId} pagado`);
      return;
    }
  }

  const lower = norm(text);

  if (/\b(precio|cuanto|cuesta|vale)\b/.test(lower) && !hasImage) {
    await sendWhatsApp(waId, "Mandáme una foto del producto 📸");
    return;
  }

  if (/\b(hay|tienen|disponible)\b/.test(lower) && !hasImage) {
    await sendWhatsApp(waId, "Mandáme una foto para revisar si lo tenemos 📸");
    return;
  }

  if (/\b(envio|entregan|delivery|envian)\b/.test(lower)) {
    if (offersShipping()) {
      await sendWhatsApp(waId, `Hacemos envíos 🚚\nGAM: ${SHIPPING_GAM}\nRural: ${SHIPPING_RURAL}\nEntrega: ${DELIVERY_DAYS}`);
    } else {
      await sendWhatsApp(waId, `De momento no hacemos envíos 🙌\n\nPodés recogerlo en:\n📍 ${STORE_ADDRESS}\n🕒 ${HOURS_DAY}`);
    }
    return;
  }

  if (/\b(horario|abren|hora|atienden)\b/.test(lower)) {
    await sendWhatsApp(waId, `Atendemos ${HOURS_DAY} 🙌`);
    return;
  }

  if (/\b(garantia|devolucion|cambio)\b/.test(lower)) {
    await sendWhatsApp(waId, `Tenemos ${WARRANTY_DAYS} 🙌`);
    return;
  }

  if (/\b(pago|forma|metodo|sinpe)\b/.test(lower)) {
    await sendWhatsApp(waId, "Aceptamos SINPE Móvil 💳");
    return;
  }

  if (hasPhysicalLocation() && /\b(ubicacion|donde|direccion)\b/.test(lower)) {
    await sendWhatsApp(waId, `📍 ${STORE_ADDRESS}\n🕒 ${HOURS_DAY}${MAPS_URL ? `\n\n🗺️ ${MAPS_URL}` : ''}`);
    return;
  }

  if (isGreeting(text) && text.length < 20) {
    const catalogMsg = getCatalogLinks();
    const greeting = `${fraseNoRepetir("saludos", waId)}\n\n${catalogMsg ? catalogMsg + '\n\n' : ''}Mandáme una foto del producto que te interesa 📸`;
    await sendWhatsApp(waId, greeting);
    if (catalogMsg) session.catalog_sent = true;
    return;
  }

  if (shouldUseAI(session, text, hasImage)) {
    const aiResponse = await aiHandleMessage(text, session);
    
    if (aiResponse && aiResponse.reply) {
      session.ai_used_count += 1;
      addToMessageHistory(session, 'assistant', aiResponse.reply);
      await sendWhatsApp(waId, aiResponse.reply);
      return;
    }
  }

  const catalogMsg = !session.catalog_sent ? getCatalogLinks() : "";
  const fallbackMsg = catalogMsg 
    ? `${catalogMsg}\n\nMandáme una foto del producto 📸` 
    : "Mandáme una foto del producto 📸";
  
  await sendWhatsApp(waId, fallbackMsg);
  if (catalogMsg) session.catalog_sent = true;
}

async function handleOwnerCommand(waId, text) {
  const cmd = parseOwnerCommand(text);
  if (!cmd) return false;

  const clientSession = getSession(cmd.clientWaId);

  if (cmd.type === "PRECIO") {
    const { price, shipping } = cmd;
    clientSession.last_offer = { price, shipping };
    clientSession.state = "PRECIO_ENVIADO";
    clientSession.sent_to_seller = false;
    removePendingQuote(cmd.clientWaId);
    account.metrics.quotes_sent += 1;
    
    const shippingText = shipping ? `\nEnvío: ₡${shipping.toLocaleString()}` : "";
    const total = price + (shipping || 0);
    
    await sendWhatsApp(cmd.clientWaId, `${fraseNoRepetir("si_hay")}\n\nPrecio: ₡${price.toLocaleString()}${shippingText}\nTotal: ₡${total.toLocaleString()}\n\n¿Lo querés? 🙌`);
    await sendWhatsApp(waId, `✅ Precio enviado`);
    resetCloseTimer(clientSession);
    return true;
  }

  if (cmd.type === "NO_HAY") {
    clientSession.state = "ESPERANDO_DETALLES";
    clientSession.sent_to_seller = false;
    removePendingQuote(cmd.clientWaId);
    account.metrics.no_stock += 1;
    await sendWhatsApp(cmd.clientWaId, fraseNoRepetir("no_hay"));
    await sendWhatsApp(waId, `✅ "No hay" enviado`);
    resetCase(clientSession);
    return true;
  }

  if (cmd.type === "PAGADO") {
    if (clientSession.pending_sinpe) {
      clientSession.pending_sinpe.status = "confirmed";
      clientSession.pending_sinpe.confirmed_at = new Date().toISOString();
    }
    clientSession.state = "PAGO_CONFIRMADO";
    account.metrics.sinpe_confirmed += 1;
    cancelSinpeWaitTimer(cmd.clientWaId);
    
    const deliveryMsg = clientSession.delivery_method === "envio" 
      ? `Se enviará a: ${clientSession.shipping_details}\nLlegada: ${DELIVERY_DAYS}` 
      : hasPhysicalLocation() ? `Podés recogerlo en: ${STORE_ADDRESS}\n${HOURS_DAY}` : "Te contactamos para coordinar";
    
    await sendWhatsApp(cmd.clientWaId, `¡Pago confirmado! ${fraseNoRepetir("gracias")}\n\n${deliveryMsg}`);
    await sendWhatsApp(waId, `✅ Pago confirmado`);
    setTimeout(() => { if (clientSession.state === "PAGO_CONFIRMADO") resetCase(clientSession); }, 24 * 60 * 60 * 1000);
    return true;
  }

  if (cmd.type === "PAUSA") {
    clientSession.paused = true;
    await sendWhatsApp(waId, `⏸️ Bot pausado. Reanudar: ${cmd.clientWaId} bot`);
    return true;
  }

  if (cmd.type === "REANUDAR") {
    clientSession.paused = false;
    await sendWhatsApp(waId, `▶️ Bot reanudado`);
    return true;
  }

  if (cmd.type === "CATALOGO") {
    const catalogMsg = getCatalogLinks();
    if (catalogMsg) {
      await sendWhatsApp(cmd.clientWaId, `¡Hola! ${catalogMsg} 🙌`);
      await sendWhatsApp(waId, `✅ Catálogo enviado`);
    } else {
      await sendWhatsApp(waId, `⚠️ No hay catálogo`);
    }
    return true;
  }

  return false;
}

app.post("/webhook", async (req, res) => {
  try {
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages) return res.sendStatus(200);

    for (const msg of messages) {
      const waId = msg.from;

      if (waId === OWNER_PHONE) {
        if (msg.type === "text") {
          await handleOwnerCommand(waId, msg.text?.body);
        }
        continue;
      }

      let text = "";
      let hasImage = false;
      let imageId = null;

      if (msg.type === "text") {
        text = msg.text?.body || "";
      } else if (msg.type === "image") {
        hasImage = true;
        imageId = msg.image?.id;
        text = msg.image?.caption || "";
      } else {
        continue;
      }

      await handleClientMessage(waId, text, hasImage, imageId);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("❌ Webhook:", e);
    res.sendStatus(500);
  }
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.get("/status", (req, res) => {
  if (ADMIN_KEY && req.query.key !== ADMIN_KEY) return res.status(401).send("Unauthorized");
  ensureMonthlyReset();
  const activeSessions = Array.from(sessions.values()).filter(s => s.state !== "CERRADO_TIMEOUT");
  res.json({
    account: { month: account.month_key, tokens: { total: tokensTotal(), used: account.tokens_used, remaining: tokensRemaining() }, metrics: account.metrics },
    sessions: { total: sessions.size, active: activeSessions.length },
    config: { store: STORE_NAME, type: STORE_TYPE, hours: HOURS_DAY, sinpe: SINPE_NUMBER ? "✅" : "❌", catalog: (CATALOG_URL || CATALOG_URLS) ? "✅" : "❌", ai: OPENAI_API_KEY ? "✅" : "❌" }
  });
});

app.get("/inbox", (req, res) => {
  if (ADMIN_KEY && req.query.key !== ADMIN_KEY) return res.status(401).send("Unauthorized");
  const pending = Array.from(pendingQuotes.values());
  res.json({ pending, count: pending.length });
});

app.post("/packs/activate", (req, res) => {
  if (ADMIN_KEY && req.query.key !== ADMIN_KEY) return res.status(401).send("Unauthorized");
  ensureMonthlyReset();
  account.tokens_packs_added += PACK_TOKENS;
  res.json({ success: true, tokens: tokensTotal(), remaining: tokensRemaining() });
});

app.get("/", (req, res) => {
  res.send(`<h1>${STORE_NAME} - TICO-bot 🤖</h1><p>Tipo: ${STORE_TYPE}</p><p>Fichas: ${tokensRemaining()}/${tokensTotal()}</p><p>IA: ${OPENAI_API_KEY ? '✅' : '❌'} (${account.metrics.ai_calls} llamadas)</p>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🤖 TICO-BOT | Puerto ${PORT} | ${STORE_NAME} (${STORE_TYPE})\n🎟️  Fichas: ${tokensRemaining()}/${tokensTotal()} | 🤖 IA: ${OPENAI_API_KEY ? 'ON' : 'OFF'}\n`);
});








