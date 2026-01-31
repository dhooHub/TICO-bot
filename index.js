/** ============================
 * TICO-bot (WhatsApp Cloud API)
 * index.js — versión COMPLETA con PANEL WEB
 *
 * FEATURES:
 * ✅ Bot WhatsApp completo
 * ✅ Panel Web en tiempo real (Socket.io)
 * ✅ El dueño controla desde su celular
 * ✅ PWA instalable
 * ✅ FLUJO B2: Precio base → Zona → Envío → Ambas opciones
 * 
 * ============================
 * MAPA DE ESTADOS (FLUJO B2)
 * ============================
 *
 * NEW
 *  - Saludo/info → pide foto
 *  - Foto + texto → ESPERANDO_CONFIRMACION_VENDEDOR (notifica dueño)
 *
 * ESPERANDO_CONFIRMACION_VENDEDOR
 *  - Cliente: no avanza (espera dueño)
 *  - Dueño: da precio BASE → ESPERANDO_ZONA
 *  - Dueño: "no hay" → CERRADO_SIN_STOCK
 *
 * ESPERANDO_ZONA
 *  - Bot preguntó: "¿De qué provincia y lugar?"
 *  - Cliente responde zona → guarda client_zone → ZONA_RECIBIDA
 *  - Notifica dueño: "Cliente en [zona], ¿cuánto de envío?"
 *
 * ZONA_RECIBIDA
 *  - Cliente: no avanza (espera dueño)
 *  - Dueño: da costo envío → PRECIO_TOTAL_ENVIADO
 *  - Dueño: "no envío" → ofrece solo recoger
 *
 * PRECIO_TOTAL_ENVIADO
 *  - Bot mostró AMBAS opciones (envío vs recoger)
 *  - Botones: [COMPRAR] [NO GRACIAS]
 *  - Cliente "COMPRAR" → CONSUME FICHA → PREGUNTANDO_METODO
 *  - Cliente "NO GRACIAS" → CERRADO_SIN_INTERES
 *
 * PREGUNTANDO_METODO
 *  - Botones: [ENVÍO] [RECOGER]
 *  - "envío" → PIDIENDO_DATOS
 *  - "recoger" → PIDIENDO_DATOS_RECOGER
 *
 * PIDIENDO_DATOS / PIDIENDO_DATOS_RECOGER
 *  - Cliente manda datos → genera sinpe_reference
 *  - Envía SINPE completo → ESPERANDO_SINPE
 *  - Notifica dueño
 *
 * ESPERANDO_SINPE
 *  - "ya pagué" SIN foto → pide adjuntar comprobante
 *  - Foto comprobante → notifica dueño, espera confirmación
 *  - Dueño: confirma → PAGO_CONFIRMADO
 *
 * PAGO_CONFIRMADO
 *  - Confirmación + entrega → resetCase()
 *
 * CERRADO_TIMEOUT / CERRADO_SIN_INTERES / CERRADO_SIN_STOCK
 *  - Cliente vuelve → resetCase() → NEW
 *
 * ============================ */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Servir archivos estáticos (el panel)
app.use(express.static(path.join(__dirname, "public")));

/**
 ============================
 FETCH (Polyfill si Node < 18)
 ============================
 */
let fetchFn = globalThis.fetch;
if (!fetchFn) {
  fetchFn = (...args) =>
    import("node-fetch").then(({ default: f }) => f(...args));
}

/**
 ============================
 VARIABLES (ENV)
 ============================
 */
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "tico_verify_123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const OWNER_PHONE = process.env.OWNER_PHONE || "";
const APP_SECRET = process.env.APP_SECRET || "";

// PIN para el panel (4-6 dígitos)
const PANEL_PIN = process.env.PANEL_PIN || "1234";

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v24.0";

const STORE_NAME = process.env.STORE_NAME || "TICO-bot";
const CATALOG_URLS = process.env.CATALOG_URLS || "";
const CATALOG_URL = process.env.CATALOG_URL || "";
const STORE_TYPE = (process.env.STORE_TYPE || "virtual").toLowerCase();
const STORE_ADDRESS = process.env.STORE_ADDRESS || "";
const MAPS_URL = process.env.MAPS_URL || "";

const HOURS_START = Number(process.env.HOURS_START || 9);
const HOURS_END = Number(process.env.HOURS_END || 19);
const HOURS_DAY =
  process.env.HOURS_DAY ||
  `${HOURS_START}am-${HOURS_END > 12 ? HOURS_END - 12 : HOURS_END}pm`;

const SINPE_NUMBER = process.env.SINPE_NUMBER || "";
const SINPE_NAME = process.env.SINPE_NAME || "";

const SHIPPING_GAM = process.env.SHIPPING_GAM || "₡2,500";
const SHIPPING_RURAL = process.env.SHIPPING_RURAL || "₡3,500";
const DELIVERY_DAYS = process.env.DELIVERY_DAYS || "8 días hábiles";
const WARRANTY_DAYS =
  process.env.WARRANTY_DAYS || "30 días contra defectos de fábrica";

const MONTHLY_TOKENS = Number(process.env.MONTHLY_TOKENS || 100);
const PACK_TOKENS = Number(process.env.PACK_TOKENS || 10);
const PACK_PRICE_CRC = Number(process.env.PACK_PRICE_CRC || 1000);

const ADMIN_KEY = process.env.ADMIN_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const STATS_PERSIST = String(process.env.STATS_PERSIST || "1") === "1";
const SESSIONS_PERSIST = String(process.env.SESSIONS_PERSIST || "1") === "1";
const PROFILES_PERSIST = String(process.env.PROFILES_PERSIST || "1") === "1";

const SESSION_TIMEOUT_HOURS = Number(process.env.SESSION_TIMEOUT_HOURS || 2);
const PHOTO_WAIT_SECONDS = Number(process.env.PHOTO_WAIT_SECONDS || 5);

const PRO_REMINDER = String(process.env.PRO_REMINDER || "1") === "1";
const ABANDONED_REMINDER_HOURS = Number(process.env.ABANDONED_REMINDER_HOURS || 2);
const ABANDONED_REMINDER_MS = ABANDONED_REMINDER_HOURS * 60 * 60 * 1000;

/**
 ============================
 RAW BODY (Firma Meta)
 ============================
 */
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

/**
 ============================
 Firma Meta (timingSafeEqual)
 ============================
 */
function verifyMetaSignature(req) {
  if (!APP_SECRET) return true;

  const signature = req.get("x-hub-signature-256");
  if (!signature) return false;

  const expectedHash = crypto
    .createHmac("sha256", APP_SECRET)
    .update(req.rawBody || Buffer.from(""))
    .digest("hex");

  const receivedHash = signature.replace("sha256=", "");
  if (expectedHash.length !== receivedHash.length) return false;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedHash, "hex"),
      Buffer.from(receivedHash, "hex")
    );
  } catch {
    return false;
  }
}

/**
 ============================
 HELPERS TIENDA
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

function getCatalogLinks(maxLinks = 5) {
  const urls = CATALOG_URLS
    ? CATALOG_URLS.split(",").map((u) => u.trim()).filter(Boolean)
    : CATALOG_URL
    ? [CATALOG_URL]
    : [];

  if (urls.length === 0) return "";
  const toShow = urls.slice(0, maxLinks);

  if (toShow.length === 1) return `Mirá nuestro catálogo: ${toShow[0]}`;
  return `Mirá nuestros catálogos:\n${toShow.map((u, i) => `${i + 1}. ${u}`).join("\n")}`;
}

function countLinks(text = "") {
  const matches = String(text || "").match(/https?:\/\/\S+/gi);
  return matches ? matches.length : 0;
}

function getCostaRicaHour() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  return (utcHour - 6 + 24) % 24;
}
function isDaytime() {
  const hour = getCostaRicaHour();
  return hour >= HOURS_START && hour < HOURS_END;
}

function norm(s = "") {
  return String(s || "")
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function waDigits(s = "") {
  return String(s || "").replace(/[^\d]/g, "");
}

function normalizeCRPhone(input) {
  const d = waDigits(input);
  if (d.length === 8) return "506" + d;
  if (d.length === 11 && d.startsWith("506")) return d;
  return d;
}

function graphMessagesUrl() {
  return `https://graph.facebook.com/${GRAPH_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

/**
 ============================
 FILE SYSTEM SEGURO
 ============================
 */
