const express = require("express");
const crypto = require("crypto");
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

// Telegram (Notificaciones al dueño)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// Tienda (1 cuenta por instancia)
const STORE_NAME = process.env.STORE_NAME || "TICO-bot";
const CATALOG_URL = process.env.CATALOG_URL || "";
const STORE_TYPE = (process.env.STORE_TYPE || "virtual").toLowerCase(); // virtual | fisica
const MAPS_URL = process.env.MAPS_URL || "";

// Horario de atención (para modo diurno/nocturno)
const HOURS_START = Number(process.env.HOURS_START || 9);  // 9 AM
const HOURS_END = Number(process.env.HOURS_END || 19);     // 7 PM
const HOURS_DAY = process.env.HOURS_DAY || `${HOURS_START}am-${HOURS_END > 12 ? HOURS_END - 12 : HOURS_END}pm`;

// SINPE (para mostrarle al cliente)
const SINPE_NUMBER = process.env.SINPE_NUMBER || "";
const SINPE_NAME = process.env.SINPE_NAME || "";

// Plan / Fichas
const MONTHLY_TOKENS = Number(process.env.MONTHLY_TOKENS || 100);
const PACK_TOKENS = Number(process.env.PACK_TOKENS || 10);
const PACK_PRICE_CRC = Number(process.env.PACK_PRICE_CRC || 1000);

// Admin
const ADMIN_KEY = process.env.ADMIN_KEY || "";

// Dominio base (para links completos)
const BASE_URL = process.env.BASE_URL || "";

// Persistencia
const TOKENS_PERSIST = String(process.env.TOKENS_PERSIST || "") === "1";
const STATS_PERSIST = String(process.env.STATS_PERSIST || "") === "1";
const SESSIONS_PERSIST = String(process.env.SESSIONS_PERSIST || "") === "1";

// SINPE SMS (PRO)
const SINPE_SMS_SECRET = process.env.SINPE_SMS_SECRET || "";
const SINPE_SMS_LOOKBACK_MIN = Number(process.env.SINPE_SMS_LOOKBACK_MIN || 30);

/**
 * ============================
 *  UTILIDADES DE TIEMPO
 * ============================
 */
function getCostaRicaHour() {
  // Costa Rica es UTC-6 (sin horario de verano)
  const now = new Date();
  const utcHour = now.getUTCHours();
  const crHour = (utcHour - 6 + 24) % 24;
  return crHour;
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
 *  ESTADO EN MEMORIA (MVP)
 * ============================
 */
const sessions = new Map();
const CLOSE_AFTER_MS = 2 * 60 * 60 * 1000; // 2 horas

function currentMonthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function previousMonthKey(monthKey) {
  const [yStr, mStr] = String(monthKey).split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const date = new Date(y, m - 1, 1);
  date.setMonth(date.getMonth() - 1);
  return currentMonthKey(date);
}

/**
 * ============================
 *  PERSISTENCIA DE SESIONES
 * ============================
 */
const SESSIONS_FILE = path.join(process.cwd(), "sessions.json");

function loadSessionsFromDisk() {
  if (!SESSIONS_PERSIST) return;
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const raw = fs.readFileSync(SESSIONS_FILE, "utf-8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const s of arr) {
        if (s?.waId) {
          // Restaurar sin timers (se recrean al siguiente mensaje)
          s.close_timer = null;
          sessions.set(s.waId, s);
        }
      }
      console.log(`📱 Sesiones cargadas: ${sessions.size}`);
    }
  } catch (e) {
    console.log("⚠️ No pude cargar sessions.json:", e?.message || e);
  }
}

function saveSessionsToDisk() {
  if (!SESSIONS_PERSIST) return;
  try {
    const arr = Array.from(sessions.values()).map(s => {
      const copy = { ...s };
      delete copy.close_timer; // No serializar timers
      return copy;
    });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(arr, null, 2), "utf-8");
  } catch (e) {
    console.log("⚠️ No pude guardar sessions.json:", e?.message || e);
  }
}

// Guardar sesiones cada 5 minutos
setInterval(() => {
  if (SESSIONS_PERSIST && sessions.size > 0) {
    saveSessionsToDisk();
    console.log(`💾 Sesiones guardadas: ${sessions.size}`);
  }
}, 5 * 60 * 1000);

loadSessionsFromDisk();

/**
 * ============================
 *  STATS MENSUALES (últimos 3 meses)
 * ============================
 */
const STATS_FILE = path.join(process.cwd(), "stats_monthly.json");
const statsMonthly = new Map();

function loadStatsFromDisk() {
  if (!STATS_PERSIST) return;
  try {
    if (!fs.existsSync(STATS_FILE)) return;
    const raw = fs.readFileSync(STATS_FILE, "utf-8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const s of arr) if (s?.month) statsMonthly.set(s.month, s);
      console.log(`📊 Stats mensuales cargados: ${statsMonthly.size}`);
    }
  } catch (e) {
    console.log("⚠️ No pude cargar stats_monthly.json:", e?.message || e);
  }
}

function saveStatsToDisk() {
  if (!STATS_PERSIST) return;
  try {
    const arr = Array.from(statsMonthly.values());
    fs.writeFileSync(STATS_FILE, JSON.stringify(arr, null, 2), "utf-8");
  } catch (e) {
    console.log("⚠️ No pude guardar stats_monthly.json:", e?.message || e);
  }
}

loadStatsFromDisk();

/**
 * ============================
 *  CUENTA ÚNICA (1 tienda)
 * ============================
 */
const account = {
  month_key: currentMonthKey(),
  monthly_tokens: MONTHLY_TOKENS,
  tokens_used: 0,
  tokens_packs_added: 0,
  pack_tokens: PACK_TOKENS,
  pack_price_crc: PACK_PRICE_CRC,
  metrics: {
    chats_total: 0,
    new_contacts: 0,
    quotes_requested: 0,
    quotes_sent: 0,
    no_stock: 0,
    intent_yes: 0,
    intent_no: 0,
    closed_timeout: 0,
    night_leads: 0,
    sinpe_sms_received: 0,
    sinpe_auto_confirmed: 0,
    sinpe_manual_confirmed: 0,
  },
};

