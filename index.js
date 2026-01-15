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
constAS
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";

// Tienda (1 cuenta por instancia)
const STORE_NAME = process.env.STORE_NAME || "TICO-bot";
const CATALOG_URL = process.env.CATALOG_URL || "";
const HOURS_DAY = process.env.HOURS_DAY || "9am-7pm";
const STORE_TYPE = (process.env.STORE_TYPE || "virtual").toLowerCase(); // virtual | fisica
const MAPS_URL = process.env.MAPS_URL || "";

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

// Persistencia (opcional)
const TOKENS_PERSIST = String(process.env.TOKENS_PERSIST || "") === "1"; // activations
const STATS_PERSIST = String(process.env.STATS_PERSIST || "") === "1";   // stats mensuales

// SINPE SMS (PRO)
const SINPE_SMS_SECRET = process.env.SINPE_SMS_SECRET || "";
const SINPE_SMS_LOOKBACK_MIN = Number(process.env.SINPE_SMS_LOOKBACK_MIN || 30);

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
 * Guardamos “casos” cuando el bot necesita que el dueño responda precio/stock.
 */
const pendingQuotes = new Map(); // waId -> { waId, details, created_at, last_image_id }

function addPendingQuote(session) {
  pendingQuotes.set(session.waId, {
    waId: session.waId,
    details: session.last_details_text || "(sin detalle)",
    last_image_id: session.last_image_id || null,
    created_at: new Date().toISOString(),
  });
}
function removePendingQuote(waId) {
  pendingQuotes.delete(waId);
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
      last_offer: null, // { price, shipping }
      pending_sinpe: null, // { expectedAmount, created_ms, status }
      shipping_details: null,
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
    removePendingQuote(session.waId);
    account.metrics.closed_timeout += 1;
    console.log(`⏱️ Caso cerrado por timeout (2h): ${session.waId}`);
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
  removePendingQuote(session.waId);
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

/**
 * ============================
 *  DETECCIÓN DE DETALLE MÍNIMO
 * ============================
 */
const COLORS = ["negro","blanco","rojo","azul","verde","gris","beige","café","cafe","morado","rosado","amarillo","naranja","plateado","dorado"];

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
  return ["hola","buenas","buenos dias","buen día","buenas tardes","buenas noches","hello"].some((k) => t.includes(k));
}

/**
 * ============================
 *  INTENCIÓN (SI/NO)
 * ============================
 */
function isYes(text) {
  const t = (text || "").trim().toLowerCase();
  return ["si","sí","sii","claro","me interesa","lo quiero","quiero","dale"].some((k) => t === k || t.includes(k));
}
function isNo(text) {
  const t = (text || "").trim().toLowerCase();
  return ["no","nop","solo viendo","solo estoy viendo","estoy viendo","gracias"].some((k) => t === k || t.includes(k));
}

/**
 * ============================
 *  WHATSAPP helper
 * ============================
 */
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
  const r = t.match(/\bReferencia\s+([0-9]{8,})/i);
  if (r) reference = r[1];

  return { raw: t, amount: Number.isFinite(amount) ? amount : null, payer, reference };
}

function setPendingSinpe(session, expectedAmount) {
  session.state = "ESPERANDO_SINPE";
  session.pending_sinpe = {
    expectedAmount: expectedAmount || null,
    created_at: new Date().toISOString(),
    created_ms: nowMs(),
    status: "pending",
  };
}

/**
 * ============================
 *  ENDPOINTS
 * ============================
 */
app.get("/", (req, res) => res.send("OK - TICO-bot vivo ✅"));

/**
 * ============================
 *  STATUS (Admin)
 *  GET /status?key=ADMIN_KEY
 * ============================
 */
app.get("/status", (req, res) => {
  ensureMonthlyResetIfNeeded();
  if (!ADMIN_KEY) return res.status(403).send("Forbidden");
  if (String(req.query.key || "") !== String(ADMIN_KEY)) return res.status(403).send("Forbidden");

  return res.json({
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
    sessions_active: sessions.size,
    pending_quotes: pendingQuotes.size,
    pro: {
      sinpe_sms_enabled: Boolean(SINPE_SMS_SECRET),
      sinpe_sms_lookback_min: SINPE_SMS_LOOKBACK_MIN,
    },
  });
});

/**
 * ============================
 *  ADMIN: inbox de pendientes
 *  GET /admin/inbox?key=ADMIN_KEY
 * ============================
 */
app.get("/admin/inbox", (req, res) => {
  ensureMonthlyResetIfNeeded();
  if (!ADMIN_KEY || String(req.query.key || "") !== String(ADMIN_KEY)) return res.status(403).send("Forbidden");

  const list = Array.from(pendingQuotes.values()).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return res.json({ ok: true, count: list.length, pending: list });
});

