const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

// ✅ SERVIDOR PRIMERO - Railway necesita esto inmediatamente
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor iniciado en puerto ${PORT}`);
});

// Health check INMEDIATO
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

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
 VARIABLES (Railway ENV)
 ============================
 */
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "tico_verify_123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const OWNER_PHONE = process.env.OWNER_PHONE || "";
const APP_SECRET = process.env.APP_SECRET || "";

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

const STATS_PERSIST = String(process.env.STATS_PERSIST || "") === "1";
const SESSIONS_PERSIST = String(process.env.SESSIONS_PERSIST || "") === "1";

const SESSION_TIMEOUT_HOURS = Number(process.env.SESSION_TIMEOUT_HOURS || 2);
const PHOTO_WAIT_SECONDS = Number(process.env.PHOTO_WAIT_SECONDS || 5);

const SINPE_SMS_SECRET = process.env.SINPE_SMS_SECRET || "";
const SINPE_WAIT_MINUTES = Number(process.env.SINPE_WAIT_MINUTES || 3);

const PRO_REMINDER = String(process.env.PRO_REMINDER || "") === "1";

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
    : (CATALOG_URL ? [CATALOG_URL] : []);

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

/**
 ============================
 ESTADO EN MEMORIA
 ============================
 */
const sessions = new Map();
const CLOSE_AFTER_MS = SESSION_TIMEOUT_HOURS * 60 * 60 * 1000;

const photoBuffers = new Map();
const sinpeWaitTimers = new Map();
const pendingQuotes = new Map();

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
 PAGINACIÓN INBOX (dueño)
 ============================
 */
const ownerInboxPage = new Map();
const INBOX_PAGE_SIZE = 10;
function getOwnerPage(ownerWaId) {
  return Number(ownerInboxPage.get(ownerWaId) || 0);
}
function setOwnerPage(ownerWaId, page) {
  ownerInboxPage.set(ownerWaId, Math.max(0, Number(page) || 0));
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

/**
 ============================
 PENDIENTES
 ============================
 */
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
      details_log: [],

      sent_to_seller: false,
      last_activity: Date.now(),

      close_timer: null,
      reminder_timer: null,

      last_offer: null,
      delivery_method: null,

      pending_sinpe: null,
      shipping_details: null,
      sinpe_reference: null,

      paused: false,

      ai_used_count: 0,
      message_history: [],
    });
    account.metrics.new_contacts += 1;
    if (STATS_PERSIST) saveStatsToDisk();
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
        await sendWhatsApp(
          session.waId,
          `Hola, ¿todavía estás interesad@ en el producto? 🙌\n\nPrecio: ₡${total.toLocaleString()}\n\nSi querés, podés reenviar la foto.`
        );
      }
    }, CLOSE_AFTER_MS);
  }

  const closeDelay = PRO_REMINDER ? CLOSE_AFTER_MS + 60 * 60 * 1000 : CLOSE_AFTER_MS;
  session.close_timer = setTimeout(() => {
    session.state = "CERRADO_TIMEOUT";
    removePendingQuote(session.waId);
    account.metrics.closed_timeout += 1;
    if (SESSIONS_PERSIST) saveSessionsToDisk();
    if (STATS_PERSIST) saveStatsToDisk();
  }, closeDelay);
}

function resetCase(session) {
  session.state = "ESPERANDO_DETALLES";
  session.last_image_id = null;
  session.last_details_text = null;
  session.details_log = [];
  session.sent_to_seller = false;
  session.last_offer = null;
  session.delivery_method = null;
  session.pending_sinpe = null;
  session.shipping_details = null;
  session.sinpe_reference = null;
  session.ai_used_count = 0;
  session.message_history = [];
  removePendingQuote(session.waId);
}

/**
 ============================
 HISTORIAL MENSAJES (IA)
 ============================
 */
function addToMessageHistory(session, role, content) {
  if (!Array.isArray(session.message_history)) session.message_history = [];
  session.message_history.push({ role, content, timestamp: Date.now() });
  if (session.message_history.length > 5) session.message_history = session.message_history.slice(-5);
}
function getRecentMessages(session) {
  if (!session.message_history || session.message_history.length === 0) return "";
  return session.message_history.slice(-5).map((m) => `${m.role}: ${m.content}`).join("\n");
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
    buffer = { photos: [], timer: null };
    photoBuffers.set(waId, buffer);
  }

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
 TIMEOUT VERIFICACIÓN SINPE
 ============================
 */
function startSinpeWaitTimer(waId, session) {
  if (sinpeWaitTimers.has(waId)) clearTimeout(sinpeWaitTimers.get(waId));

  const timer = setTimeout(async () => {
    sinpeWaitTimers.delete(waId);
    if (session.state === "ESPERANDO_SINPE" && session.pending_sinpe?.status === "pending") {
      await notifyOwner(
        `⚠️ No se detectó SINPE automático\n📱 ${waId}\n🔑 Ref: ${session.sinpe_reference}\n💵 ₡${session.pending_sinpe?.expectedAmount?.toLocaleString() || "?"}\n\nComprobar manual: ${waId} pagado`
      );
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
 FRASES TICAS (no repetir)
 ============================
 */
const FRASES = {
  revisando: ["Dame un toque, voy a revisar 👍", "Dejame chequearlo, ya te digo 👌", "Un momento, voy a fijarme 🙌", "Ya te confirmo, dame un ratito 😊", "Voy a revisar de una vez 👍"],
  saludos: ["¡Hola! Pura vida 🙌", "¡Hola! ¿Cómo estás? 🙌", "¡Hola! Qué gusto 👋", "¡Buenas! Pura vida 🙌", "¡Hola! Con gusto te ayudo 😊"],
  si_hay: ["¡Sí lo tenemos! 🎉", "¡Claro que sí! Lo tenemos 🙌", "¡Sí hay! 🎉", "¡Afirmativo! Sí lo tenemos 👍", "¡Qué dicha, sí hay! 🙌"],
  confirmacion: ["¡Buenísimo! 🙌", "¡Perfecto! 🎉", "¡Qué bien! 🙌", "¡Excelente! 👍", "¡Dale! 🙌"],
  no_quiere: ["Con gusto 🙌 Si ves algo más, mandame la foto.", "Está bien 🙌 Cualquier cosa aquí estamos.", "No hay problema 👍 Si ocupás algo, me avisás.", "Dale 🙌 Si te interesa otra cosa, con gusto.", "Perfecto 🙌 Aquí estamos para cuando gustés."],
  no_hay: ["Gracias por esperar 🙌 No tenemos ese producto ahora. Si querés, mandame foto de otro.", "Qué lástima 😔 Ese no lo tenemos. ¿Te interesa ver algo más?", "Uy, ese se nos agotó 🙌 ¿Querés ver otra opción?", "No lo tenemos disponible 😔 Pero si ves otro, con gusto te ayudo."],
  gracias: ["¡Gracias! 🙌", "¡Pura vida! 🙌", "¡Gracias por la confianza! 💪", "¡Tuanis! 🙌", "¡Con mucho gusto! 😊"],
};

const lastUsed = new Map();
function fraseNoRepetir(tipo, sessionId = "global") {
  const opciones = FRASES[tipo] || [""];
  const key = `${tipo}_${sessionId}`;
  const last = lastUsed.get(key) || "";
  const disponibles = opciones.filter((f) => f !== last);
  const elegida = disponibles.length > 0 ? disponibles[Math.floor(Math.random() * disponibles.length)] : opciones[0];
  lastUsed.set(key, elegida);
  return elegida;
}
function msgOutOfTokens() {
  return `⚠️ Se acabaron las fichas del mes 🙌\n\nPara seguir, activá un pack: ${PACK_TOKENS} fichas por ₡${PACK_PRICE_CRC}`;
}

/**
 ============================
 DETECCIÓN SIMPLE
 ============================
 */
function isGreeting(text) {
  const t = String(text || "").toLowerCase();
  return ["hola", "buenas", "buenos dias", "buen día", "pura vida"].some((k) => t.includes(k));
}
function isYes(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["si", "sí", "sii", "claro", "lo quiero", "dale", "va", "listo", "ok", "de una"].some((k) => t === k || t.startsWith(k));
}
function isNo(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["no", "nop", "solo viendo", "gracias", "luego"].some((k) => t === k || t.startsWith(k));
}
function detectDeliveryMethod(text) {
  const t = String(text || "").trim().toLowerCase();
  if (t.includes("envio") || t.includes("envío") || t === "si" || t === "sí") return "envio";
  if (t.includes("recoger") || t.includes("retiro") || t.includes("tienda") || t === "no") return "recoger";
  return null;
}

/**
 ============================
 WHATSAPP API (texto, imagen, botones, lista)
 ============================
 */
async function sendWhatsApp(toWaId, bodyText) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.log("📤 [SIM]", toWaId, ":", String(bodyText).slice(0, 160));
    return;
  }
  try {
    await fetchFn(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: toWaId,
        type: "text",
        text: { body: String(bodyText || "") },
      }),
    });
  } catch (e) {
    console.log("⚠️ Error WhatsApp:", e?.message);
  }
}

async function sendImage(toWaId, imageId, caption = "") {
  if (!imageId) return;
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.log("📤 [SIM-IMG]", toWaId, imageId, String(caption).slice(0, 120));
    return;
  }
  try {
    await fetchFn(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: toWaId,
        type: "image",
        image: { id: imageId, caption: String(caption || "") },
      }),
    });
  } catch (e) {
    console.log("⚠️ Error imagen:", e?.message);
    if (caption) await sendWhatsApp(toWaId, caption);
  }
}

async function sendButtons(toWaId, bodyText, buttons) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.log("📤 [SIM-BUTTONS]", toWaId, bodyText, buttons);
    return;
  }
  try {
    await fetchFn(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: toWaId,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: String(bodyText || "") },
          action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
        },
      }),
    });
  } catch (e) {
    console.log("⚠️ Error botones:", e?.message);
    await sendWhatsApp(toWaId, bodyText);
  }
}

async function sendList(toWaId, bodyText, buttonText, sectionTitle, rows) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.log("📤 [SIM-LIST]", toWaId, bodyText, rows);
    return;
  }
  try {
    await fetchFn(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: toWaId,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: String(bodyText || "") },
          action: {
            button: buttonText || "Ver",
            sections: [{
              title: sectionTitle || "Pendientes",
              rows: rows.slice(0, 10).map((r) => ({
                id: r.id,
                title: String(r.title).slice(0, 24),
                description: String(r.description || "").slice(0, 72),
              })),
            }],
          },
        },
      }),
    });
  } catch (e) {
    console.log("⚠️ Error list:", e?.message);
    let msg = String(bodyText || "") + "\n\n";
    for (const r of rows.slice(0, 10)) msg += `📱 ${r.title}\n📝 ${r.description}\n\n`;
    await sendWhatsApp(toWaId, msg.trim());
  }
}

/**
 ============================
 NOTIFY OWNER (siempre manda imagen si viene)
 ============================
 */
async function notifyOwner(message, imageId = null) {
  console.log("📢 DUEÑO:", message);
  if (!OWNER_PHONE) return;
  if (imageId) return sendImage(OWNER_PHONE, imageId, message);
  return sendWhatsApp(OWNER_PHONE, message);
}

/**
 ============================
 INBOX LIST (dueño) - viejos primero + paginación
 ============================
 */
function buildInboxPageRows(page) {
  const all = Array.from(pendingQuotes.values()).sort((a, b) => {
    const ta = Date.parse(a?.created_at || "") || 0;
    const tb = Date.parse(b?.created_at || "") || 0;
    return ta - tb;
  });

  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(total / INBOX_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);

  const start = safePage * INBOX_PAGE_SIZE;
  const slice = all.slice(start, start + INBOX_PAGE_SIZE);

  const rows = slice.map((p) => ({
    id: `PEND_${p.waId}`,
    title: p.waId,
    description: (p.details || "").slice(0, 70),
  }));

  if (safePage > 0) rows.push({ id: `INBOX_PREV_${safePage - 1}`, title: "⬅️ Anterior", description: `Página ${safePage} de ${totalPages}` });
  if (safePage < totalPages - 1) rows.push({ id: `INBOX_NEXT_${safePage + 1}`, title: "➡️ Siguiente", description: `Página ${safePage + 2} de ${totalPages}` });

  return { rows, safePage, totalPages, total };
}

async function showInboxList(ownerWaId, page = 0) {
  if (pendingQuotes.size === 0) {
    await sendWhatsApp(ownerWaId, "📥 No hay pendientes");
    return;
  }
  const { rows, safePage, totalPages, total } = buildInboxPageRows(page);
  setOwnerPage(ownerWaId, safePage);

  await sendList(
    ownerWaId,
    `📥 Pendientes: ${total}\nPágina ${safePage + 1}/${totalPages}\n\nTocá un cliente para que te mande el número listo para copiar/pegar.`,
    "Ver pendientes",
    "Pendientes",
    rows
  );
}

/**
 ============================
 PARSEO COMANDO DUEÑO (con número)
 ============================
 */
function parseOwnerCommand(text) {
  const t = String(text || "").trim();
  const parts = t.split(/\s+/);
  if (parts.length < 2) return null;

  const clientNum = parts[0].replace(/[^\d]/g, "");
  if (clientNum.length < 8) return null;

  const cmd = parts[1].toLowerCase();
  if (cmd === "pagado" || cmd === "pago" || cmd === "ok") return { type: "PAGADO", clientWaId: clientNum };
  if (cmd === "0" || cmd === "no" || cmd === "nohay" || cmd === "agotado") return { type: "NO_HAY", clientWaId: clientNum };
  if (cmd === "pausa" || cmd === "pausar" || cmd === "stop") return { type: "PAUSA", clientWaId: clientNum };
  if (cmd === "bot" || cmd === "reanudar" || cmd === "activar") return { type: "REANUDAR", clientWaId: clientNum };
  if (cmd === "cat" || cmd === "catalogo" || cmd === "catálogo") return { type: "CATALOGO", clientWaId: clientNum };

  const priceStr = parts[1].replace(/[^\d-]/g, "");
  if (priceStr.includes("-")) {
    const [p, s] = priceStr.split("-");
    const price = Number(p);
    const shipping = Number(s);
    if (price > 0) return { type: "PRECIO", clientWaId: clientNum, price, shipping: shipping > 0 ? shipping : null };
  } else {
    const price = Number(priceStr);
    if (price > 0) return { type: "PRECIO", clientWaId: clientNum, price, shipping: null };
  }
  return null;
}

/**
 ============================
 HANDLER DUEÑO (inbox + resolve + acciones)
 ============================
 */
async function handleOwnerCommand(waId, text) {
  const raw = String(text || "").trim();
  const tnorm = norm(raw);

  if (tnorm === "pendientes" || tnorm === "inbox") {
    await showInboxList(waId, 0);
    return true;
  }

  if (tnorm.startsWith("inbox_next_")) {
    const nextPage = Number(raw.replace(/^INBOX_NEXT_/i, "")) || 0;
    await showInboxList(waId, nextPage);
    return true;
  }
  if (tnorm.startsWith("inbox_prev_")) {
    const prevPage = Number(raw.replace(/^INBOX_PREV_/i, "")) || 0;
    await showInboxList(waId, prevPage);
    return true;
  }

  if (tnorm === "inbox_back") {
    await showInboxList(waId, getOwnerPage(waId));
    return true;
  }

  if (tnorm.startsWith("resolve_")) {
    const num = raw.replace(/^RESOLVE_/i, "").replace(/[^\d]/g, "");
    if (pendingQuotes.has(num)) {
      removePendingQuote(num);
      await sendWhatsApp(waId, `✅ Marcado como resuelto: ${num}`);
    } else {
      await sendWhatsApp(waId, `ℹ️ Ese pendiente ya no está: ${num}`);
    }
    await showInboxList(waId, getOwnerPage(waId));
    return true;
  }

  if (tnorm.startsWith("pend_")) {
    const num = raw.replace(/^PEND_/i, "").replace(/[^\d]/g, "");
    const p = pendingQuotes.get(num);
    const details = p?.details ? `📝 ${p.details}\n\n` : "";

    const msg =
`✅ Copiá y pegá el número (y agregá precio):