function tokensTotal() { return account.monthly_tokens + account.tokens_packs_added; }
function tokensRemaining() { return Math.max(0, tokensTotal() - account.tokens_used); }
function canConsumeToken() { return tokensRemaining() > 0; }

function consumeToken(reason = "INTENCION_SI") {
  if (!canConsumeToken()) return false;
  account.tokens_used += 1;
  console.log(`🪙 Ficha consumida (${reason}). Restantes: ${tokensRemaining()}/${tokensTotal()}`);
  return true;
}

function snapshotCurrentMonth() {
  return {
    store: STORE_NAME,
    month: account.month_key,
    tokens: {
      monthly: account.monthly_tokens,
      packs_added: account.tokens_packs_added,
      total: tokensTotal(),
      used: account.tokens_used,
      remaining: tokensRemaining(),
      pack_tokens: account.pack_tokens,
      pack_price_crc: account.pack_price_crc,
    },
    metrics: account.metrics,
    created_at: new Date().toISOString(),
  };
}

function ensureMonthlyResetIfNeeded() {
  const key = currentMonthKey();
  if (account.month_key === key) return;

  const prev = snapshotCurrentMonth();
  statsMonthly.set(prev.month, prev);

  if (STATS_PERSIST) {
    const m0 = key;
    const m1 = previousMonthKey(m0);
    const m2 = previousMonthKey(m1);
    const keep = new Set([m0, m1, m2]);
    for (const k of statsMonthly.keys()) if (!keep.has(k)) statsMonthly.delete(k);
    saveStatsToDisk();
  }

  account.month_key = key;
  account.tokens_used = 0;
  account.tokens_packs_added = 0;
  account.metrics = {
    chats_total: 0,
    new_contacts: 0,
    quotes_requested: 0,
    quotes_sent: 0,
    no_stock: 0,
    intent_yes: 0,
    intent_no: 0,
    closed_timeout: 0,
    night_leads: 0,
    sinpe_sms_received: 0,
    sinpe_auto_confirmed: 0,
    sinpe_manual_confirmed: 0,
  };

  console.log(`🔄 Reset mensual aplicado: ${key}`);
}

/**
 * ============================
 *  ADMIN INBOX (pendientes de precio)
 * ============================
 */
const pendingQuotes = new Map();
const nightLeads = new Map(); // Leads nocturnos para procesar en la mañana

function addPendingQuote(session) {
  pendingQuotes.set(session.waId, {
    waId: session.waId,
    details: session.last_details_text || "(sin detalle)",
    last_image_id: session.last_image_id || null,
    created_at: new Date().toISOString(),
    is_night_lead: !isDaytime(),
  });
}

function removePendingQuote(waId) {
  pendingQuotes.delete(waId);
}

function addNightLead(session) {
  nightLeads.set(session.waId, {
    waId: session.waId,
    details: session.last_details_text || "(sin detalle)",
    last_image_id: session.last_image_id || null,
    created_at: new Date().toISOString(),
  });
  account.metrics.night_leads += 1;
}

/**
 * ============================
 *  SESIÓN POR CLIENTE
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
      pending_sinpe: null,
      shipping_details: null,
      sinpe_reference: null, // Referencia única para matching
    });
    account.metrics.new_contacts += 1;
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
    session.last_offer = null;
    session.pending_sinpe = null;
    session.shipping_details = null;
    session.sinpe_reference = null;
    removePendingQuote(session.waId);
    account.metrics.closed_timeout += 1;
    console.log(`⏱️ Caso cerrado por timeout (2h): ${session.waId}`);
    
    if (SESSIONS_PERSIST) saveSessionsToDisk();
  }, CLOSE_AFTER_MS);
}

function resetCaseForNewPhoto(session) {
  session.state = "ESPERANDO_DETALLES";
  session.last_image_id = null;
  session.last_details_text = null;
  session.sent_to_seller = false;
  session.last_offer = null;
  session.pending_sinpe = null;
  session.shipping_details = null;
  session.sinpe_reference = null;
  removePendingQuote(session.waId);
}

/**
 * ============================
 *  GENERADOR DE REFERENCIA SINPE
 * ============================
 */
function generateSinpeReference(waId) {
  // Genera una referencia corta única basada en los últimos 4 dígitos + timestamp
  const last4 = waId.slice(-4);
  const timestamp = Date.now().toString(36).slice(-4).toUpperCase();
  return `${last4}${timestamp}`;
}

/**
 * ============================
 *  TEXTO HUMANO TICO
 * ============================
 */
const FIXED_ASK_DETAILS = "¿Qué talla, tamaño, color u otra característica buscás?";
const PREFIXES_TICOS = ["Déjame revisar 🙌", "Un toque y reviso 👌", "Ya te confirmo, dame un chance 😊"];

function pickPrefix(session) {
  const last = session.last_prefix || "";
  const options = PREFIXES_TICOS.filter((p) => p !== last);
  const chosen = options[Math.floor(Math.random() * options.length)];
  session.last_prefix = chosen;
  return chosen;
}

function msgAskDetails(session) {
  return `${pickPrefix(session)}\n${FIXED_ASK_DETAILS}`;
}

function msgOutOfTokens() {
  const sinpeLine = SINPE_NUMBER
    ? `\n💳 SINPE: ${SINPE_NUMBER}${SINPE_NAME ? ` (${SINPE_NAME})` : ""}`
    : "";
  return `⚠️ Este mes ya se usaron todas las fichas del plan 🙌

Para seguir atendiendo intenciones de compra, activá un pack extra:
✅ ${PACK_TOKENS} fichas por ₡${PACK_PRICE_CRC}${sinpeLine}

Cuando lo activés, me avisás y seguimos 👌`;
}

function msgNightMode() {
  return `🌙 ${getTimeGreeting()}! A esta hora nuestro equipo está descansando, pero no queremos que te quedés sin tu producto.

Mandame la foto de lo que te interesa y decime talla, color o tamaño. Mañana a primera hora (${HOURS_START}:00 AM) serás de los primeros en recibir confirmación de disponibilidad y precio 👌`;
}

function msgNightConfirmation() {
  return `¡Perfecto! 🌙 Ya quedó registrado tu pedido.

Mañana temprano te confirmo si lo tenemos y el precio. ¡Gracias por la confianza! 💪`;
}