function safeWriteJson(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

/**
 ============================
 ESTADO EN MEMORIA
 ============================
 */
const sessions = new Map();
const photoBuffers = new Map();
const sinpeWaitTimers = new Map();
const pendingQuotes = new Map();

// Historial de chats para el panel
let chatHistory = [];
const MAX_CHAT_HISTORY = 100;

/**
 ============================
 ANTI-DUPLICADO (Meta retries)
 ============================
 */
const processedMsgIds = new Map();
const DEDUPE_TTL_MS = 10 * 60 * 1000;

function isDuplicateMessage(msgId) {
  if (!msgId) return false;
  const now = Date.now();
  const last = processedMsgIds.get(msgId);
  if (last && now - last < DEDUPE_TTL_MS) return true;
  processedMsgIds.set(msgId, now);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of processedMsgIds.entries()) {
    if (now - ts > DEDUPE_TTL_MS) processedMsgIds.delete(id);
  }
}, 60 * 1000);

/**
 ============================
 PROFILES (VIP / BLOQUEO)
 ============================
 */
const profiles = new Map();

function getProfile(waId) {
  const id = String(waId || "");
  if (!profiles.has(id)) {
    profiles.set(id, {
      waId: id,
      name: "",
      tags: [],
      note: "",
      blocked: false,
      vip: false,
      purchases: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
  return profiles.get(id);
}

const PROFILES_FILE = path.join(process.cwd(), "profiles.json");

function saveProfilesToDisk() {
  if (!PROFILES_PERSIST) return;
  try {
    const arr = Array.from(profiles.values());
    safeWriteJson(PROFILES_FILE, arr);
  } catch (e) {
    console.log("⚠️ Error guardando profiles:", e?.message);
  }
}

function loadProfilesFromDisk() {
  if (!PROFILES_PERSIST) return;
  try {
    if (!fs.existsSync(PROFILES_FILE)) return;
    const arr = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf-8"));
    if (Array.isArray(arr)) {
      for (const p of arr) {
        if (p?.waId) profiles.set(String(p.waId), p);
      }
    }
    console.log(`👤 Profiles cargados: ${profiles.size}`);
  } catch (e) {
    console.log("⚠️ Error cargando profiles:", e?.message);
  }
}

setInterval(() => {
  if (PROFILES_PERSIST && profiles.size > 0) saveProfilesToDisk();
}, 5 * 60 * 1000);

const VIP_NUMBERS = (process.env.VIP_NUMBERS || "")
  .split(",").map((x) => normalizeCRPhone(x)).filter(Boolean);
const BLOCKED_NUMBERS = (process.env.BLOCKED_NUMBERS || "")
  .split(",").map((x) => normalizeCRPhone(x)).filter(Boolean);

const vipSet = new Set(VIP_NUMBERS);
const blockedSet = new Set(BLOCKED_NUMBERS);

function isVIP(waId) {
  return vipSet.has(normalizeCRPhone(waId));
}
function isBlocked(waId) {
  return blockedSet.has(normalizeCRPhone(waId));
}

/**
 ============================
 PERSISTENCIA SESIONES
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
          s.reminder_timer = null;
          if (!Array.isArray(s.details_log)) s.details_log = [];
          if (!Array.isArray(s.message_history)) s.message_history = [];
          sessions.set(String(s.waId), s);
        }
      }
    }
    console.log(`🧾 Sesiones cargadas: ${sessions.size}`);
  } catch (e) {
    console.log("⚠️ Error cargando sesiones:", e?.message);
  }
}

function saveSessionsToDisk() {
  if (!SESSIONS_PERSIST) return;
  try {
    const arr = Array.from(sessions.values()).map((s) => {
      const copy = { ...s };
      delete copy.close_timer;
      delete copy.reminder_timer;
      return copy;
    });
    safeWriteJson(SESSIONS_FILE, arr);
  } catch (e) {
    console.log("⚠️ Error guardando sesiones:", e?.message);
  }
}

setInterval(() => {
  if (SESSIONS_PERSIST && sessions.size > 0) saveSessionsToDisk();
}, 5 * 60 * 1000);

/**
 ============================
 PERSISTENCIA MÉTRICAS + TOKENS
 ============================
 */
function currentMonthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

const STATS_FILE = path.join(process.cwd(), "stats.json");

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
    receipts_forwarded: 0,
    vip_routed: 0,
    blocked_hits: 0,
  },
};

function loadStatsFromDisk() {
  if (!STATS_PERSIST) return;
  try {
    if (!fs.existsSync(STATS_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(STATS_FILE, "utf-8"));
    if (saved?.month_key) {
      account.month_key = saved.month_key || account.month_key;
      account.tokens_used = Number(saved.tokens_used || 0);
      account.tokens_packs_added = Number(saved.tokens_packs_added || 0);
      account.metrics = { ...account.metrics, ...(saved.metrics || {}) };
      console.log("📊 Stats cargadas");
    }
  } catch (e) {
    console.log("⚠️ Error cargando stats:", e?.message);
  }
}

function saveStatsToDisk() {
  if (!STATS_PERSIST) return;
  try {
    safeWriteJson(STATS_FILE, {
      month_key: account.month_key,
      tokens_used: account.tokens_used,
      tokens_packs_added: account.tokens_packs_added,
      metrics: account.metrics,
    });
  } catch (e) {
    console.log("⚠️ Error guardando stats:", e?.message);
  }
}

setInterval(() => {
  if (STATS_PERSIST) saveStatsToDisk();
}, 5 * 60 * 1000);

function tokensTotal() {
  return account.monthly_tokens + account.tokens_packs_added;
}
function tokensRemaining() {
  return Math.max(0, tokensTotal() - account.tokens_used);
}
function canConsumeToken() {
  return tokensRemaining() > 0;
}
function consumeToken(reason = "INTENCION_SI") {
  if (!canConsumeToken()) return false;
  account.tokens_used += 1;
  console.log(`🪙 Ficha consumida (${reason}). Quedan: ${tokensRemaining()}`);
  if (STATS_PERSIST) saveStatsToDisk();
  return true;
}
function ensureMonthlyReset() {
  const key = currentMonthKey();
  if (account.month_key === key) return;
  account.month_key = key;
  account.tokens_used = 0;
  account.tokens_packs_added = 0;
  console.log(`🔄 Reset mensual: ${key}`);
  if (STATS_PERSIST) saveStatsToDisk();
}
function msgOutOfTokens() {
  return `⚠️ Se acabaron las fichas del mes 🙌\n\nPara seguir, activá un pack: ${PACK_TOKENS} fichas por ₡${PACK_PRICE_CRC}`;
}

/**
 ============================
 PENDIENTES
 ============================
 */
function addPendingQuote(session) {
  const quote = {
    waId: session.waId,
    details: session.last_details_text || "(sin detalle)",
    imageId: session.last_image_id || null,
    created_at: new Date().toISOString(),
  };
  pendingQuotes.set(session.waId, quote);
  
  // Notificar al panel
  io.emit("new_pending", quote);
}
function removePendingQuote(waId) {
  pendingQuotes.delete(waId);
  io.emit("pending_resolved", { waId });
}

/**
 ============================
 SESIONES
 ============================
 */
const CLOSE_AFTER_MS = SESSION_TIMEOUT_HOURS * 60 * 60 * 1000;

function getSession(waId) {
  const id = String(waId || "");
  if (!sessions.has(id)) {
    sessions.set(id, {
      waId: id,
      state: "NEW",
      catalog_sent: false,
      last_image_id: null,
      last_details_text: null,
      details_log: [],
      sent_to_seller: false,
      last_activity: Date.now(),
      close_timer: null,
      reminder_timer: null,
      // Flujo B2: precio base y envío separados
      base_price: null,           // Precio sin envío (dueño da primero)
      shipping_cost: null,        // Costo envío (dueño da después de zona)
      client_zone: null,          // Zona del cliente (provincia/lugar)
      last_offer: null,           // Oferta completa {price, shipping}
      last_offer_sent_at: null,
      delivery_method: null,
      pending_sinpe: null,
      shipping_details: null,
      sinpe_reference: null,
      paused: false,
      ai_used_count: 0,
      message_history: [],
      waiting_receipt: false,
    });
    account.metrics.new_contacts += 1;
    if (STATS_PERSIST) saveStatsToDisk();
  }
  return sessions.get(id);
}

function clearTimers(session) {
  if (session.close_timer) clearTimeout(session.close_timer);
  if (session.reminder_timer) clearTimeout(session.reminder_timer);
  session.close_timer = null;
  session.reminder_timer = null;
}

function resetCase(session) {
  session.state = "NEW";
  session.last_image_id = null;
  session.last_details_text = null;
  session.details_log = [];
  session.sent_to_seller = false;
  // Flujo B2: limpiar precio base, envío y zona
  session.base_price = null;
  session.shipping_cost = null;
  session.client_zone = null;
  session.last_offer = null;
  session.last_offer_sent_at = null;
  session.delivery_method = null;
  session.pending_sinpe = null;
  session.shipping_details = null;
  session.sinpe_reference = null;
  session.ai_used_count = 0;
  session.message_history = [];
  session.waiting_receipt = false;
  removePendingQuote(session.waId);
  clearTimers(session);
}

/**
 ============================
 HISTORIAL MENSAJES (IA + Panel)
 ============================
 */
function addToMessageHistory(session, role, content) {
  if (!Array.isArray(session.message_history)) session.message_history = [];
  session.message_history.push({ role, content, timestamp: Date.now() });
  if (session.message_history.length > 5)
    session.message_history = session.message_history.slice(-5);
}
function getRecentMessages(session) {
  if (!session.message_history || session.message_history.length === 0) return "";
  return session.message_history
    .slice(-5)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");
}

// Agregar al historial global del panel
function addToChatHistory(waId, direction, text, imageId = null) {
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    waId,
    direction, // 'in' o 'out'
    text,
    imageId,
    timestamp: new Date().toISOString(),
  };
  
  chatHistory.push(entry);
  if (chatHistory.length > MAX_CHAT_HISTORY) {
    chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY);
  }
  
  // Emitir al panel en tiempo real
  io.emit("new_message", entry);
  
  return entry;
}