${details}📱 ${num}

Ejemplos:
${num} 7500
${num} 7500-2500
${num} 0
${num} pagado`;

    await sendButtons(waId, msg, [
      { id: `RESOLVE_${num}`, title: "✅ Resuelto" },
      { id: "INBOX_BACK", title: "📥 Pendientes" },
    ]);
    return true;
  }

  const cmd = parseOwnerCommand(raw);
  if (!cmd) return false;

  const clientSession = getSession(cmd.clientWaId);

  if (["PRECIO", "NO_HAY", "PAGADO"].includes(cmd.type)) removePendingQuote(cmd.clientWaId);

  if (cmd.type === "PRECIO") {
    const { price, shipping } = cmd;
    clientSession.last_offer = { price, shipping: shipping || 0 };
    clientSession.state = "PRECIO_ENVIADO";
    account.metrics.quotes_sent += 1;
    if (STATS_PERSIST) saveStatsToDisk();

    const shippingText = shipping ? `\nEnvío: ₡${Number(shipping).toLocaleString()}` : "";
    const total = price + (shipping || 0);

    await sendButtons(
      cmd.clientWaId,
      `${fraseNoRepetir("si_hay", cmd.clientWaId)}\n\nPrecio: ₡${price.toLocaleString()}${shippingText}\nTotal: ₡${total.toLocaleString()}\n\n¿Lo querés?`,
      [
        { id: "BTN_YES", title: "Sí, lo quiero" },
        { id: "BTN_NO", title: "No, gracias" },
        { id: "BTN_MORE", title: "Enviar otra foto" },
      ]
    );

    await sendWhatsApp(waId, `✅ Precio enviado`);
    resetCloseTimer(clientSession);
    return true;
  }

  if (cmd.type === "NO_HAY") {
    account.metrics.no_stock += 1;
    if (STATS_PERSIST) saveStatsToDisk();

    await sendWhatsApp(cmd.clientWaId, fraseNoRepetir("no_hay", cmd.clientWaId));
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
    if (STATS_PERSIST) saveStatsToDisk();
    cancelSinpeWaitTimer(cmd.clientWaId);

    const deliveryMsg =
      clientSession.delivery_method === "envio"
        ? `Se enviará a: ${clientSession.shipping_details}\nLlegada: ${DELIVERY_DAYS}`
        : (hasPhysicalLocation()
            ? `Podés recogerlo en: ${STORE_ADDRESS}\n${HOURS_DAY}`
            : "Te contactamos para coordinar");

    await sendWhatsApp(cmd.clientWaId, `¡Pago confirmado! ${fraseNoRepetir("gracias", cmd.clientWaId)}\n\n${deliveryMsg}`);
    await sendWhatsApp(waId, `✅ Pago confirmado`);

    setTimeout(() => {
      if (clientSession.state === "PAGO_CONFIRMADO") resetCase(clientSession);
    }, 24 * 60 * 60 * 1000);

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

  const critical = [
    "PRECIO_ENVIADO",
    "PREGUNTANDO_METODO",
    "PIDIENDO_DATOS",
    "PIDIENDO_DATOS_RECOGER",
    "ESPERANDO_SINPE",
    "PAGO_CONFIRMADO",
    "CERRADO_TIMEOUT",
    "ESPERANDO_CONFIRMACION_VENDEDOR",
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

  const systemPrompt = `Sos un asistente de ventas de ${STORE_NAME} en WhatsApp.