/**
 * ============================
 *  ADMIN: responder precio
 *  GET /admin/reply?key=ADMIN_KEY&waId=506XXXXXXXX&price=7000&shipping=2000
 * ============================
 */
app.get("/admin/reply", async (req, res) => {
  ensureMonthlyResetIfNeeded();
  if (!ADMIN_KEY || String(req.query.key || "") !== String(ADMIN_KEY)) return res.status(403).send("Forbidden");

  const waId = String(req.query.waId || "").trim();
  const price = Number(String(req.query.price || "").replace(/[^\d]/g, ""));
  const shippingRaw = String(req.query.shipping || "").trim();
  const shipping = shippingRaw ? Number(shippingRaw.replace(/[^\d]/g, "")) : null;

  if (!waId || !price) return res.status(400).json({ ok: false, error: "missing waId/price" });

  const session = getSession(waId);
  resetCloseTimer(session);

  account.metrics.quotes_sent += 1;
  session.state = "PRECIO_ENVIADO";
  session.sent_to_seller = false;
  session.last_offer = { price, shipping };

  removePendingQuote(waId);

  const envioTxt = shipping ? ` + envío ₡${shipping}` : "";
  await sendWhatsAppText(
    waId,
    `¡Sí lo tenemos! 🎉\nTe sale en ₡${price}${envioTxt}.\n\n¿Te interesa comprarlo?\nRespondé:\nSI → para continuar\nNO → si solo estás viendo`
  );

  return res.json({ ok: true, waId, price, shipping });
});

/**
 * ============================
 *  ADMIN: no hay stock
 *  GET /admin/no-stock?key=ADMIN_KEY&waId=506XXXXXXXX
 * ============================
 */
app.get("/admin/no-stock", async (req, res) => {
  ensureMonthlyResetIfNeeded();
  if (!ADMIN_KEY || String(req.query.key || "") !== String(ADMIN_KEY)) return res.status(403).send("Forbidden");

  const waId = String(req.query.waId || "").trim();
  if (!waId) return res.status(400).json({ ok: false, error: "missing waId" });

  const session = getSession(waId);
  resetCloseTimer(session);

  account.metrics.no_stock += 1;
  session.state = "CERRADO_SIN_COSTO";
  session.sent_to_seller = false;
  session.last_offer = null;

  removePendingQuote(waId);

  await sendWhatsAppText(waId, `Gracias por esperar 🙌 En este momento no tenemos disponibilidad de ese producto.`);
  return res.json({ ok: true, waId });
});