/**
 ============================
 REFERENCIA SINPE
 ============================
 */
function generateSinpeReference(waId) {
  const last4 = String(waId).slice(-4);
  const ts = Date.now().toString(36).slice(-4).toUpperCase();
  return `${last4}${ts}`;
}

/**
 ============================
 RÁFAGA DE FOTOS (buffer)
 ============================
 */
function handlePhotoBuffer(waId, imageId, caption, callback) {
  let buffer = photoBuffers.get(waId);
  if (!buffer) {
    buffer = { photos: [], timer: null, last_seen: Date.now() };
    photoBuffers.set(waId, buffer);
  }
  buffer.last_seen = Date.now();

  buffer.photos.push({ imageId, caption: String(caption || "") });
  if (buffer.timer) clearTimeout(buffer.timer);

  buffer.timer = setTimeout(() => {
    const photos = buffer.photos;
    photoBuffers.delete(waId);
    callback(photos);
  }, PHOTO_WAIT_SECONDS * 1000);
}

/**
 ============================
 FRASES TICAS (no repetir)
 ============================
 */
const FRASES = {
  revisando: [
    "Dame un toque, voy a revisar 👍",
    "Dejame chequearlo, ya te digo 👌",
    "Un momento, voy a fijarme 🙌",
    "Ya te confirmo, dame un ratito 😊",
    "Voy a revisar de una vez 👍",
  ],
  saludos: [
    "¡Hola! ¿Cómo estás? 🙌 Un gusto servirte.",
    "¡Hola! Pura vida 🙌 ¿En qué te ayudo?",
    "¡Hola! Qué gusto 👋 Con gusto te atiendo.",
    "¡Buenas! Pura vida 🙌",
    "¡Hola! Con gusto te ayudo 😊",
  ],
  si_hay: [
    "¡Sí lo tenemos! 🎉",
    "¡Claro que sí! Lo tenemos 🙌",
    "¡Sí hay! 🎉",
    "¡Afirmativo! Sí lo tenemos 👍",
    "¡Qué dicha, sí hay! 🙌",
  ],
  confirmacion: [
    "¡Buenísimo! 🙌",
    "¡Perfecto! 🎉",
    "¡Qué bien! 🙌",
    "¡Excelente! 👍",
    "¡Dale! 🙌",
  ],
  no_quiere: [
    "Con gusto 🙌 Si ves algo más, mandame la foto.",
    "Está bien 🙌 Cualquier cosa aquí estamos.",
    "No hay problema 👍 Si ocupás algo, me avisás.",
    "Dale 🙌 Si te interesa otra cosa, con gusto.",
    "Perfecto 🙌 Aquí estamos para cuando gustés.",
  ],
  no_hay: [
    "Gracias por esperar 🙌 No tenemos ese producto ahora. Si querés, mandame foto de otro.",
    "Qué lástima 😔 Ese no lo tenemos. ¿Te interesa ver algo más?",
    "Uy, ese se nos agotó 🙌 ¿Querés ver otra opción?",
    "No lo tenemos disponible 😔 Pero si ves otro, con gusto te ayudo.",
  ],
  gracias: [
    "¡Gracias! 🙌",
    "¡Pura vida! 🙌",
    "¡Gracias por la confianza! 💪",
    "¡Tuanis! 🙌",
    "¡Con mucho gusto! 😊",
  ],
  // Flujo B2: preguntar zona
  pedir_zona: [
    "¿De qué provincia y lugar nos escribís? 📍",
    "¿De dónde sos? Provincia y zona 📍",
    "Para calcular el envío, ¿de qué parte del país nos escribís? 📍",
  ],
  // Flujo B2: confirmar interés antes de zona
  te_interesa: [
    "¿Te interesa ese producto? 🤔",
    "¿Querés que te lo aparte? 🤔", 
    "¿Te gustaría llevártelo? 🤔",
  ],
  // Flujo B2: nocturno flexible
  nocturno: [
    "Pura vida 🙌 A esta hora la bodega ya cerró. Mandame foto y detalles, y apenas tenga la información te aviso 😊",
    "¡Hola! 🌙 Ya cerramos por hoy. Dejame tu foto y detalles, y apenas pueda te confirmo 🙌",
  ],
};

const lastUsed = new Map();
function fraseNoRepetir(tipo, sessionId = "global") {
  const opciones = FRASES[tipo] || [""];
  const key = `${tipo}_${sessionId}`;
  const last = lastUsed.get(key) || "";
  const disponibles = opciones.filter((f) => f !== last);
  const elegida =
    disponibles.length > 0
      ? disponibles[Math.floor(Math.random() * disponibles.length)]
      : opciones[0];
  lastUsed.set(key, elegida);
  return elegida;
}

/**
 ============================
 DETECCIÓN SIMPLE
 ============================
 */
function isGreeting(text) {
  const t = String(text || "").toLowerCase();
  return ["hola", "buenas", "buenos dias", "buen día", "pura vida"].some((k) =>
    t.includes(k)
  );
}
function isYes(text) {
  const t = String(text || "").trim().toLowerCase();
  return [
    "si", "sí", "sii", "claro", "lo quiero", "dale", "va", "listo", "ok", "de una",
  ].some((k) => t === k || t.startsWith(k));
}
function isNo(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["no", "nop", "solo viendo", "gracias", "luego"].some(
    (k) => t === k || t.startsWith(k)
  );
}
function detectDeliveryMethod(text) {
  const t = String(text || "").trim().toLowerCase();
  if (t.includes("envio") || t.includes("envío") || t === "si" || t === "sí")
    return "envio";
  if (t.includes("recoger") || t.includes("retiro") || t.includes("tienda") || t === "no")
    return "recoger";
  return null;
}

/**
 ============================
 WHATSAPP API
 ============================
 */
async function waPost(payload, label = "WA") {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.log(`📤 [SIM-${label}]`, payload?.to, payload?.type || "", JSON.stringify(payload).slice(0, 200));
    return { ok: true, status: 200, text: "SIM" };
  }

  const url = graphMessagesUrl();

  try {
    const r = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const txt = await r.text();

    if (!r.ok) console.log(`❌ ${label} ERROR`, r.status, txt);
    else console.log(`✅ ${label} OK`, r.status, txt.slice(0, 200));

    return { ok: r.ok, status: r.status, text: txt };
  } catch (e) {
    console.log(`⚠️ ${label} EXCEPTION:`, e?.message);
    return { ok: false, status: 0, text: "" };
  }
}

async function sendWhatsApp(toWaId, bodyText) {
  // Agregar al historial del panel
  addToChatHistory(toWaId, "out", bodyText);
  
  return waPost(
    {
      messaging_product: "whatsapp",
      to: String(toWaId),
      type: "text",
      text: { body: String(bodyText || "") },
    },
    "TEXT"
  );
}

async function sendImage(toWaId, imageId, caption = "") {
  if (!imageId) return;
  
  addToChatHistory(toWaId, "out", caption || "(imagen)", imageId);
  
  const r = await waPost(
    {
      messaging_product: "whatsapp",
      to: String(toWaId),
      type: "image",
      image: { id: imageId, caption: String(caption || "") },
    },
    "IMAGE"
  );
  if (!r.ok && caption) await sendWhatsApp(toWaId, caption);
}