REGLA CRÍTICA:
- Si preguntan precio/stock/técnico: "Dejame revisar eso y ya te confirmo 🙌"
- NUNCA inventés datos
- Máximo 2 líneas
- 1 emoji al final
INFO:
- Horario: ${HOURS_DAY}
${offersShipping() ? `- Envíos: GAM ${SHIPPING_GAM}, Rural ${SHIPPING_RURAL}` : "- NO hacemos envíos"}
${hasPhysicalLocation() ? `- Dirección: ${STORE_ADDRESS}` : ""}
- Garantía: ${WARRANTY_DAYS}
CONTEXTO:
${recentContext || "Primera interacción"}
Devolvé SOLO JSON:
{"reply":"texto 1-2 líneas con emoji"}`;

  try {
    const response = await fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: String(text || "") }],
        temperature: 0.3,
        max_tokens: 120,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const parsed = JSON.parse(data.choices[0].message.content);

    account.metrics.ai_calls += 1;
    if (STATS_PERSIST) saveStatsToDisk();
    return parsed;
  } catch {
    return null;
  }
}

/**
 ============================
 HANDLER CLIENTE (COMPLETO)
 ============================
 */
async function handleClientMessage(waId, text, hasImage, imageId) {
  ensureMonthlyReset();

  const session = getSession(waId);
  session.last_activity = Date.now();
  account.metrics.chats_total += 1;
  if (STATS_PERSIST) saveStatsToDisk();

  if (text === "BTN_YES") text = "si";
  if (text === "BTN_NO") text = "no";
  if (text === "BTN_MORE") text = "otra foto";
  if (text === "BTN_ENVIO") text = "envio";
  if (text === "BTN_RECOGER") text = "recoger";
  if (text === "BTN_YAPAGUE") text = "ya pague";

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
      await sendWhatsApp(
        waId,
        `Pura vida 🙌 A esta hora la bodega ya está cerrada.\nMandáme foto y detalles (talla/color) y mañana te confirmo apenas abran. 😊`
      );
      return;
    }
  }

  if (hasImage) {
    handlePhotoBuffer(waId, imageId, text, async (photos) => {
      const details = String(text || "").trim() || "(sin detalles)";
      session.last_image_id = photos[0]?.imageId || null;
      session.last_details_text = details;

      session.details_log = Array.isArray(session.details_log) ? session.details_log : [];
      session.details_log.push({ at: new Date().toISOString(), details, count: photos.length });
      if (session.details_log.length > 5) session.details_log = session.details_log.slice(-5);

      session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
      account.metrics.quotes_requested += 1;
      if (STATS_PERSIST) saveStatsToDisk();

      await sendWhatsApp(waId, fraseNoRepetir("revisando", waId));
      addPendingQuote(session);

      await notifyOwner(
        `📸 Cliente: ${waId}\n📝 ${details}\n📷 Fotos: ${photos.length}\n\nCopiá y pegá:\n${waId} 7500\n${waId} 7500-2500\n${waId} 0`,
        photos[0]?.imageId || null
      );

      for (let i = 1; i < photos.length; i++) {
        await notifyOwner(`Foto ${i + 1}/${photos.length} (cliente ${waId})`, photos[i]?.imageId || null);
      }

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

  if (session.state === "PRECIO_ENVIADO") {
    if (isYes(text)) {
      if (!canConsumeToken()) return sendWhatsApp(waId, msgOutOfTokens());
      consumeToken("INTENCION_SI");
      account.metrics.intent_yes += 1;
      if (STATS_PERSIST) saveStatsToDisk();

      if (offersShipping() && offersPickup()) {
        await sendButtons(waId, `${fraseNoRepetir("confirmacion", waId)}\n\n¿Cómo lo preferís?`, [
          { id: "BTN_ENVIO", title: "Envío" },
          { id: "BTN_RECOGER", title: "Recoger" },
        ]);
        session.state = "PREGUNTANDO_METODO";
        resetCloseTimer(session);
        return;
      }

      if (offersShipping() && !offersPickup()) {
        session.delivery_method = "envio";
        account.metrics.delivery_envio += 1;
        if (STATS_PERSIST) saveStatsToDisk();
        await sendWhatsApp(waId, `${fraseNoRepetir("confirmacion", waId)}\n\nPasame nombre completo, dirección exacta y teléfono 📝`);
        session.state = "PIDIENDO_DATOS";
        resetCloseTimer(session);
        return;
      }

      if (!offersShipping() && offersPickup()) {
        session.delivery_method = "recoger";
        account.metrics.delivery_recoger += 1;
        if (STATS_PERSIST) saveStatsToDisk();
        const msg = hasPhysicalLocation()
          ? `${fraseNoRepetir("confirmacion", waId)}\n\n📍 ${STORE_ADDRESS}\n🕒 ${HOURS_DAY}\n\nNombre y teléfono:`
          : `${fraseNoRepetir("confirmacion", waId)}\n\nNombre y teléfono:`;
        await sendWhatsApp(waId, msg);
        session.state = "PIDIENDO_DATOS_RECOGER";
        resetCloseTimer(session);
        return;
      }
    }

    if (isNo(text)) {
      account.metrics.intent_no += 1;
      if (STATS_PERSIST) saveStatsToDisk();
      await sendWhatsApp(waId, fraseNoRepetir("no_quiere", waId));
      resetCase(session);
      return;
    }

    if (norm(text).includes("otra foto")) {
      await sendWhatsApp(waId, "Dale 🙌 Mandame la foto del producto 📸");
      resetCase(session);
      return;
    }
  }

  if (session.state === "PREGUNTANDO_METODO") {
    const method = detectDeliveryMethod(text);
    if (method === "envio") {
      session.delivery_method = "envio";
      account.metrics.delivery_envio += 1;
      if (STATS_PERSIST) saveStatsToDisk();
      await sendWhatsApp(waId, `¡Listo! 🙌\n\nNombre completo, dirección exacta y teléfono 📝`);
      session.state = "PIDIENDO_DATOS";
      resetCloseTimer(session);
      return;
    }
    if (method === "recoger") {
      session.delivery_method = "recoger";
      account.metrics.delivery_recoger += 1;
      if (STATS_PERSIST) saveStatsToDisk();
      await sendWhatsApp(waId, `Perfecto 🏪\n\n📍 ${STORE_ADDRESS}\n🕒 ${HOURS_DAY}\n\nNombre y teléfono:`);
      session.state = "PIDIENDO_DATOS_RECOGER";
      resetCloseTimer(session);
      return;
    }
  }

  if (session.state === "PIDIENDO_DATOS" || session.state === "PIDIENDO_DATOS_RECOGER") {
    session.shipping_details = String(text || "");
    session.sinpe_reference = generateSinpeReference(waId);

    const price = session.last_offer?.price || 0;
    const shipping = session.last_offer?.shipping || 0;
    const total = price + shipping;

    await sendButtons(
      waId,
      `¡Perfecto! 🙌\n\nTotal: ₡${total.toLocaleString()}\n\nSINPE: ${SINPE_NUMBER}\nTitular: ${SINPE_NAME}\nRef: ${session.sinpe_reference}\n\nCuando lo hagás, tocá "Ya pagué" 💳`,
      [{ id: "BTN_YAPAGUE", title: "Ya pagué" }, { id: "BTN_MORE", title: "Enviar otra foto" }]
    );

    session.pending_sinpe = { status: "pending", expectedAmount: total, created_at: new Date().toISOString() };
    session.state = "ESPERANDO_SINPE";

    if (SINPE_SMS_SECRET) startSinpeWaitTimer(waId, session);

    await notifyOwner(
      `💳 Cliente: ${waId}\n🔑 Ref: ${session.sinpe_reference}\n💵 ₡${total.toLocaleString()}\n📝 ${session.shipping_details}\n\nResponder: ${waId} pagado`
    );

    resetCloseTimer(session);
    return;
  }

  if (session.state === "ESPERANDO_SINPE") {
    const lower = norm(text);
    if (lower.includes("listo") || lower.includes("pague") || lower.includes("pagué") || lower.includes("transferi") || lower.includes("ya")) {
      await sendWhatsApp(waId, "Recibido 🙌 Déjame verificarlo.");
      await notifyOwner(`⚠️ ${waId} dice que pagó\n🔑 Ref: ${session.sinpe_reference}\n\nResponder: ${waId} pagado`);
      return;
    }
  }

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

  if (isGreeting(text) && String(text || "").length < 25) {
    const catalogMsg = getCatalogLinks();
    const greeting = `${fraseNoRepetir("saludos", waId)}\n\n${catalogMsg ? catalogMsg + "\n\n" : ""}Mandáme una foto del producto que te interesa 📸`;
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

  if (shouldUseAI(session, text, hasImage)) {
    const ai = await aiHandleMessage(text, session);
    if (ai?.reply) {
      session.ai_used_count += 1;
      addToMessageHistory(session, "assistant", ai.reply);
      await sendWhatsApp(waId, ai.reply);
      return;
    }
  }

  const catalogMsg = !session.catalog_sent ? getCatalogLinks() : "";
  const fallback = catalogMsg ? `${catalogMsg}\n\nMandáme una foto del producto 📸` : "Mandáme una foto del producto 📸";
  await sendWhatsApp(waId, fallback);
  if (catalogMsg) session.catalog_sent = true;
}

/**
 ============================
 WEBHOOKS + ENDPOINTS
 ============================
 */
app.post("/webhook", async (req, res) => {
  try {
    if (!verifyMetaSignature(req)) {
      console.log("⚠️ Firma Meta inválida");
      return res.sendStatus(403);
    }

    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages) return res.sendStatus(200);

    for (const msg of messages) {
      const msgId = msg?.id;
      if (isDuplicateMessage(msgId)) {
        console.log("🔁 Duplicado ignorado:", msgId);
        continue;
      }

      const waId = msg.from;

      if (OWNER_PHONE && waId === OWNER_PHONE) {
        if (msg.type === "text") {
          await handleOwnerCommand(waId, msg.text?.body || "");
        } else if (msg.type === "interactive") {
          const i = msg.interactive;
          const id = i?.button_reply?.id || i?.list_reply?.id || "";
          await handleOwnerCommand(waId, id);
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
      } else if (msg.type === "interactive") {
        const i = msg.interactive;
        text = i?.button_reply?.id || i?.list_reply?.id || "";
      } else {
        continue;
      }

      await handleClientMessage(waId, text, hasImage, imageId);
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("❌ Webhook:", e);
    return res.sendStatus(500);
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

  const activeSessions = Array.from(sessions.values()).filter((s) => s.state !== "CERRADO_TIMEOUT");

  res.json({
    account: {
      month: account.month_key,
      tokens: { total: tokensTotal(), used: account.tokens_used, remaining: tokensRemaining() },
      metrics: account.metrics,
    },
    sessions: { total: sessions.size, active: activeSessions.length },
    config: {
      store: STORE_NAME,
      type: STORE_TYPE,
      hours: HOURS_DAY,
      sinpe: SINPE_NUMBER ? "✅" : "❌",
      catalog: (CATALOG_URL || CATALOG_URLS) ? "✅" : "❌",
      ai: OPENAI_API_KEY ? "✅" : "❌",
      security: APP_SECRET ? "✅" : "❌",
      persist: {
        sessions: SESSIONS_PERSIST ? "✅" : "❌",
        stats: STATS_PERSIST ? "✅" : "❌",
      },
    },
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
  if (STATS_PERSIST) saveStatsToDisk();
  res.json({ success: true, tokens: tokensTotal(), remaining: tokensRemaining() });
});

app.get("/", (req, res) => {
  res.send(
    `<h1>${STORE_NAME} - TICO-bot 🤖</h1>
     <p>Tipo: ${STORE_TYPE}</p>
     <p>Fichas: ${tokensRemaining()}/${tokensTotal()}</p>
     <p>IA: ${OPENAI_API_KEY ? "✅" : "❌"} (${account.metrics.ai_calls} llamadas)</p>`
  );
});

// Keep-alive para evitar sleep
setInterval(() => {
  console.log("⏰ Keep-alive");
}, 5 * 60 * 1000);

// ✅ Cargar datos DESPUÉS de que el servidor esté listo
setTimeout(() => {
  loadSessionsFromDisk();
  loadStatsFromDisk();
  console.log(
    `\n🤖 TICO-BOT | Puerto ${PORT} | ${STORE_NAME} (${STORE_TYPE})\n` +
      `🎟️ Fichas: ${tokensRemaining()}/${tokensTotal()} | 🤖 IA: ${OPENAI_API_KEY ? "ON" : "OFF"}\n` +
      `🔒 Seguridad: ${APP_SECRET ? "ON" : "OFF"} | 💾 Persistencia: S=${SESSIONS_PERSIST ? "ON" : "OFF"} | M=${STATS_PERSIST ? "ON" : "OFF"}\n`
  );
}, 100);