/**
 * ============================
 *  REPORTES (Admin)
 *  GET /admin/report?key=ADMIN_KEY
 *  GET /admin/report?key=ADMIN_KEY&mode=last3
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
 *  GET /admin/add-pack?key=ADMIN_KEY&packs=1
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
  if (!msg) return res.sendStatus(200);

  const { waId, type, text, imageId, caption } = msg;
  account.metrics.chats_total += 1;

  const session = getSession(waId);
  session.last_activity = Date.now();
  resetCloseTimer(session);

  console.log("📩 WhatsApp:", { waId, type, text, imageId, caption, state: session.state });

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
    }
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
            `¡Buenísimo! 🙌\n¿Preferís envío o venir a recoger?\n\nRespondé:\n1) ENVÍO\n2) RECOGER`
          );
        } else {
          await sendWhatsAppText(
            waId,
            `¡Buenísimo! 🙌\nPara enviártelo, pasame:\n- Nombre completo\n- Dirección exacta\n- Teléfono\n\nY te confirmo el envío 👌`
          );
        }
        return res.sendStatus(200);
      }

      if (isNo(text)) {
        account.metrics.intent_no += 1;
        session.state = "CERRADO_SIN_COSTO";
        await sendWhatsAppText(waId, `Con gusto 🙌 Cualquier cosa aquí estamos.`);
        return res.sendStatus(200);
      }

      await sendWhatsAppText(waId, `¿Te referís al producto anterior o al de la última foto? 🙌`);
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
        setPendingSinpe(session, expected);

        const sinpeLine = SINPE_NUMBER
          ? `💳 SINPE: ${SINPE_NUMBER}${SINPE_NAME ? ` (${SINPE_NAME})` : ""}`
          : `💳 SINPE: (configurar número)`;

        await sendWhatsAppText(
          waId,
          `Listo 🙌 Para apartarlo y que lo tengamos listo para recoger, se paga por SINPE de previo.\n\n${sinpeLine}\n\nCuando lo hagás, me avisás por aquí y te confirmo.`
        );
        return res.sendStatus(200);
      }

      await sendWhatsAppText(waId, `¿Me confirmás si querés 1) ENVÍO o 2) RECOGER? 🙌`);
      return res.sendStatus(200);
    }

    // 3C) Envío: guardar datos (MVP)
    if (session.state === "PIDIENDO_DATOS_ENVIO") {
      session.shipping_details = (text || "").trim();
      session.state = "ENVIO_LISTO";
      await sendWhatsAppText(waId, `Perfecto 🙌 Ya casi. En un toque te confirmamos y te enviamos el detalle final.`);
      return res.sendStatus(200);
    }

    // 3D) Texto después de foto (detalle mínimo)
    if (session.last_image_id && !session.sent_to_seller) {
      if (isMinimalDetail(text)) {
        session.last_details_text = text;
        session.sent_to_seller = true;
        session.state = "ENVIADO_A_VENDEDOR";
        account.metrics.quotes_requested += 1;

        await sendWhatsAppText(waId, `Dame un toque, voy a revisar si lo tenemos 👍`);
        addPendingQuote(session);
        return res.sendStatus(200);
      }

      session.state = "ESPERANDO_DETALLES";
      await sendWhatsAppText(waId, msgAskDetails(session));
      return res.sendStatus(200);
    }

    // 3E) FAQ
    const low = (text || "").toLowerCase();

    if (low.includes("horario") || low.includes("abren") || low.includes("cierran")) {
      await sendWhatsAppText(waId, `🕘 Horario: ${HOURS_DAY}`);
      return res.sendStatus(200);
    }

    if (low.includes("ubic") || low.includes("donde") || low.includes("direc")) {
      if (STORE_TYPE === "fisica" && MAPS_URL) {
        await sendWhatsAppText(waId, `📍 Ubicación: ${MAPS_URL}`);
      } else {
        await sendWhatsAppText(waId, `Somos tienda virtual 🙌 Mandame la captura/foto del producto y te ayudo con gusto.`);
      }
      return res.sendStatus(200);
    }

    if (low.includes("precio") || low.includes("cuanto") || low.includes("disponible") || low.includes("tienen")) {
      await sendWhatsAppText(
        waId,
        `Listo 🙌 Mandame la foto/captura del producto y me decís talla, color o tamaño para confirmarte.`
      );
      return res.sendStatus(200);
    }

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
 *  SINPE SMS (PRO) - Webhook
 *  POST /sinpe-sms
 *  Header: x-sinpe-secret: <SINPE_SMS_SECRET>
 *  Body: { body, received_at?, from? }   <-- from ES OPCIONAL
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

    // auto-match solo si hay monto
    if (!parsed.amount) return res.json({ ok: true, matched: false, reason: "no_amount", received_at });

    const lookbackMs = minutesAgoMs(SINPE_SMS_LOOKBACK_MIN);

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
      s.state = "PAGO_CONFIRMADO";
      account.metrics.sinpe_auto_confirmed += 1;

      await sendWhatsAppText(
        s.waId,
        `¡Listo! 🙌 Ya nos entró el SINPE. En un toque te confirmamos que quedó apartado y listo para recoger.`
      );

      return res.json({ ok: true, matched: true, waId: s.waId, amount: parsed.amount, received_at });
    }

    return res.json({
      ok: true,
      matched: false,
      reason: candidates.length > 1 ? "multiple_candidates" : "no_candidates",
      count: candidates.length,
      amount: parsed.amount,
      received_at,
    });
  } catch (e) {
    console.log("❌ Error en /sinpe-sms:", e?.message || e);
    return res.status(200).json({ ok: false });
  }
});

/**
 * ============================
 *  SERVER
 * ============================
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const base = BASE_URL ? BASE_URL.replace(/\/$/, "") : "(set BASE_URL)";
  console.log("🚀 TICO-bot corriendo en puerto", PORT);
  console.log("✅ Endpoints:");
  console.log(`- Home: ${base}/`);
  console.log(`- Meta webhook: ${base}/webhook`);
  console.log(`- Status: ${base}/status?key=TU_ADMIN_KEY`);
  console.log(`- Inbox: ${base}/admin/inbox?key=TU_ADMIN_KEY`);
  console.log(`- Reply: ${base}/admin/reply?key=TU_ADMIN_KEY&waId=506XXXXXXXX&price=7000&shipping=2000`);
  console.log(`- No stock: ${base}/admin/no-stock?key=TU_ADMIN_KEY&waId=506XXXXXXXX`);
  console.log(`- SINPE SMS (PRO): ${base}/sinpe-sms`);
});