/**
 * ============================
 *  DETECCIÓN DE DETALLE MÍNIMO
 * ============================
 */
const COLORS = ["negro","blanco","rojo","azul","verde","gris","beige","café","cafe","morado","rosado","amarillo","naranja","plateado","dorado","celeste","turquesa","vino","coral"];

function hasSize(text) {
  const t = (text || "").toLowerCase();
  if (/\b(x{0,3}l|xxl|xl|xs|s|m|l)\b/i.test(t)) return true;
  if (t.includes("talla")) return true;
  if (/\b(3[0-9]|4[0-9]|[5-9]|1[0-2])\b/.test(t)) return true;
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

  const low = t.toLowerCase();
  const genericOnly =
    low === "?" ||
    low.includes("precio") ||
    low.includes("cuanto") ||
    low.includes("cuánto") ||
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
  return ["hola","buenas","buenos dias","buen día","buenas tardes","buenas noches","hello","que tal","qué tal"].some((k) => t.includes(k));
}

/**
 * ============================
 *  INTENCIÓN (SI/NO)
 * ============================
 */
function isYes(text) {
  const t = (text || "").trim().toLowerCase();
  return ["si","sí","sii","claro","me interesa","lo quiero","quiero","dale","va","listo","ok","okay","bueno","perfecto","de una"].some((k) => t === k || t.includes(k));
}

function isNo(text) {
  const t = (text || "").trim().toLowerCase();
  return ["no","nop","solo viendo","solo estoy viendo","estoy viendo","gracias","luego","después","despues","ya no"].some((k) => t === k || t.includes(k));
}

/**
 * ============================
 *  TELEGRAM NOTIFICATIONS
 * ============================
 */
async function sendTelegramNotification(message, inlineKeyboard = null) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("⚠️ Telegram no configurado. Mensaje:", message);
    return false;
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body = {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML",
    };

    if (inlineKeyboard) {
      body.reply_markup = { inline_keyboard: inlineKeyboard };
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    if (!data.ok) {
      console.log("⚠️ Error Telegram:", data.description);
      return false;
    }
    return true;
  } catch (e) {
    console.log("⚠️ Error enviando a Telegram:", e?.message || e);
    return false;
  }
}

async function notifyNewQuoteRequest(session) {
  const baseUrl = BASE_URL ? BASE_URL.replace(/\/$/, "") : "TU_URL";
  const waId = session.waId;
  const details = session.last_details_text || "(sin detalle)";
  const isNight = !isDaytime();

  const emoji = isNight ? "🌙" : "📦";
  const timeTag = isNight ? " [NOCTURNO]" : "";

  const message = `${emoji} <b>Nueva consulta${timeTag}</b>

📱 Cliente: ${waId}
📝 Detalle: ${details}

<b>Responder:</b>
• Con precio: /precio_${waId.slice(-8)}_MONTO
• Sin stock: /nostock_${waId.slice(-8)}

O usar panel:
${baseUrl}/admin/inbox?key=${ADMIN_KEY}`;

  // Botones inline para respuesta rápida
  const keyboard = [
    [
      { text: "✅ Hay (₡5000)", callback_data: `price_${waId}_5000` },
      { text: "✅ Hay (₡10000)", callback_data: `price_${waId}_10000` },
    ],
    [
      { text: "✅ Hay (₡15000)", callback_data: `price_${waId}_15000` },
      { text: "❌ Agotado", callback_data: `nostock_${waId}` },
    ],
  ];

  await sendTelegramNotification(message, keyboard);
}

async function notifyMorningSummary() {
  if (nightLeads.size === 0) return;

  const leads = Array.from(nightLeads.values());
  let message = `☀️ <b>Resumen Matutino</b>\n\n`;
  message += `Tenés <b>${leads.length}</b> cliente(s) esperando respuesta:\n\n`;

  leads.forEach((lead, i) => {
    message += `${i + 1}. 📱 ${lead.waId}\n   📝 ${lead.details}\n\n`;
  });

  const baseUrl = BASE_URL ? BASE_URL.replace(/\/$/, "") : "TU_URL";
  message += `\n🔗 Panel: ${baseUrl}/admin/inbox?key=${ADMIN_KEY}`;

  await sendTelegramNotification(message);
}

/**
 * ============================
 *  WHATSAPP helper
 * ============================
 */
async function sendWhatsAppText(toWaId, bodyText) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.log("⚠️ WhatsApp send desactivado (faltan credenciales).");
    console.log("↳ Respuesta:", { toWaId, bodyText });
    return;
  }

  try {
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
  } catch (e) {
    console.log("⚠️ Error enviando WhatsApp:", e?.message || e);
  }
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

    const waId = sanitizeWaId(contact?.wa_id || msg.from);
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
 *  VALIDACIÓN Y SANITIZACIÓN
 * ============================
 */
function sanitizeWaId(waId) {
  // Solo permite números, máximo 15 dígitos (formato E.164)
  const cleaned = String(waId || "").replace(/[^\d]/g, "");
  if (cleaned.length < 8 || cleaned.length > 15) return null;
  return cleaned;
}

function isValidPrice(price) {
  const num = Number(price);
  return Number.isFinite(num) && num > 0 && num < 10000000; // Max ₡10M
}

/**
 * ============================
 *  SINPE SMS (PRO)
 * ============================
 */
function nowMs() { return Date.now(); }
function minutesAgoMs(min) { return nowMs() - min * 60 * 1000; }

function parseSinpeSms(bodyText = "") {
  const t = String(bodyText || "").replace(/\s+/g, " ").trim();

  let amount = null;
  const m = t.match(/Ha\s+recibido\s+([\d.,]+)\s+Colones/i);
  if (m) {
    const cleaned = m[1].replace(/,/g, "");
    amount = Number(cleaned);
  }
  if (!amount) {
    const m2 = t.match(/₡\s*([\d.,]+)/);
    if (m2) amount = Number(m2[1].replace(/,/g, ""));
  }

  let payer = null;
  const p = t.match(/\bColones\s+de\s+(.+?)\s+por\s+SINPE/i);
  if (p) payer = p[1].trim();

  let reference = null;
  // Buscar referencia en formato "Descripción: XXXX" o al final del mensaje
  const r = t.match(/(?:Descripci[oó]n|Detalle|Ref)[\s:]+([A-Z0-9]{6,12})/i);
  if (r) reference = r[1].toUpperCase();

  return { 
    raw: t, 
    amount: Number.isFinite(amount) ? amount : null, 
    payer, 
    reference 
  };
}