async function sendButtons(toWaId, bodyText, buttons) {
  addToChatHistory(toWaId, "out", bodyText);
  
  const r = await waPost(
    {
      messaging_product: "whatsapp",
      to: String(toWaId),
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: String(bodyText || "") },
        action: {
          buttons: (buttons || []).slice(0, 3).map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    },
    "BUTTONS"
  );
  if (!r.ok) await sendWhatsApp(toWaId, bodyText);
}

async function sendList(toWaId, bodyText, buttonText, sectionTitle, rows) {
  const r = await waPost(
    {
      messaging_product: "whatsapp",
      to: String(toWaId),
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: String(bodyText || "") },
        action: {
          button: buttonText || "Ver",
          sections: [
            {
              title: sectionTitle || "Pendientes",
              rows: (rows || []).slice(0, 10).map((rr) => ({
                id: rr.id,
                title: String(rr.title).slice(0, 24),
                description: String(rr.description || "").slice(0, 72),
              })),
            },
          ],
        },
      },
    },
    "LIST"
  );

  if (!r.ok) {
    let msg = String(bodyText || "") + "\n\n";
    for (const rr of (rows || []).slice(0, 10)) {
      msg += `📱 ${rr.title}\n📝 ${rr.description}\n\n`;
    }
    await sendWhatsApp(toWaId, msg.trim());
  }
}

/**
 ============================
 NOTIFY OWNER (también por panel)
 ============================
 */
async function notifyOwner(message, imageId = null) {
  console.log("📢 DUEÑO:", message);
  
  // Emitir al panel web
  io.emit("owner_notification", { message, imageId, timestamp: new Date().toISOString() });
  
  if (!OWNER_PHONE) return;
  const owner = normalizeCRPhone(OWNER_PHONE);
  if (imageId) return sendImage(owner, imageId, message);
  return sendWhatsApp(owner, message);
}

/**
 ============================
 ABANDONADOS + CIERRE
 ============================
 */
function scheduleAbandonedReminder(session) {
  if (!PRO_REMINDER) return;
  if (session.reminder_timer) clearTimeout(session.reminder_timer);
  if (session.state !== "PRECIO_ENVIADO" || !session.last_offer) return;

  session.reminder_timer = setTimeout(async () => {
    if (session.paused) return;
    if (session.state !== "PRECIO_ENVIADO") return;

    const offer = session.last_offer || {};
    const total = Number(offer.price || 0) + Number(offer.shipping || 0);

    await sendWhatsApp(
      session.waId,
      `Hola 🙌 ¿Seguís interesad@?\nTotal: ₡${total.toLocaleString()}\n\nSi querés, reenviame la foto y lo revisamos de nuevo.`
    );
  }, ABANDONED_REMINDER_MS);
}

function resetCloseTimer(session) {
  if (session.close_timer) clearTimeout(session.close_timer);
  if (session.reminder_timer) clearTimeout(session.reminder_timer);

  scheduleAbandonedReminder(session);

  const closeDelay = PRO_REMINDER ? CLOSE_AFTER_MS + 60 * 60 * 1000 : CLOSE_AFTER_MS;

  session.close_timer = setTimeout(() => {
    session.state = "CERRADO_TIMEOUT";
    removePendingQuote(session.waId);
    account.metrics.closed_timeout += 1;
    if (SESSIONS_PERSIST) saveSessionsToDisk();
    if (STATS_PERSIST) saveStatsToDisk();
  }, closeDelay);
}

/**
 ============================
 EJECUTAR ACCIÓN DESDE PANEL
 ============================
 */
async function executeAction(clientWaId, actionType, data = {}) {
  const clientSession = getSession(clientWaId);
  
  // FLUJO B2: Precio BASE (sin envío) → pregunta zona al cliente
  if (actionType === "PRECIO") {
    const price = Number(data.price || 0);

    // Guardar precio base (sin envío todavía)
    clientSession.base_price = price;
    clientSession.shipping_cost = null; // Se llenará después
    clientSession.state = "ESPERANDO_ZONA";
    
    removePendingQuote(clientWaId);
    account.metrics.quotes_sent += 1;
    if (STATS_PERSIST) saveStatsToDisk();

    // Mensaje: Sí hay + precio + pregunta zona
    const msg = `${fraseNoRepetir("si_hay", clientWaId)}\n\n` +
      `Precio: ₡${price.toLocaleString()}\n\n` +
      `${fraseNoRepetir("pedir_zona", clientWaId)}`;

    await sendWhatsApp(clientWaId, msg);

    resetCloseTimer(clientSession);
    return { success: true, message: `Precio ₡${price.toLocaleString()} enviado. Esperando zona del cliente.` };
  }

  // FLUJO B2: Dueño da costo de ENVÍO después de saber zona
  if (actionType === "ENVIO") {
    const shipping = Number(data.shipping || 0);
    
    if (clientSession.state !== "ZONA_RECIBIDA") {
      return { success: false, message: "El cliente aún no ha dado su zona" };
    }

    clientSession.shipping_cost = shipping;
    clientSession.last_offer = { 
      price: clientSession.base_price, 
      shipping: shipping 
    };
    clientSession.last_offer_sent_at = Date.now();
    clientSession.state = "PRECIO_TOTAL_ENVIADO";
    
    if (STATS_PERSIST) saveStatsToDisk();

    const price = clientSession.base_price || 0;
    const totalEnvio = price + shipping;

    // Mostrar AMBAS opciones al cliente
    let msg = `${fraseNoRepetir("confirmacion", clientWaId)}\n\n`;
    
    if (offersShipping() && offersPickup()) {
      // Tiene ambas opciones
      msg += `📦 *Con envío:* ₡${totalEnvio.toLocaleString()}\n` +
        `   (Producto ₡${price.toLocaleString()} + Envío ₡${shipping.toLocaleString()})\n\n` +
        `🏪 *Recoger en tienda:* ₡${price.toLocaleString()}\n` +
        `   ${STORE_ADDRESS}\n\n` +
        `¿Qué preferís?`;
      
      await sendButtons(clientWaId, msg, [
        { id: "BTN_COMPRAR", title: "¡Lo quiero!" },
        { id: "BTN_NO", title: "No, gracias" },
      ]);
    } else if (offersShipping() && !offersPickup()) {
      // Solo envío
      msg += `📦 *Total con envío:* ₡${totalEnvio.toLocaleString()}\n` +
        `   (Producto ₡${price.toLocaleString()} + Envío ₡${shipping.toLocaleString()})\n\n` +
        `¿Lo querés?`;
      
      await sendButtons(clientWaId, msg, [
        { id: "BTN_COMPRAR", title: "¡Lo quiero!" },
        { id: "BTN_NO", title: "No, gracias" },
      ]);
    } else {
      // Solo recoger (raro pero posible)
      msg += `🏪 *Precio:* ₡${price.toLocaleString()}\n` +
        `   Recoger en: ${STORE_ADDRESS}\n\n` +
        `¿Lo querés?`;
      
      await sendButtons(clientWaId, msg, [
        { id: "BTN_COMPRAR", title: "¡Lo quiero!" },
        { id: "BTN_NO", title: "No, gracias" },
      ]);
    }

    resetCloseTimer(clientSession);
    return { success: true, message: `Precio total enviado. Envío: ₡${shipping.toLocaleString()}` };
  }

  // FLUJO B2: Dueño dice que NO hace envío a esa zona
  if (actionType === "NO_ENVIO_ZONA") {
    if (clientSession.state !== "ZONA_RECIBIDA") {
      return { success: false, message: "El cliente aún no ha dado su zona" };
    }

    const price = clientSession.base_price || 0;
    clientSession.shipping_cost = 0;
    clientSession.last_offer = { price, shipping: 0 };
    clientSession.state = "PRECIO_TOTAL_ENVIADO";
    
    if (offersPickup()) {
      // Ofrecer solo recoger
      const msg = `Uy, a ${clientSession.client_zone || "esa zona"} no hacemos envíos 😔\n\n` +
        `Pero podés recogerlo en tienda:\n` +
        `🏪 ${STORE_ADDRESS}\n` +
        `💰 Precio: ₡${price.toLocaleString()}\n\n` +
        `¿Te interesa?`;
      
      await sendButtons(clientWaId, msg, [
        { id: "BTN_COMPRAR", title: "Sí, lo recojo" },
        { id: "BTN_NO", title: "No, gracias" },
      ]);
    } else {
      // No hay forma de entrega
      await sendWhatsApp(clientWaId, 
        `Lo siento 😔 No hacemos envíos a ${clientSession.client_zone || "esa zona"} ` +
        `y no tenemos tienda física.\n\nSi tenés otra dirección, decime 🙌`
      );
      resetCase(clientSession);
      return { success: true, message: "No hay envío ni recoger para esa zona" };
    }

    resetCloseTimer(clientSession);
    return { success: true, message: "Solo recoger ofrecido (no hay envío a esa zona)" };
  }

  if (actionType === "NO_HAY") {
    removePendingQuote(clientWaId);
    account.metrics.no_stock += 1;
    clientSession.state = "CERRADO_SIN_STOCK";
    if (STATS_PERSIST) saveStatsToDisk();

    await sendWhatsApp(clientWaId, fraseNoRepetir("no_hay", clientWaId));
    resetCase(clientSession);
    return { success: true, message: `"No hay" enviado a ${clientWaId}` };
  }

  if (actionType === "PAGADO") {
    if (clientSession.pending_sinpe) {
      clientSession.pending_sinpe.status = "confirmed";
      clientSession.pending_sinpe.confirmed_at = new Date().toISOString();
    }
    clientSession.state = "PAGO_CONFIRMADO";
    removePendingQuote(clientWaId);
    account.metrics.sinpe_confirmed += 1;
    
    // Incrementar compras del contacto
    const profile = getProfile(clientWaId);
    profile.purchases = (profile.purchases || 0) + 1;
    profile.updated_at = new Date().toISOString();
    if (PROFILES_PERSIST) saveProfilesToDisk();
    
    if (STATS_PERSIST) saveStatsToDisk();

    const deliveryMsg =
      clientSession.delivery_method === "envio"
        ? `Se enviará a: ${clientSession.shipping_details}\nLlegada: ${DELIVERY_DAYS}`
        : hasPhysicalLocation()
        ? `Podés recogerlo en: ${STORE_ADDRESS}\n${HOURS_DAY}`
        : "Te contactamos para coordinar";

    await sendWhatsApp(clientWaId, `¡Pago confirmado! ${fraseNoRepetir("gracias", clientWaId)}\n\n${deliveryMsg}`);
    return { success: true, message: `Pago confirmado a ${clientWaId}` };
  }

  if (actionType === "CATALOGO") {
    const catalogMsg = getCatalogLinks();
    if (!catalogMsg) {
      return { success: false, message: "No hay catálogo configurado" };
    }
    await sendWhatsApp(clientWaId, `¡Hola! ${catalogMsg} 🙌`);
    return { success: true, message: `Catálogo enviado a ${clientWaId}` };
  }

  if (actionType === "MENSAJE_LIBRE") {
    const texto = String(data.texto || "").trim();
    if (!texto) {
      return { success: false, message: "Mensaje vacío" };
    }
    await sendWhatsApp(clientWaId, texto);
    return { success: true, message: `Mensaje enviado a ${clientWaId}` };
  }

  if (actionType === "PAUSA") {
    clientSession.paused = true;
    return { success: true, message: `Bot pausado para ${clientWaId}` };
  }

  if (actionType === "REANUDAR") {
    clientSession.paused = false;
    return { success: true, message: `Bot reanudado para ${clientWaId}` };
  }

  return { success: false, message: "Acción no reconocida" };
}