function setPendingSinpe(session, expectedAmount) {
  const reference = generateSinpeReference(session.waId);
  session.state = "ESPERANDO_SINPE";
  session.sinpe_reference = reference;
  session.pending_sinpe = {
    expectedAmount: expectedAmount || null,
    reference: reference,
    created_at: new Date().toISOString(),
    created_ms: nowMs(),
    status: "pending",
  };
  return reference;
}

/**
 * ============================
 *  ENDPOINTS
 * ============================
 */
app.get("/", (req, res) => res.send("OK - TICO-bot v2 ✅"));

/**
 * ============================
 *  STATUS (Admin)
 * ============================
 */
app.get("/status", (req, res) => {
  ensureMonthlyResetIfNeeded();
  if (!ADMIN_KEY) return res.status(403).send("Forbidden");
  if (String(req.query.key || "") !== String(ADMIN_KEY)) return res.status(403).send("Forbidden");

  return res.json({
    store: STORE_NAME,
    month: account.month_key,
    current_hour_cr: getCostaRicaHour(),
    is_daytime: isDaytime(),
    hours: { start: HOURS_START, end: HOURS_END, display: HOURS_DAY },
    tokens: {
      monthly: account.monthly_tokens,
      packs_added: account.tokens_packs_added,
      total: tokensTotal(),
      used: account.tokens_used,
      remaining: tokensRemaining(),
      pack_tokens: account.pack_tokens,
      pack_price_crc: account.pack_price_crc,
    },
    metrics: account.metrics,
    sessions_active: sessions.size,
    pending_quotes: pendingQuotes.size,
    night_leads: nightLeads.size,
    pro: {
      telegram_enabled: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
      sinpe_sms_enabled: Boolean(SINPE_SMS_SECRET),
      sessions_persist: SESSIONS_PERSIST,
    },
  });
});

/**
 * ============================
 *  ADMIN: inbox de pendientes
 * ============================
 */
app.get("/admin/inbox", (req, res) => {
  ensureMonthlyResetIfNeeded();
  if (!ADMIN_KEY || String(req.query.key || "") !== String(ADMIN_KEY)) return res.status(403).send("Forbidden");

  const list = Array.from(pendingQuotes.values()).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const nightList = Array.from(nightLeads.values()).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  return res.json({ 
    ok: true, 
    is_daytime: isDaytime(),
    pending: { count: list.length, items: list },
    night_leads: { count: nightList.length, items: nightList },
  });
});

/**
 * ============================
 *  ADMIN: responder precio
 * ============================
 */
app.get("/admin/reply", async (req, res) => {
  ensureMonthlyResetIfNeeded();
  if (!ADMIN_KEY || String(req.query.key || "") !== String(ADMIN_KEY)) return res.status(403).send("Forbidden");

  const waId = sanitizeWaId(req.query.waId);
  if (!waId) return res.status(400).json({ ok: false, error: "waId inválido" });

  const priceRaw = String(req.query.price || "").replace(/[^\d]/g, "");
  const price = Number(priceRaw);
  if (!isValidPrice(price)) return res.status(400).json({ ok: false, error: "precio inválido" });

  const shippingRaw = String(req.query.shipping || "").trim();
  const shipping = shippingRaw ? Number(shippingRaw.replace(/[^\d]/g, "")) : null;

  const session = getSession(waId);
  resetCloseTimer(session);

  account.metrics.quotes_sent += 1;
  session.state = "PRECIO_ENVIADO";
  session.sent_to_seller = false;
  session.last_offer = { price, shipping };

  removePendingQuote(waId);
  nightLeads.delete(waId);

  const envioTxt = shipping ? ` + envío ₡${shipping.toLocaleString()}` : "";
  await sendWhatsAppText(
    waId,
    `¡Sí lo tenemos! 🎉\nTe sale en ₡${price.toLocaleString()}${envioTxt}.\n\n¿Te interesa comprarlo?\nRespondé:\n👉 SÍ → para continuar\n👉 NO → si solo estás viendo`
  );

  if (SESSIONS_PERSIST) saveSessionsToDisk();

  return res.json({ ok: true, waId, price, shipping });
});

/**
 * ============================
 *  ADMIN: no hay stock
 * ============================
 */
app.get("/admin/no-stock", async (req, res) => {
  ensureMonthlyResetIfNeeded();
  if (!ADMIN_KEY || String(req.query.key || "") !== String(ADMIN_KEY)) return res.status(403).send("Forbidden");

  const waId = sanitizeWaId(req.query.waId);
  if (!waId) return res.status(400).json({ ok: false, error: "waId inválido" });

  const session = getSession(waId);
  resetCloseTimer(session);

  account.metrics.no_stock += 1;
  session.state = "CERRADO_SIN_COSTO";
  session.sent_to_seller = false;
  session.last_offer = null;

  removePendingQuote(waId);
  nightLeads.delete(waId);

  await sendWhatsAppText(waId, `Gracias por esperar 🙌 En este momento no tenemos disponibilidad de ese producto. Si querés, mandame foto de otro y te ayudo.`);

  if (SESSIONS_PERSIST) saveSessionsToDisk();

  return res.json({ ok: true, waId });
});

/**
 * ============================
 *  ADMIN: confirmar pago manual
 * ============================
 */
app.get("/admin/confirm-payment", async (req, res) => {
  ensureMonthlyResetIfNeeded();
  if (!ADMIN_KEY || String(req.query.key || "") !== String(ADMIN_KEY)) return res.status(403).send("Forbidden");

  const waId = sanitizeWaId(req.query.waId);
  if (!waId) return res.status(400).json({ ok: false, error: "waId inválido" });

  const session = getSession(waId);
  
  if (session.state !== "ESPERANDO_SINPE") {
    return res.status(400).json({ ok: false, error: "cliente no está esperando pago" });
  }

  session.pending_sinpe.status = "paid";
  session.pending_sinpe.paid_at = new Date().toISOString();
  session.pending_sinpe.confirmed_by = "manual";
  session.state = "PAGO_CONFIRMADO";
  account.metrics.sinpe_manual_confirmed += 1;

  await sendWhatsAppText(
    waId,
    `¡Listo! 🙌 Ya confirmamos tu pago. En un toque te avisamos cuando esté listo tu pedido. ¡Gracias!`
  );

  if (SESSIONS_PERSIST) saveSessionsToDisk();

  return res.json({ ok: true, waId });
});

/**
 * ============================
 *  REPORTES (Admin)
 * ============================
 */
app.get("/admin/report", (req, res) => {
  ensureMonthlyResetIfNeeded();
  if (!ADMIN_KEY || String(req.query.key || "") !== String(ADMIN_KEY)) return res.status(403).send("Forbidden");

  const mode = String(req.query.mode || "").trim().toLowerCase();
  const current = snapshotCurrentMonth();
  statsMonthly.set(current.month, current);

  if (mode !== "last3") return res.json({ current });

  const m0 = account.month_key;
  const m1 = previousMonthKey(m0);
  const m2 = previousMonthKey(m1);
  const last3 = [m0, m1, m2].map((m) => statsMonthly.get(m)).filter(Boolean);
  return res.json({ months: [m0, m1, m2], last3 });
});

/**
 * ============================
 *  ADMIN: agregar pack de fichas
 * ============================
 */
app.get("/admin/add-pack", (req, res) => {
  ensureMonthlyResetIfNeeded();
  if (!ADMIN_KEY || String(req.query.key || "") !== String(ADMIN_KEY)) return res.status(403).send("Forbidden");

  const packs = Math.max(1, Number(req.query.packs || 1));
  account.tokens_packs_added += packs * PACK_TOKENS;

  return res.json({
    ok: true,
    packs_added: packs,
    tokens_packs_added: account.tokens_packs_added,
    total_tokens: tokensTotal(),
    remaining: tokensRemaining(),
  });
});

/**
 * ============================
 *  ADMIN: trigger resumen matutino
 * ============================
 */
app.get("/admin/morning-summary", async (req, res) => {
  if (!ADMIN_KEY || String(req.query.key || "") !== String(ADMIN_KEY)) return res.status(403).send("Forbidden");

  await notifyMorningSummary();
  return res.json({ ok: true, night_leads: nightLeads.size });
});

/**
 * ============================
 *  META: Verificación webhook
 * ============================
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
 * ============================
 *  WHATSAPP INBOUND
 * ============================
 */