/**
 ============================
 IA (opcional)
 ============================
 */
function shouldUseAI(session, text, hasImage) {
  if (!OPENAI_API_KEY) return false;
  const t = norm(text);
  if (!t || t.length < 8) return false;
  if (hasImage) return false;
  if (session.paused) return false;
  if ((session.ai_used_count || 0) >= 3) return false;

  // FLUJO B2: Estados donde NO usar IA
  const critical = [
    "ESPERANDO_CONFIRMACION_VENDEDOR",
    "ESPERANDO_ZONA",           // Nuevo B2
    "ZONA_RECIBIDA",            // Nuevo B2
    "PRECIO_TOTAL_ENVIADO",     // Nuevo B2
    "PREGUNTANDO_METODO", 
    "PIDIENDO_DATOS",
    "PIDIENDO_DATOS_RECOGER", 
    "ESPERANDO_SINPE", 
    "PAGO_CONFIRMADO",
    "CERRADO_TIMEOUT",
    "CERRADO_SIN_INTERES",
    "CERRADO_SIN_STOCK",
  ];
  if (critical.includes(session.state)) return false;

  if (/\b(precio|cuanto|cuesta|vale|costo)\b/.test(t)) return false;
  if (/\b(sinpe|pago|pague|transferi|comprobante)\b/.test(t)) return false;
  if (/\b(hay|tienen|disponible|stock)\b/.test(t)) return false;
  if (isGreeting(text) || isYes(text) || isNo(text)) return false;

  return true;
}

async function aiHandleMessage(text, session) {
  const recentContext = getRecentMessages(session);

  const systemPrompt = `Sos el asistente de ventas de ${STORE_NAME} en Costa Rica.
TU ÚNICO OBJETIVO: Responder preguntas generales (horarios, envíos, garantía) de forma corta y amigable.

REGLAS ESTRICTAS:
1) NUNCA inventés datos. Si no sabés algo, decí: "Dejame confirmarlo, un toque 🙌"
2) NUNCA des precios ni confirmes stock. Si preguntan precio o disponibilidad, SIEMPRE respondé: "Pasame una foto del producto y te confirmo de una vez 📸"
3) Hablá de "vos", tono tico cercano (pura vida, con gusto, tuanis). NO usés "mae" ni "compa".
4) MÁXIMO 2 líneas. 1 emoji al final.
5) NO repitás información que el cliente ya sabe.

DATOS REALES DE LA TIENDA:
• Horario: ${HOURS_DAY}
• Pago: SINPE Móvil
${offersShipping() ? `• Envíos: GAM ${SHIPPING_GAM} / Rural ${SHIPPING_RURAL} (${DELIVERY_DAYS})` : "• NO hacemos envíos, solo retiro en tienda"}
${hasPhysicalLocation() ? `• Ubicación: ${STORE_ADDRESS}` : ""}
• Garantía: ${WARRANTY_DAYS}

HISTORIAL RECIENTE:
${recentContext || "(Primera interacción)"}

IMPORTANTE: Respondé SOLO con JSON válido, nada más.
Formato: {"reply":"tu respuesta corta aquí 🙌"}`;

  try {
    const response = await fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: String(text || "") },
        ],
        temperature: 0.3,
        max_tokens: 120,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const rawContent = data?.choices?.[0]?.message?.content;

    try {
      const cleanedJson = String(rawContent || "")
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .replace(/^[^{]*/, "")
        .trim();

      const parsed = JSON.parse(cleanedJson);

      if (parsed && typeof parsed.reply === "string" && parsed.reply.trim()) {
        account.metrics.ai_calls += 1;
        if (STATS_PERSIST) saveStatsToDisk();
        return { reply: parsed.reply.trim() };
      }

      return null;
    } catch (jsonErr) {
      console.log("⚠️ Error parseando JSON IA:", String(rawContent || "").slice(0, 200));
      
      const plainText = String(rawContent || "").trim();
      if (plainText.length > 5 && plainText.length < 200 && !plainText.includes("{")) {
        account.metrics.ai_calls += 1;
        if (STATS_PERSIST) saveStatsToDisk();
        return { reply: plainText };
      }
      
      return null;
    }
  } catch (e) {
    console.log("⚠️ Error IA:", e?.message);
    return null;
  }
}

/**
 ============================
 HANDLER CLIENTE (COMPLETO)
 ============================
 */
async function handleClientMessage(waIdRaw, textRaw, hasImage, imageId) {
  ensureMonthlyReset();

  const waId = normalizeCRPhone(waIdRaw);
  let text = String(textRaw || "").trim();

  const session = getSession(waId);
  session.last_activity = Date.now();
  account.metrics.chats_total += 1;
  if (STATS_PERSIST) saveStatsToDisk();

  // Agregar mensaje entrante al historial del panel
  addToChatHistory(waId, "in", text || "(imagen)", hasImage ? imageId : null);

  // Normaliza IDs de botones (Flujo B2)
  if (text === "BTN_YES") text = "si";
  if (text === "BTN_NO") text = "no";
  if (text === "BTN_COMPRAR") text = "comprar";  // FLUJO B2: botón de compra
  if (text === "BTN_MORE") text = "otra foto";
  if (text === "BTN_ENVIO") text = "envio";
  if (text === "BTN_RECOGER") text = "recoger";
  if (text === "BTN_YAPAGUE") text = "ya pague";

  const prof = getProfile(waId);
  if (isBlocked(waId) || prof.blocked) {
    account.metrics.blocked_hits += 1;
    if (STATS_PERSIST) saveStatsToDisk();
    return;
  }

  if (isVIP(waId) || prof.vip) {
    account.metrics.vip_routed += 1;
    if (STATS_PERSIST) saveStatsToDisk();

    const msgTxt = String(text || "").trim() || "(sin texto)";
    if (hasImage && imageId) {
      await notifyOwner(`⭐ VIP: ${waId}\n📸 Mensaje con foto\n📝 ${msgTxt}`, imageId);
    } else {
      await notifyOwner(`⭐ VIP: ${waId}\n📝 ${msgTxt}`);
    }
    return;
  }

  if (session.paused) return;

  if (session.state === "CERRADO_TIMEOUT") {
    resetCase(session);
    session.state = "NEW";
  }

  if (!isDaytime() && !hasImage) {
    const lower = norm(text);
    const isInfo = /\b(precio|cuanto|cuesta|vale|hay|tienen|disponible|stock)\b/.test(lower);
    if (isInfo) {
      account.metrics.night_leads += 1;
      if (STATS_PERSIST) saveStatsToDisk();
      await sendWhatsApp(waId, fraseNoRepetir("nocturno", waId));
      return;
    }
  }

  // Comprobante SINPE
  if (hasImage && session.state === "ESPERANDO_SINPE" && imageId) {
    account.metrics.receipts_forwarded += 1;
    if (STATS_PERSIST) saveStatsToDisk();

    await sendWhatsApp(waId, "¡Listo! 🙌 Recibí el comprobante. Ya se lo paso al encargado para revisión.");
    await notifyOwner(
      `🧾 COMPROBANTE SINPE\n📱 Cliente: ${waId}\n🔑 Ref: ${session.sinpe_reference || "(sin ref)"}\n💵 Esperado: ₡${(session.pending_sinpe?.expectedAmount || 0).toLocaleString()}`,
      imageId
    );
    return;
  }

  // Foto de producto
  if (hasImage) {
    handlePhotoBuffer(waId, imageId, text, async (photos) => {
      const details = String(text || "").trim() || "(sin detalles)";
      session.last_image_id = photos[0]?.imageId || null;
      session.last_details_text = details;

      session.details_log = Array.isArray(session.details_log) ? session.details_log : [];
      session.details_log.push({
        at: new Date().toISOString(),
        details,
        count: photos.length,
      });
      if (session.details_log.length > 5)
        session.details_log = session.details_log.slice(-5);

      session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
      account.metrics.quotes_requested += 1;
      if (STATS_PERSIST) saveStatsToDisk();

      await sendWhatsApp(waId, fraseNoRepetir("revisando", waId));
      addPendingQuote(session);

      await notifyOwner(
        `📸 Cliente: ${waId}\n📝 ${details}\n📷 Fotos: ${photos.length}`,
        photos[0]?.imageId || null
      );

      resetCloseTimer(session);
    });
    return;
  }

  if (countLinks(text) > 5) {
    await sendWhatsApp(waId, "Pura vida 🙌 Pasame máximo 5 links para revisarlo bien.");
    return;
  }

  addToMessageHistory(session, "user", String(text || ""));

  if (session.state === "ESPERANDO_CONFIRMACION_VENDEDOR") return;

  // ========================================
  // FLUJO B2: ESPERANDO_ZONA
  // El cliente recibió precio base, bot preguntó zona
  // ========================================
  if (session.state === "ESPERANDO_ZONA") {
    resetCloseTimer(session);
    
    // Guardar la zona del cliente
    session.client_zone = String(text || "").trim();
    session.state = "ZONA_RECIBIDA";
    
    const price = session.base_price || 0;
    
    // Notificar al panel web (abre modal automáticamente)
    io.emit("zone_received", {
      waId: waId,
      zone: session.client_zone,
      basePrice: price
    });
    
    // Notificar al dueño por WhatsApp también
    await notifyOwner(
      `📍 ZONA RECIBIDA\n` +
      `📱 Cliente: ${waId}\n` +
      `🗺️ Zona: ${session.client_zone}\n` +
      `💰 Precio base: ₡${price.toLocaleString()}\n\n` +
      `¿Cuánto de envío? Respondé desde el panel.`
    );
    
    await sendWhatsApp(waId, "¡Anotado! 📝 Dame un momento para calcular el envío a tu zona 🙌");
    return;
  }

  // ========================================
  // FLUJO B2: ZONA_RECIBIDA
  // Esperando que el dueño dé el costo de envío
  // ========================================
  if (session.state === "ZONA_RECIBIDA") {
    // Cliente escribió pero aún esperamos al dueño
    await sendWhatsApp(waId, "Estoy esperando confirmación del envío a tu zona. ¡Ya te aviso! 🙌");
    return;
  }

  // ========================================
  // FLUJO B2: PRECIO_TOTAL_ENVIADO
  // Cliente vio AMBAS opciones, esperando decisión
  // ========================================
  if (session.state === "PRECIO_TOTAL_ENVIADO") {
    resetCloseTimer(session);

    // Cliente presiona COMPRAR → AHORA SE COBRA LA FICHA
    if (text === "comprar" || isYes(text)) {
      if (!canConsumeToken()) {
        await sendWhatsApp(waId, msgOutOfTokens());
        return;
      }
      consumeToken("COMPRAR_CONFIRMADO");
      account.metrics.intent_yes += 1;
      if (STATS_PERSIST) saveStatsToDisk();

      // Preguntar método de entrega
      if (offersShipping() && offersPickup()) {
        await sendButtons(waId, `${fraseNoRepetir("confirmacion", waId)}\n\n¿Cómo lo preferís?`, [
          { id: "BTN_ENVIO", title: "📦 Envío" },
          { id: "BTN_RECOGER", title: "🏪 Recoger" },
        ]);
        session.state = "PREGUNTANDO_METODO";
        return;
      }

      if (offersShipping() && !offersPickup()) {
        session.delivery_method = "envio";
        account.metrics.delivery_envio += 1;
        if (STATS_PERSIST) saveStatsToDisk();
        await sendWhatsApp(waId, 
          `${fraseNoRepetir("confirmacion", waId)}\n\n` +
          `Pasame tus datos para el envío:\n` +
          `📍 Provincia:\n` +
          `📍 Cantón:\n` +
          `📍 Distrito:\n` +
          `📍 Otras señas:\n` +
          `📞 Teléfono:`
        );
        session.state = "PIDIENDO_DATOS";
        return;
      }

      if (!offersShipping() && offersPickup()) {
        session.delivery_method = "recoger";
        account.metrics.delivery_recoger += 1;
        if (STATS_PERSIST) saveStatsToDisk();
        await sendWhatsApp(waId, 
          `${fraseNoRepetir("confirmacion", waId)}\n\n` +
          `📍 ${STORE_ADDRESS}\n` +
          `🕒 ${HOURS_DAY}\n\n` +
          `Pasame tu nombre y teléfono:`
        );
        session.state = "PIDIENDO_DATOS_RECOGER";
        return;
      }
    }

    // Cliente dice NO
    if (isNo(text)) {
      account.metrics.intent_no += 1;
      session.state = "CERRADO_SIN_INTERES";
      if (STATS_PERSIST) saveStatsToDisk();
      await sendWhatsApp(waId, fraseNoRepetir("no_quiere", waId));
      resetCase(session);
      return;
    }

    // Cliente quiere otra foto
    if (norm(text).includes("otra foto")) {
      await sendWhatsApp(waId, "Dale 🙌 Mandame la foto del producto 📸");
      resetCase(session);
      return;
    }

    // No entendió - repetir opciones
    return;
  }

  // ========================================
  // PREGUNTANDO_METODO (después de COMPRAR)
  // ========================================
  if (session.state === "PREGUNTANDO_METODO") {
    const method = detectDeliveryMethod(text);
    if (method === "envio") {
      session.delivery_method = "envio";
      account.metrics.delivery_envio += 1;
      if (STATS_PERSIST) saveStatsToDisk();
      await sendWhatsApp(waId, 
        `¡Listo! 🙌\n\n` +
        `Pasame tus datos para el envío:\n` +
        `📍 Provincia:\n` +
        `📍 Cantón:\n` +
        `📍 Distrito:\n` +
        `📍 Otras señas:\n` +
        `📞 Teléfono:`
      );
      session.state = "PIDIENDO_DATOS";
      resetCloseTimer(session);
      return;
    }
    if (method === "recoger") {
      session.delivery_method = "recoger";
      account.metrics.delivery_recoger += 1;
      if (STATS_PERSIST) saveStatsToDisk();
      await sendWhatsApp(waId, 
        `Perfecto 🏪\n\n` +
        `📍 ${STORE_ADDRESS}\n` +
        `🕒 ${HOURS_DAY}\n\n` +
        `Pasame tu nombre y teléfono:`
      );
      session.state = "PIDIENDO_DATOS_RECOGER";
      resetCloseTimer(session);
      return;
    }
  }

  // PIDIENDO_DATOS
  if (session.state === "PIDIENDO_DATOS" || session.state === "PIDIENDO_DATOS_RECOGER") {
    session.shipping_details = String(text || "");
    session.sinpe_reference = generateSinpeReference(waId);

    const price = session.last_offer?.price || 0;
    const shipping = session.last_offer?.shipping || 0;
    const total = price + shipping;

    const sinpeMsg =
      `¡Perfecto! 🙌\n\n` +
      `Total: ₡${total.toLocaleString()}\n\n` +
      `SINPE ${SINPE_NUMBER} a nombre de ${SINPE_NAME}\n` +
      `Ref: ${session.sinpe_reference}\n\n` +
      `Cuando realicés el pago, por favor enviame el comprobante en *un solo mensaje* 🧾`;

    await sendWhatsApp(waId, sinpeMsg);

    session.pending_sinpe = {
      status: "pending",
      expectedAmount: total,
      created_at: new Date().toISOString(),
    };
    session.state = "ESPERANDO_SINPE";

    await notifyOwner(
      `💳 Cliente: ${waId}\n🔑 Ref: ${session.sinpe_reference}\n💵 ₡${total.toLocaleString()}\n📝 ${session.shipping_details}`
    );

    resetCloseTimer(session);
    return;
  }

  // ESPERANDO_SINPE
  if (session.state === "ESPERANDO_SINPE") {
    const lower = norm(text);
    const saysPaid = lower.includes("listo") || lower.includes("pague") || lower.includes("transferi") || lower === "ya pague" || lower.includes("ya");

    if (saysPaid) {
      await sendWhatsApp(waId, "Listo 🙌 Para validar el pago, tenés que *adjuntar la foto del comprobante SINPE* aquí mismo 🧾📸\n\nEnviála en un solo mensaje por favor.");
      return;
    }
  }

  // FAQs rápidas
  const lower = norm(text);

  if (/\b(envio|entregan|delivery|envian)\b/.test(lower)) {
    if (offersShipping()) {
      await sendWhatsApp(waId, `Hacemos envíos 🚚\nGAM: ${SHIPPING_GAM}\nRural: ${SHIPPING_RURAL}\nEntrega: ${DELIVERY_DAYS}`);
    } else {
      await sendWhatsApp(waId, `De momento no hacemos envíos 🙌\n\n📍 ${STORE_ADDRESS}\n🕒 ${HOURS_DAY}`);
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
    await sendWhatsApp(waId, `Aceptamos SINPE Móvil 💳`);
    return;
  }

  if (hasPhysicalLocation() && /\b(ubicacion|donde|direccion)\b/.test(lower)) {
    await sendWhatsApp(waId, `📍 ${STORE_ADDRESS}\n🕒 ${HOURS_DAY}${MAPS_URL ? `\n\n🗺️ ${MAPS_URL}` : ""}`);
    return;
  }

  // Saludo
  if (isGreeting(text) && String(text || "").length < 25) {
    const catalogMsg = getCatalogLinks();
    const greeting = `${fraseNoRepetir("saludos", waId)}\n\n` +
      `${catalogMsg ? catalogMsg + "\n\n" : ""}` +
      `Mandáme una foto del producto que te interesa 📸`;
    await sendWhatsApp(waId, greeting);
    if (catalogMsg) session.catalog_sent = true;
    return;
  }

  if (/\b(precio|cuanto|cuesta|vale)\b/.test(lower)) {
    await sendWhatsApp(waId, "Mandáme una foto del producto 📸");
    return;
  }
  if (/\b(hay|tienen|disponible|stock)\b/.test(lower)) {
    await sendWhatsApp(waId, "Mandáme una foto para revisar si lo tenemos 📸");
    return;
  }

  // IA fallback
  if (shouldUseAI(session, text, hasImage)) {
    const ai = await aiHandleMessage(text, session);
    if (ai?.reply) {
      session.ai_used_count += 1;
      addToMessageHistory(session, "assistant", ai.reply);
      await sendWhatsApp(waId, ai.reply);
      return;
    }
  }

  // Fallback final
  const catalogMsg = !session.catalog_sent ? getCatalogLinks() : "";
  const fallback = catalogMsg
    ? `${catalogMsg}\n\nMandáme una foto del producto 📸`
    : "Mandáme una foto del producto 📸";
  await sendWhatsApp(waId, fallback);
  if (catalogMsg) session.catalog_sent = true;
}

/**
 ============================
 SOCKET.IO - PANEL WEB
 ============================
 */
io.on("connection", (socket) => {
  console.log("🔌 Panel conectado:", socket.id);
  
  let authenticated = false;
  
  // Autenticación con PIN
  socket.on("auth", (pin) => {
    if (pin === PANEL_PIN) {
      authenticated = true;
      socket.emit("auth_success", { storeName: STORE_NAME });
      
      // Enviar datos iniciales
      socket.emit("init_data", {
        pending: Array.from(pendingQuotes.values()),
        history: chatHistory.slice(-50),
        contacts: Array.from(profiles.values()),
        metrics: account.metrics,
        tokens: { total: tokensTotal(), remaining: tokensRemaining() },
      });
      
      console.log("✅ Panel autenticado:", socket.id);
    } else {
      socket.emit("auth_error", "PIN incorrecto");
    }
  });
  
  // Middleware de autenticación
  socket.use((packet, next) => {
    if (packet[0] === "auth") return next();
    if (!authenticated) {
      return next(new Error("No autenticado"));
    }
    next();
  });
  
  // Ejecutar acción
  socket.on("action", async (data) => {
    const { clientWaId, actionType, payload } = data;
    console.log("📱 Acción desde panel:", actionType, clientWaId);
    
    const result = await executeAction(clientWaId, actionType, payload || {});
    socket.emit("action_result", result);
  });
  
  // Obtener pendientes
  socket.on("get_pending", () => {
    socket.emit("pending_list", Array.from(pendingQuotes.values()));
  });
  
  // Obtener historial de un cliente
  socket.on("get_client_history", (waId) => {
    const clientHistory = chatHistory.filter(m => m.waId === waId);
    socket.emit("client_history", { waId, messages: clientHistory });
  });
  
  // Obtener métricas
  socket.on("get_metrics", () => {
    socket.emit("metrics", {
      metrics: account.metrics,
      tokens: { total: tokensTotal(), remaining: tokensRemaining() },
      sessions: { total: sessions.size, active: Array.from(sessions.values()).filter(s => s.state !== "CERRADO_TIMEOUT").length },
    });
  });

  // Obtener contactos
  socket.on("get_contacts", () => {
    socket.emit("contacts_list", {
      contacts: Array.from(profiles.values())
    });
  });

  // Actualizar contacto
  socket.on("update_contact", (data) => {
    const { waId, name, note, tags, vip, blocked } = data;
    if (!waId) return;

    const profile = getProfile(waId);
    if (name !== undefined) profile.name = name;
    if (note !== undefined) profile.note = note;
    if (tags !== undefined) profile.tags = tags;
    if (vip !== undefined) profile.vip = vip;
    if (blocked !== undefined) profile.blocked = blocked;
    profile.updated_at = new Date().toISOString();

    // Actualizar sets de VIP y bloqueados
    const normalized = normalizeCRPhone(waId);
    if (vip) {
      vipSet.add(normalized);
    } else {
      vipSet.delete(normalized);
    }
    if (blocked) {
      blockedSet.add(normalized);
    } else {
      blockedSet.delete(normalized);
    }

    if (PROFILES_PERSIST) saveProfilesToDisk();

    // Confirmar al panel
    socket.emit("contact_updated", profile);
    console.log(`👤 Contacto actualizado: ${waId} - ${name || "(sin nombre)"}`);
  });

  // Crear contacto nuevo
  socket.on("create_contact", (data) => {
    const { waId, name, note, tags, vip, blocked } = data;
    if (!waId) return;

    const normalized = normalizeCRPhone(waId);
    
    // Verificar si ya existe
    if (profiles.has(normalized)) {
      socket.emit("contact_error", { message: "Este contacto ya existe" });
      return;
    }

    // Crear el perfil
    const profile = getProfile(normalized);
    profile.name = name || "";
    profile.note = note || "";
    profile.tags = tags || [];
    profile.vip = vip || false;
    profile.blocked = blocked || false;
    profile.created_at = new Date().toISOString();
    profile.updated_at = new Date().toISOString();
    profile.purchases = 0;
    profile.manual = true; // Marca que fue creado manualmente

    // Actualizar sets de VIP
    if (vip) {
      vipSet.add(normalized);
    }

    if (PROFILES_PERSIST) saveProfilesToDisk();

    // Confirmar al panel
    socket.emit("contact_created", profile);
    
    // Notificar a todos los paneles conectados
    io.emit("contact_updated", profile);
    
    console.log(`👤 Contacto CREADO: ${normalized} - ${name}`);
  });

  // Borrar chats de un contacto
  // ✅ CORREGIDO: chatHistory es un array, no un Map
  socket.on("delete_chats", (data) => {
    const { waId } = data;
    if (!waId) return;

    const normalized = normalizeCRPhone(waId);
    
    // Borrar historial de chat (chatHistory es un ARRAY, usar filter)
    chatHistory = chatHistory.filter(m => m.waId !== normalized);
    
    // Borrar sesión activa
    if (sessions.has(normalized)) {
      const session = sessions.get(normalized);
      clearTimers(session);
      sessions.delete(normalized);
    }
    
    // Borrar de pendientes
    removePendingQuote(normalized);
    
    if (SESSIONS_PERSIST) saveSessionsToDisk();
    
    console.log(`🗑️ Chats borrados: ${normalized}`);
    
    // Notificar a todos los paneles
    io.emit("chats_deleted", { waId: normalized });
  });

  // Eliminar contacto completamente
  // ✅ CORREGIDO: chatHistory es un array, no un Map
  socket.on("delete_contact", (data) => {
    const { waId } = data;
    if (!waId) return;

    const normalized = normalizeCRPhone(waId);
    
    // Borrar perfil
    profiles.delete(normalized);
    
    // Borrar de sets VIP/bloqueados
    vipSet.delete(normalized);
    blockedSet.delete(normalized);
    
    // Borrar historial de chat (chatHistory es un ARRAY, usar filter)
    chatHistory = chatHistory.filter(m => m.waId !== normalized);
    
    // Borrar sesión activa
    if (sessions.has(normalized)) {
      const session = sessions.get(normalized);
      clearTimers(session);
      sessions.delete(normalized);
    }
    
    // Borrar de pendientes
    removePendingQuote(normalized);
    
    if (PROFILES_PERSIST) saveProfilesToDisk();
    if (SESSIONS_PERSIST) saveSessionsToDisk();
    
    console.log(`❌ Contacto ELIMINADO: ${normalized}`);
    
    // Notificar a todos los paneles
    io.emit("contact_deleted", { waId: normalized });
  });
  
  socket.on("disconnect", () => {
    console.log("🔌 Panel desconectado:", socket.id);
  });
});

/**
 ============================
 WEBHOOKS META
 ============================
 */
app.post("/webhook", (req, res) => {
  res.sendStatus(200);

  (async () => {
    try {
      if (!verifyMetaSignature(req)) {
        console.log("⚠️ Firma Meta inválida");
        return;
      }

      const ownerDigits = normalizeCRPhone(OWNER_PHONE);

      const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
      for (const entry of entries) {
        const changes = Array.isArray(entry?.changes) ? entry.changes : [];
        for (const ch of changes) {
          const messages = ch?.value?.messages;
          if (!Array.isArray(messages)) continue;

          for (const msg of messages) {
            const msgId = msg?.id;
            if (isDuplicateMessage(msgId)) continue;

            const from = normalizeCRPhone(msg.from);

            // El dueño no se procesa por el bot (usa el panel)
            if (ownerDigits && from === ownerDigits) continue;

            let text = "";
            let hasImage = false;
            let imageId = null;

            if (msg.type === "text") {
              text = msg.text?.body || "";
            } else if (msg.type === "image") {
              hasImage = true;
              imageId = msg.image?.id;
              text = msg.image?.caption || "";
            } else if (msg.type === "interactive") {
              const i = msg.interactive;
              text = i?.button_reply?.id || i?.list_reply?.id || "";
            } else {
              continue;
            }

            await handleClientMessage(from, text, hasImage, imageId);
          }
        }
      }
    } catch (e) {
      console.error("❌ Webhook async error:", e);
    }
  })();
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

/**
 ============================
 ENDPOINTS API
 ============================
 */
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// API para obtener imágenes de WhatsApp
app.get("/api/image/:imageId", async (req, res) => {
  const { imageId } = req.params;
  
  if (!WHATSAPP_TOKEN || !imageId) {
    return res.status(400).send("No image");
  }
  
  try {
    // Primero obtener la URL de la imagen
    const mediaUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${imageId}`;
    const mediaRes = await fetchFn(mediaUrl, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    });
    
    if (!mediaRes.ok) {
      return res.status(404).send("Image not found");
    }
    
    const mediaData = await mediaRes.json();
    const imageUrl = mediaData.url;
    
    if (!imageUrl) {
      return res.status(404).send("No URL");
    }
    
    // Descargar la imagen
    const imageRes = await fetchFn(imageUrl, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    });
    
    if (!imageRes.ok) {
      return res.status(404).send("Download failed");
    }
    
    // Obtener el content-type
    const contentType = imageRes.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    
    // Stream la imagen
    const buffer = await imageRes.arrayBuffer();
    res.send(Buffer.from(buffer));
    
  } catch (e) {
    console.log("⚠️ Error obteniendo imagen:", e?.message);
    res.status(500).send("Error");
  }
});

app.get("/status", (req, res) => {
  if (ADMIN_KEY && req.query.key !== ADMIN_KEY)
    return res.status(401).send("Unauthorized");

  ensureMonthlyReset();

  res.json({
    account: {
      month: account.month_key,
      tokens: { total: tokensTotal(), used: account.tokens_used, remaining: tokensRemaining() },
      metrics: account.metrics,
    },
    sessions: { total: sessions.size },
    config: {
      store: STORE_NAME,
      type: STORE_TYPE,
      hours: HOURS_DAY,
      panel: "✅ Activo",
    },
  });
});

app.get("/inbox", (req, res) => {
  if (ADMIN_KEY && req.query.key !== ADMIN_KEY)
    return res.status(401).send("Unauthorized");
  res.json({ pending: Array.from(pendingQuotes.values()), count: pendingQuotes.size });
});

/**
 ============================
 GARBAGE COLLECTOR
 ============================
 */
const GC_INTERVAL_MS = 10 * 60 * 1000;
const SESSION_GC_MS = 6 * 60 * 60 * 1000;
const PHOTO_GC_MS = 2 * 60 * 1000;

setInterval(() => {
  const now = Date.now();

  for (const [id, s] of sessions.entries()) {
    const inactive = now - (s.last_activity || 0) > SESSION_GC_MS;
    const closed = s.state === "CERRADO_TIMEOUT";
    if (inactive && closed) {
      clearTimers(s);
      sessions.delete(id);
    }
  }

  for (const [id, b] of photoBuffers.entries()) {
    if (!b) continue;
    const lastSeen = Number(b.last_seen || 0);
    if (lastSeen && now - lastSeen > PHOTO_GC_MS) {
      if (b.timer) clearTimeout(b.timer);
      photoBuffers.delete(id);
    }
  }

  for (const [id, ts] of processedMsgIds.entries()) {
    if (now - ts > DEDUPE_TTL_MS) processedMsgIds.delete(id);
  }
}, GC_INTERVAL_MS);

/**
 ============================
 KEEP-ALIVE
 ============================
 */
setInterval(() => {
  console.log("⏰ Keep-alive | Pendientes:", pendingQuotes.size, "| Sesiones:", sessions.size);
}, 5 * 60 * 1000);

/**
 ============================
 INICIAR SERVIDOR
 ============================
 */
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  loadProfilesFromDisk();
  loadSessionsFromDisk();
  loadStatsFromDisk();

  console.log(`
╔═══════════════════════════════════════════════════╗
║  🤖 TICO-BOT con PANEL WEB                        ║
╠═══════════════════════════════════════════════════╣
║  📍 Puerto: ${String(PORT).padEnd(37)}║
║  🏪 Tienda: ${STORE_NAME.slice(0, 36).padEnd(37)}║
║  🔐 PIN Panel: ${PANEL_PIN.padEnd(34)}║
║  🎟️ Fichas: ${String(tokensRemaining() + "/" + tokensTotal()).padEnd(36)}║
║  🤖 IA: ${(OPENAI_API_KEY ? "Activa" : "Inactiva").padEnd(41)}║
╠═══════════════════════════════════════════════════╣
║  📱 Panel: http://localhost:${PORT}/                  ║
╚═══════════════════════════════════════════════════╝
  `);

  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.log("⚠️ Modo SIM: faltan credenciales WhatsApp");
  }
});