app.post("/webhook", async (req, res) => {
  ensureMonthlyResetIfNeeded();

  const msg = extractMessage(req.body);
  if (!msg || !msg.waId) return res.sendStatus(200);

  const { waId, type, text, imageId, caption } = msg;
  account.metrics.chats_total += 1;

  const session = getSession(waId);
  session.last_activity = Date.now();
  resetCloseTimer(session);

  const isNight = !isDaytime();

  console.log("📩 WhatsApp:", { waId, type, text: text?.slice(0, 50), imageId, state: session.state, isNight });

  // ============================================
  // MODO NOCTURNO: Flujo "Caza-Clientes"
  // ============================================
  if (isNight) {
    // Saludo nocturno
    if (type === "text" && isGreeting(text)) {
      await sendWhatsAppText(waId, msgNightMode());
      return res.sendStatus(200);
    }

    // Foto nocturna
    if (type === "image") {
      resetCaseForNewPhoto(session);
      session.last_image_id = imageId;

      const captionText = (caption || "").trim();
      if (captionText && isMinimalDetail(captionText)) {
        session.last_details_text = captionText;
        session.state = "LEAD_NOCTURNO";
        addNightLead(session);
        await sendWhatsAppText(waId, msgNightConfirmation());
        
        // Notificar al dueño (puede ver en la mañana)
        await notifyNewQuoteRequest(session);
        
        if (SESSIONS_PERSIST) saveSessionsToDisk();
        return res.sendStatus(200);
      }

      session.state = "ESPERANDO_DETALLES_NOCHE";
      await sendWhatsAppText(
        waId,
        `🌙 ¡Gracias por mandarlo! Para dejarte en la lista de mañana, decime: ¿qué talla, color o tamaño buscás?`
      );
      return res.sendStatus(200);
    }

    // Texto nocturno (después de foto)
    if (type === "text" && session.last_image_id && session.state === "ESPERANDO_DETALLES_NOCHE") {
      if (isMinimalDetail(text)) {
        session.last_details_text = text;
        session.state = "LEAD_NOCTURNO";
        addNightLead(session);
        await sendWhatsAppText(waId, msgNightConfirmation());
        await notifyNewQuoteRequest(session);
        
        if (SESSIONS_PERSIST) saveSessionsToDisk();
        return res.sendStatus(200);
      }

      await sendWhatsAppText(
        waId,
        `🌙 Solo necesito un detalle más: ¿talla, color o tamaño? Así mañana te confirmo de una vez.`
      );
      return res.sendStatus(200);
    }

    // Cualquier otro mensaje nocturno
    if (type === "text") {
      await sendWhatsAppText(waId, msgNightMode());
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  }

  // ============================================
  // MODO DIURNO: Flujo Normal
  // ============================================

  // Si ya tenía precio y manda otra foto → nuevo caso
  if (type === "image" && session.state === "PRECIO_ENVIADO") {
    resetCaseForNewPhoto(session);
    session.last_image_id = imageId;

    await sendWhatsAppText(
      waId,
      `¡Pura vida! 🙌\n¿Te interesa ese otro? Decime talla, color o tamaño y te confirmo.`
    );

    const captionText = (caption || "").trim();
    if (captionText && isMinimalDetail(captionText)) {
      session.last_details_text = captionText;
      session.sent_to_seller = true;
      session.state = "ENVIADO_A_VENDEDOR";
      account.metrics.quotes_requested += 1;

      addPendingQuote(session);
      await notifyNewQuoteRequest(session);
    }
    
    if (SESSIONS_PERSIST) saveSessionsToDisk();
    return res.sendStatus(200);
  }

  // 1) Saludo
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

  // 2) Foto
  if (type === "image") {
    resetCaseForNewPhoto(session);
    session.last_image_id = imageId;
    session.sent_to_seller = false;

    const captionText = (caption || "").trim();

    if (captionText && isMinimalDetail(captionText)) {
      session.last_details_text = captionText;
      session.sent_to_seller = true;
      session.state = "ENVIADO_A_VENDEDOR";
      account.metrics.quotes_requested += 1;

      await sendWhatsAppText(waId, `Dame un toque, voy a revisar si lo tenemos 👍`);
      addPendingQuote(session);
      await notifyNewQuoteRequest(session);
      
      if (SESSIONS_PERSIST) saveSessionsToDisk();
      return res.sendStatus(200);
    }

    session.state = "ESPERANDO_DETALLES";
    await sendWhatsAppText(waId, msgAskDetails(session));
    return res.sendStatus(200);
  }

  // 3) Texto
  if (type === "text") {
    // 3A) SI/NO después de precio
    if (session.state === "PRECIO_ENVIADO") {
      if (isYes(text)) {
        if (!consumeToken("INTENCION_SI")) {
          await sendWhatsAppText(waId, msgOutOfTokens());
          return res.sendStatus(200);
        }

        account.metrics.intent_yes += 1;
        session.state = "INTENCION_CONFIRMADA";

        if (STORE_TYPE === "fisica") {
          await sendWhatsAppText(
            waId,
            `¡Buenísimo! 🙌\n¿Preferís envío o venir a recoger?\n\nRespondé:\n1️⃣ ENVÍO\n2️⃣ RECOGER`
          );
        } else {
          await sendWhatsAppText(
            waId,
            `¡Buenísimo! 🙌\nPara enviártelo, pasame:\n- Nombre completo\n- Dirección exacta\n- Teléfono\n\nY te confirmo el envío 👌`
          );
        }
        
        if (SESSIONS_PERSIST) saveSessionsToDisk();
        return res.sendStatus(200);
      }

      if (isNo(text)) {
        account.metrics.intent_no += 1;
        session.state = "CERRADO_SIN_COSTO";
        await sendWhatsAppText(waId, `Con gusto 🙌 Cualquier cosa aquí estamos. Si ves algo más, mandame la foto.`);
        return res.sendStatus(200);
      }

      await sendWhatsAppText(waId, `¿Te referís al producto anterior? Decime SÍ o NO 🙌`);
      return res.sendStatus(200);
    }

    // 3B) Tienda física: elegir ENVÍO o RECOGER
    if (STORE_TYPE === "fisica" && session.state === "INTENCION_CONFIRMADA") {
      const t = (text || "").trim().toLowerCase();

      if (t.includes("1") || t.includes("envio") || t.includes("envío")) {
        session.state = "PIDIENDO_DATOS_ENVIO";
        await sendWhatsAppText(
          waId,
          `Perfecto 🙌 Pasame:\n- Nombre completo\n- Dirección exacta\n- Teléfono\n\nY te confirmo el envío 👌`
        );
        return res.sendStatus(200);
      }

      if (t.includes("2") || t.includes("recoger") || t.includes("retiro") || t.includes("retirar")) {
        const expected = session.last_offer?.price ? Number(session.last_offer.price) : null;
        const reference = setPendingSinpe(session, expected);

        const sinpeLine = SINPE_NUMBER
          ? `💳 SINPE: ${SINPE_NUMBER}${SINPE_NAME ? ` (${SINPE_NAME})` : ""}`
          : `💳 SINPE: (configurar número)`;

        await sendWhatsAppText(
          waId,
          `Listo 🙌 Para apartarlo y tenerlo listo:\n\n${sinpeLine}\n\n⚠️ Importante: Poné como descripción del SINPE: <b>${reference}</b>\n\nCuando lo hagás, me avisás por aquí y te confirmo.`
        );
        
        if (SESSIONS_PERSIST) saveSessionsToDisk();
        return res.sendStatus(200);
      }

      await sendWhatsAppText(waId, `¿Me confirmás si querés 1️⃣ ENVÍO o 2️⃣ RECOGER? 🙌`);
      return res.sendStatus(200);
    }

    // 3C) Envío virtual: guardar datos
    if (STORE_TYPE === "virtual" && session.state === "INTENCION_CONFIRMADA") {
      session.shipping_details = (text || "").trim();
      
      const expected = session.last_offer?.price ? Number(session.last_offer.price) : null;
      const shipping = session.last_offer?.shipping ? Number(session.last_offer.shipping) : 0;
      const total = (expected || 0) + shipping;
      const reference = setPendingSinpe(session, total);

      const sinpeLine = SINPE_NUMBER
        ? `💳 SINPE: ${SINPE_NUMBER}${SINPE_NAME ? ` (${SINPE_NAME})` : ""}`
        : `💳 SINPE: (configurar número)`;

      await sendWhatsAppText(
        waId,
        `¡Perfecto! 🙌 Datos recibidos.\n\nTotal a pagar: ₡${total.toLocaleString()}\n\n${sinpeLine}\n\n⚠️ Poné como descripción: <b>${reference}</b>\n\nCuando hagás el SINPE, me avisás y te confirmo el envío.`
      );
      
      if (SESSIONS_PERSIST) saveSessionsToDisk();
      return res.sendStatus(200);
    }

    // 3D) Envío físico: guardar datos
    if (session.state === "PIDIENDO_DATOS_ENVIO") {
      session.shipping_details = (text || "").trim();
      
      const expected = session.last_offer?.price ? Number(session.last_offer.price) : null;
      const shipping = session.last_offer?.shipping ? Number(session.last_offer.shipping) : 0;
      const total = (expected || 0) + shipping;
      const reference = setPendingSinpe(session, total);

      const sinpeLine = SINPE_NUMBER
        ? `💳 SINPE: ${SINPE_NUMBER}${SINPE_NAME ? ` (${SINPE_NAME})` : ""}`
        : `💳 SINPE: (configurar número)`;

      await sendWhatsAppText(
        waId,
        `¡Perfecto! 🙌 Datos recibidos.\n\nTotal: ₡${total.toLocaleString()}\n\n${sinpeLine}\n\n⚠️ Poné como descripción: <b>${reference}</b>\n\nCuando hagás el SINPE, me avisás y coordinamos el envío.`
      );
      
      if (SESSIONS_PERSIST) saveSessionsToDisk();
      return res.sendStatus(200);
    }

    // 3E) Esperando SINPE - cliente avisa que pagó
    if (session.state === "ESPERANDO_SINPE") {
      const low = (text || "").toLowerCase();
      if (low.includes("listo") || low.includes("ya") || low.includes("pagu") || low.includes("sinpe") || low.includes("transferí") || low.includes("hice")) {
        await sendWhatsAppText(
          waId,
          `¡Gracias! 🙌 Dame un momento para verificar el pago...`
        );
        
        // Notificar al dueño para verificación manual si no hay auto-match
        await sendTelegramNotification(
          `💰 <b>Cliente dice que pagó</b>\n\n📱 ${waId}\n🔑 Ref: ${session.sinpe_reference || "N/A"}\n💵 Esperado: ₡${session.pending_sinpe?.expectedAmount?.toLocaleString() || "?"}\n\n/confirmar_${waId.slice(-8)}`
        );
        
        return res.sendStatus(200);
      }
    }

    // 3F) Texto después de foto (detalle mínimo)
    if (session.last_image_id && !session.sent_to_seller) {
      if (isMinimalDetail(text)) {
        session.last_details_text = text;
        session.sent_to_seller = true;
        session.state = "ENVIADO_A_VENDEDOR";
        account.metrics.quotes_requested += 1;

        await sendWhatsAppText(waId, `Dame un toque, voy a revisar si lo tenemos 👍`);
        addPendingQuote(session);
        await notifyNewQuoteRequest(session);
        
        if (SESSIONS_PERSIST) saveSessionsToDisk();
        return res.sendStatus(200);
      }

      session.state = "ESPERANDO_DETALLES";
      await sendWhatsAppText(waId, msgAskDetails(session));
      return res.sendStatus(200);
    }

    // 3G) FAQ
    const low = (text || "").toLowerCase();

    if (low.includes("horario") || low.includes("abren") || low.includes("cierran") || low.includes("atienden")) {
      await sendWhatsAppText(waId, `🕘 Horario de atención: ${HOURS_DAY}`);
      return res.sendStatus(200);
    }

    if (low.includes("ubic") || low.includes("donde") || low.includes("dónde") || low.includes("direc")) {
      if (STORE_TYPE === "fisica" && MAPS_URL) {
        await sendWhatsAppText(waId, `📍 Ubicación: ${MAPS_URL}`);
      } else {
        await sendWhatsAppText(waId, `Somos tienda virtual 🙌 Mandame la captura/foto del producto y te ayudo con gusto.`);
      }
      return res.sendStatus(200);
    }

    if (low.includes("precio") || low.includes("cuanto") || low.includes("cuánto") || low.includes("disponible") || low.includes("tienen")) {
      await sendWhatsAppText(
        waId,
        `Claro 🙌 Mandame la foto/captura del producto y decime talla, color o tamaño para confirmarte.`
      );
      return res.sendStatus(200);
    }

    if (low.includes("sinpe") || low.includes("pago") || low.includes("pagar")) {
      const sinpeLine = SINPE_NUMBER
        ? `💳 SINPE: ${SINPE_NUMBER}${SINPE_NAME ? ` (${SINPE_NAME})` : ""}`
        : `Aún no tenés un pedido activo.`;
      await sendWhatsAppText(waId, sinpeLine);
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
 *  TELEGRAM CALLBACK (Botones)
 * ============================
 */
app.post("/telegram-callback", async (req, res) => {
  try {
    const callback = req.body?.callback_query;
    if (!callback) return res.sendStatus(200);

    const data = callback.data || "";
    const chatId = callback.message?.chat?.id;

    // Responder al callback para quitar el "loading"
    if (TELEGRAM_BOT_TOKEN) {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: callback.id }),
      });
    }

    // Parsear: price_WAID_AMOUNT o nostock_WAID
    if (data.startsWith("price_")) {
      const parts = data.split("_");
      const waId = parts[1];
      const price = Number(parts[2]);

      if (waId && price) {
        const session = getSession(waId);
        resetCloseTimer(session);

        account.metrics.quotes_sent += 1;
        session.state = "PRECIO_ENVIADO";
        session.sent_to_seller = false;
        session.last_offer = { price, shipping: null };

        removePendingQuote(waId);
        nightLeads.delete(waId);

        await sendWhatsAppText(
          waId,
          `¡Sí lo tenemos! 🎉\nTe sale en ₡${price.toLocaleString()}.\n\n¿Te interesa comprarlo?\nRespondé:\n👉 SÍ → para continuar\n👉 NO → si solo estás viendo`
        );

        await sendTelegramNotification(`✅ Precio enviado a ${waId}: ₡${price.toLocaleString()}`);
        
        if (SESSIONS_PERSIST) saveSessionsToDisk();
      }
    } else if (data.startsWith("nostock_")) {
      const waId = data.replace("nostock_", "");

      if (waId) {
        const session = getSession(waId);
        resetCloseTimer(session);

        account.metrics.no_stock += 1;
        session.state = "CERRADO_SIN_COSTO";
        session.sent_to_seller = false;

        removePendingQuote(waId);
        nightLeads.delete(waId);

        await sendWhatsAppText(waId, `Gracias por esperar 🙌 En este momento no tenemos disponibilidad de ese producto.`);

        await sendTelegramNotification(`❌ Sin stock notificado a ${waId}`);
        
        if (SESSIONS_PERSIST) saveSessionsToDisk();
      }
    }

    return res.sendStatus(200);
  } catch (e) {
    console.log("⚠️ Error en telegram-callback:", e?.message || e);
    return res.sendStatus(200);
  }
});

/**
 * ============================
 *  SINPE SMS (PRO) - Webhook
 * ============================
 */
app.post("/sinpe-sms", async (req, res) => {
  try {
    ensureMonthlyResetIfNeeded();

    if (!SINPE_SMS_SECRET) return res.status(400).send("SINPE_SMS_SECRET no configurado");
    const header = String(req.headers["x-sinpe-secret"] || "");
    if (header !== SINPE_SMS_SECRET) return res.status(403).send("Forbidden");

    const body = String(req.body?.body || "");
    const received_at = String(req.body?.received_at || new Date().toISOString());

    account.metrics.sinpe_sms_received += 1;

    const parsed = parseSinpeSms(body);

    if (!parsed.amount) {
      return res.json({ ok: true, matched: false, reason: "no_amount", received_at });
    }

    const lookbackMs = minutesAgoMs(SINPE_SMS_LOOKBACK_MIN);

    // Primero: buscar por referencia exacta (más confiable)
    if (parsed.reference) {
      for (const s of sessions.values()) {
        if (s?.state === "ESPERANDO_SINPE" && 
            s?.pending_sinpe?.status === "pending" &&
            s?.sinpe_reference === parsed.reference) {
          
          s.pending_sinpe.status = "paid";
          s.pending_sinpe.paid_at = new Date().toISOString();
          s.pending_sinpe.matched_by = "reference";
          s.state = "PAGO_CONFIRMADO";
          account.metrics.sinpe_auto_confirmed += 1;

          await sendWhatsAppText(
            s.waId,
            `¡Listo! 🙌 Ya nos entró el SINPE. En un toque te confirmamos tu pedido. ¡Gracias!`
          );

          await sendTelegramNotification(`💰 <b>Pago confirmado automático</b>\n\n📱 ${s.waId}\n💵 ₡${parsed.amount.toLocaleString()}\n🔑 Ref: ${parsed.reference}`);

          if (SESSIONS_PERSIST) saveSessionsToDisk();

          return res.json({ 
            ok: true, 
            matched: true, 
            matched_by: "reference",
            waId: s.waId, 
            amount: parsed.amount, 
            reference: parsed.reference,
            received_at 
          });
        }
      }
    }

    // Fallback: buscar por monto (como antes)
    const candidates = [];
    for (const s of sessions.values()) {
      if (s?.state === "ESPERANDO_SINPE" && s?.pending_sinpe?.status === "pending") {
        const createdMs = Number(s.pending_sinpe.created_ms || 0);
        if (createdMs < lookbackMs) continue;

        const expected = Number(s.pending_sinpe.expectedAmount || 0);
        if (expected && expected === parsed.amount) candidates.push(s);
      }
    }

    if (candidates.length === 1) {
      const s = candidates[0];
      s.pending_sinpe.status = "paid";
      s.pending_sinpe.paid_at = new Date().toISOString();
      s.pending_sinpe.matched_by = "amount";
      s.state = "PAGO_CONFIRMADO";
      account.metrics.sinpe_auto_confirmed += 1;

      await sendWhatsAppText(
        s.waId,
        `¡Listo! 🙌 Ya nos entró el SINPE. En un toque te confirmamos tu pedido. ¡Gracias!`
      );

      await sendTelegramNotification(`💰 <b>Pago confirmado (por monto)</b>\n\n📱 ${s.waId}\n💵 ₡${parsed.amount.toLocaleString()}`);

      if (SESSIONS_PERSIST) saveSessionsToDisk();

      return res.json({ 
        ok: true, 
        matched: true, 
        matched_by: "amount",
        waId: s.waId, 
        amount: parsed.amount, 
        received_at 
      });
    }

    // No match único - notificar para revisión manual
    if (candidates.length > 1) {
      await sendTelegramNotification(
        `⚠️ <b>SINPE recibido - múltiples candidatos</b>\n\n💵 ₡${parsed.amount.toLocaleString()}\n👥 ${candidates.length} clientes esperando ese monto\n\nRevisar manualmente en el panel.`
      );
    }

    return res.json({
      ok: true,
      matched: false,
      reason: candidates.length > 1 ? "multiple_candidates" : "no_candidates",
      count: candidates.length,
      amount: parsed.amount,
      reference: parsed.reference,
      received_at,
    });
  } catch (e) {
    console.log("❌ Error en /sinpe-sms:", e?.message || e);
    return res.status(200).json({ ok: false });
  }
});

/**
 * ============================
 *  CRON: Resumen matutino (llamar desde Railway Cron o externo)
 * ============================
 */
app.get("/cron/morning", async (req, res) => {
  // Verificar que sea ~8am Costa Rica
  const hour = getCostaRicaHour();
  if (hour < 7 || hour > 9) {
    return res.json({ ok: false, reason: "not_morning", hour_cr: hour });
  }

  await notifyMorningSummary();
  
  // Mover night_leads a pending_quotes para procesamiento diurno
  for (const [waId, lead] of nightLeads.entries()) {
    pendingQuotes.set(waId, { ...lead, promoted_at: new Date().toISOString() });
  }
  
  const promoted = nightLeads.size;
  nightLeads.clear();

  return res.json({ ok: true, promoted, hour_cr: hour });
});

/**
 * ============================
 *  SERVER
 * ============================
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const base = BASE_URL ? BASE_URL.replace(/\/$/, "") : "(set BASE_URL)";
  console.log("🚀 TICO-bot v2 corriendo en puerto", PORT);
  console.log(`⏰ Hora Costa Rica: ${getCostaRicaHour()}:00 | ${isDaytime() ? "☀️ DIURNO" : "🌙 NOCTURNO"}`);
  console.log("✅ Endpoints:");
  console.log(`- Home: ${base}/`);
  console.log(`- Meta webhook: ${base}/webhook`);
  console.log(`- Telegram callback: ${base}/telegram-callback`);
  console.log(`- Status: ${base}/status?key=ADMIN_KEY`);
  console.log(`- Inbox: ${base}/admin/inbox?key=ADMIN_KEY`);
  console.log(`- Reply: ${base}/admin/reply?key=ADMIN_KEY&waId=506XXXXXXXX&price=7000`);
  console.log(`- No stock: ${base}/admin/no-stock?key=ADMIN_KEY&waId=506XXXXXXXX`);
  console.log(`- Confirm payment: ${base}/admin/confirm-payment?key=ADMIN_KEY&waId=506XXXXXXXX`);
  console.log(`- SINPE SMS: ${base}/sinpe-sms`);
  console.log(`- Cron morning: ${base}/cron/morning`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("📴 Guardando estado antes de cerrar...");
  if (SESSIONS_PERSIST) saveSessionsToDisk();
  if (STATS_PERSIST) saveStatsToDisk();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("📴 Guardando estado antes de cerrar...");
  if (SESSIONS_PERSIST) saveSessionsToDisk();
  if (STATS_PERSIST) saveStatsToDisk();
  process.exit(0);
});







