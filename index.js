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

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const TELEGRAM_SECRET_TOKEN = process.env.TELEGRAM_SECRET_TOKEN || "";

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";

const STORE_NAME = process.env.STORE_NAME || "TICO-bot";
const CATALOG_URL = process.env.CATALOG_URL || "";
const HOURS_DAY = process.env.HOURS_DAY || "9am-7pm";
const STORE_TYPE = (process.env.STORE_TYPE || "virtual").toLowerCase(); // virtual | fisica
const MAPS_URL = process.env.MAPS_URL || "";

// Fichas / Plan
const MONTHLY_TOKENS = Number(process.env.MONTHLY_TOKENS || 100);
const PACK_TOKENS = Number(process.env.PACK_TOKENS || 10);
const PACK_PRICE_CRC = Number(process.env.PACK_PRICE_CRC || 1000);

const SINPE_NUMBER = process.env.SINPE_NUMBER || "";
const SINPE_NAME = process.env.SINPE_NAME || "";

const ADMIN_KEY = process.env.ADMIN_KEY || ""; // para /status y endpoints admin

// Activación (QR 1-uso)
const BASE_URL = process.env.BASE_URL || ""; // ej: https://tico-bot-production.up.railway.app
const ONBOARD_WA_NUMBER = process.env.ONBOARD_WA_NUMBER || ""; // ej: 50688888888
const TOKENS_PERSIST = String(process.env.TOKENS_PERSIST || "") === "1";

/**
 * ============================
 *  ESTADO EN MEMORIA (MVP)
 * ============================
 */
const sessions = new Map();
const CLOSE_AFTER_MS = 2 * 60 * 60 * 1000; // 2 horas

// Cuenta única por instancia (1 tienda)
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
  },
};

function currentMonthKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function ensureMonthlyResetIfNeeded() {
  const key = currentMonthKey();
  if (account.month_key !== key) {
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
    };
    console.log(`🔄 Reset mensual aplicado: ${key}`);
  }
}

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
  console.log(`🪙 Ficha consumida (${reason}). Restantes: ${tokensRemaining()}/${tokensTotal()}`);
  return true;
}

/**
 * ============================
 *  ACTIVACIONES 1-USO (QR)
 * ============================
 * Guardamos tokens de activación:
 * - token
 * - email/cliente (opcional)
 * - estado: unused/used
 * - created_at / used_at
 */
const ACTIVATIONS_FILE = path.join(process.cwd(), "activations.json");
const activations = new Map(); // token -> record

function loadActivationsFromDisk() {
  if (!TOKENS_PERSIST) return;
  try {
    if (!fs.existsSync(ACTIVATIONS_FILE)) return;
    const raw = fs.readFileSync(ACTIVATIONS_FILE, "utf-8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const r of arr) {
        if (r?.token) activations.set(r.token, r);
      }
      console.log(`📦 Activations cargadas: ${activations.size}`);
    }
  } catch (e) {
    console.log("⚠️ No pude cargar activations.json:", e?.message || e);
  }
}

function saveActivationsToDisk() {
  if (!TOKENS_PERSIST) return;
  try {
    const arr = Array.from(activations.values());
    fs.writeFileSync(ACTIVATIONS_FILE, JSON.stringify(arr, null, 2), "utf-8");
  } catch (e) {
    console.log("⚠️ No pude guardar activations.json:", e?.message || e);
  }
}

function makeToken() {
  return crypto.randomBytes(18).toString("base64url"); // corto, seguro, QR-friendly
}

function makeActivateUrl(token) {
  if (!BASE_URL) return `/activate/${token}`;
  return `${BASE_URL.replace(/\/$/, "")}/activate/${token}`;
}

function makeQrImageUrl(activateUrl) {
  // QR por servicio externo (simple). Alternativa: generar QR en frontend.
  // Esto solo crea la imagen del QR para el correo.
  const data = encodeURIComponent(activateUrl);
  return `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${data}`;
}

loadActivationsFromDisk();

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
}

/**
 * ============================
 *  TEXTO HUMANO TICO (ROTACIÓN)
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
 *  DETECCIÓN DE "DETALLE MÍNIMO"
 * ============================
 */
const COLORS = [
  "negro","blanco","rojo","azul","verde","gris","beige","café","cafe","morado","rosado","amarillo","naranja","plateado","dorado",
];

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
 *  TELEGRAM PARSE (respuesta vendedor)
 * ============================
 */
function extractWaIdFromTelegramUpdate(update) {
  const msg = update?.message;
  if (!msg) return null;

  const candidates = [];
  if (typeof msg.text === "string") candidates.push(msg.text);
  if (typeof msg.caption === "string") candidates.push(msg.caption);

  if (msg.reply_to_message) {
    if (typeof msg.reply_to_message.text === "string") candidates.push(msg.reply_to_message.text);
    if (typeof msg.reply_to_message.caption === "string") candidates.push(msg.reply_to_message.caption);
  }

  for (const t of candidates) {
    const m = t.match(/Cliente:\s*(\d{8,15})/i);
    if (m) return m[1];
  }
  for (const t of candidates) {
    const m = t.match(/\b(\d{8,15})\b/);
    if (m) return m[1];
  }

  return null;
}

function parseSellerReplyFromTelegramText(text) {
  const raw = (text || "").trim();
  const upper = raw.toUpperCase();
  if (upper === "NO") return { type: "NO_STOCK" };

  const parts = raw.split(/\s+/).filter(Boolean);
  const nums = parts
    .map((p) => Number(String(p).replace(/[^\d]/g, "")))
    .filter((n) => !isNaN(n) && n > 0);

  if (nums.length >= 1) return { type: "PRICE", price: nums[0], shipping: nums.length >= 2 ? nums[1] : null };
  return { type: "UNKNOWN" };
}

/**
 * ============================
 *  ENDPOINTS
 * ============================
 */
app.get("/", (req, res) => res.send("OK - TICO-bot vivo ✅"));

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
    activations_count: activations.size,
  });
});

/**
 * ============================
 *  ADMIN: crear QR 1-uso (post-pago)
 *  GET /admin/create-activation?key=1234&email=cliente@correo.com
 * ============================
 */
app.get("/admin/create-activation", (req, res) => {
  if (!ADMIN_KEY || String(req.query.key || "") !== String(ADMIN_KEY)) return res.status(403).send("Forbidden");

  const email = String(req.query.email || "").trim() || null;
  const token = makeToken();

  const record = {
    token,
    email,
    status: "unused",
    created_at: new Date().toISOString(),
    used_at: null,
  };

  activations.set(token, record);
  saveActivationsToDisk();

  const activateUrl = makeActivateUrl(token);
  const qrImageUrl = makeQrImageUrl(activateUrl);

  return res.json({
    token,
    activate_url: activateUrl,
    qr_image_url: qrImageUrl,
    note: "Este link/QR es de un solo uso. Al abrirlo se marca como usado.",
  });
});

/**
 * ============================
 *  ACTIVACIÓN 1-USO (QR)
 *  GET /activate/:token
 * ============================
 */
app.get("/activate/:token", (req, res) => {
  const token = String(req.params.token || "").trim();
  const r = activations.get(token);

  // no existe
  if (!r) {
    return res.status(404).send(renderActivatePage({
      ok: false,
      title: "Acceso inválido",
      msg: "Este enlace no existe o ya expiró. Escribinos para ayudarte.",
      buttonText: ONBOARD_WA_NUMBER ? "Escribir por WhatsApp" : null,
      buttonUrl: ONBOARD_WA_NUMBER ? `https://wa.me/${ONBOARD_WA_NUMBER}` : null,
    }));
  }

  // ya usado
  if (r.status === "used") {
    return res.status(410).send(renderActivatePage({
      ok: false,
      title: "Acceso ya usado",
      msg: "Este enlace ya fue activado antes. Si necesitás otro acceso, escribinos y lo resolvemos.",
      buttonText: ONBOARD_WA_NUMBER ? "Escribir por WhatsApp" : null,
      buttonUrl: ONBOARD_WA_NUMBER ? `https://wa.me/${ONBOARD_WA_NUMBER}` : null,
    }));
  }

  // marcar como usado (QUEMAR)
  r.status = "used";
  r.used_at = new Date().toISOString();
  activations.set(token, r);
  saveActivationsToDisk();

  // redirección a WhatsApp (onboarding) con mensaje
  const msg = encodeURIComponent(`Hola, activé TICO-bot ✅\nToken: ${token}\nCorreo: ${r.email || "N/A"}`);
  const waUrl = ONBOARD_WA_NUMBER ? `https://wa.me/${ONBOARD_WA_NUMBER}?text=${msg}` : null;

  return res.status(200).send(renderActivatePage({
    ok: true,
    title: "Activación lista ✅",
    msg: "Perfecto. Tu acceso quedó activado. Dale continuar para terminar el setup por WhatsApp.",
    buttonText: waUrl ? "Continuar" : null,
    buttonUrl: waUrl,
    small: waUrl ? "Si no se abre, copiá el enlace y pegalo en tu WhatsApp." : null,
  }));
});

function renderActivatePage({ ok, title, msg, buttonText, buttonUrl, small }) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}</title>
  <style>
    body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#0b0f19;color:#e5e7eb;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;}
    .card{width:min(720px,100%);background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.10);border-radius:18px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.35);}
    .tag{display:inline-block;padding:6px 10px;border-radius:999px;font-weight:700;font-size:13px;background:${ok ? "rgba(34,197,94,.15)" : "rgba(248,113,113,.15)"};border:1px solid ${ok ? "rgba(34,197,94,.30)" : "rgba(248,113,113,.30)"};color:${ok ? "#bbf7d0" : "#fecaca"};}
    h1{margin:12px 0 8px;font-size:34px;}
    p{margin:0;color:rgba(229,231,235,.85);line-height:1.5}
    .btn{display:inline-block;margin-top:16px;padding:12px 14px;border-radius:14px;background:${ok ? "#22c55e" : "#38bdf8"};color:#04110a;text-decoration:none;font-weight:800;}
    .small{margin-top:12px;color:rgba(229,231,235,.65);font-size:13px}
    .mono{margin-top:14px;padding:12px;border-radius:12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;word-break:break-all;color:#cbd5e1}
  </style>
</head>
<body>
  <div class="card">
    <span class="tag">${ok ? "ACTIVADO" : "ATENCIÓN"}</span>
    <h1>${title}</h1>
    <p>${msg}</p>
    ${buttonText && buttonUrl ? `<a class="btn" href="${buttonUrl}">${buttonText}</a>` : ""}
    ${small ? `<div class="small">${small}</div>` : ""}
    ${buttonUrl ? `<div class="mono">${buttonUrl}</div>` : ""}
  </div>
</body>
</html>`;
}

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

  // Si estaba en PRECIO_ENVIADO y manda otra foto -> nuevo caso
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

      const waLink = `https://wa.me/${waId}`;
      await sendTelegram(
        `📦 Nueva consulta - ${STORE_NAME}

👤 Cliente: ${waId}
📝 Detalles: ${captionText}

Respondé (respondiendo a ESTE mensaje):
- 7000 2000   (precio envío)
- NO          (no hay stock)

👉 ${waLink}`
      );
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

      const waLink = `https://wa.me/${waId}`;
      await sendTelegram(
        `📦 Nueva consulta - ${STORE_NAME}

👤 Cliente: ${waId}
📝 Detalles: ${captionText}

Respondé (respondiendo a ESTE mensaje):
- 7000 2000   (precio envío)
- NO          (no hay stock)

👉 ${waLink}`
      );
      return res.sendStatus(200);
    }

    session.state = "ESPERANDO_DETALLES";
    await sendWhatsAppText(waId, msgAskDetails(session));
    return res.sendStatus(200);
  }

  // 3) Texto
  if (type === "text") {
    // SI/NO después de precio
    if (session.state === "PRECIO_ENVIADO") {
      if (isYes(text)) {
        if (!consumeToken("INTENCION_SI")) {
          await sendWhatsAppText(waId, msgOutOfTokens());
          return res.sendStatus(200);
        }

        account.metrics.intent_yes += 1;
        session.state = "INTENCION_CONFIRMADA";

        await sendWhatsAppText(
          waId,
          STORE_TYPE === "fisica"
            ? `¡Buenísimo! 🙌\n¿Preferís envío o venir a recoger?\n\nRespondé:\n1) ENVÍO\n2) RECOGER`
            : `¡Buenísimo! 🙌\nPara enviártelo, pasame:\n- Nombre completo\n- Dirección exacta\n- Teléfono\n\nY te confirmo el envío 👌`
        );
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

    // Texto después de foto (detalles)
    if (session.last_image_id && !session.sent_to_seller) {
      if (isMinimalDetail(text)) {
        session.last_details_text = text;
        session.sent_to_seller = true;
        session.state = "ENVIADO_A_VENDEDOR";
        account.metrics.quotes_requested += 1;

        await sendWhatsAppText(waId, `Dame un toque, voy a revisar si lo tenemos 👍`);

        const waLink = `https://wa.me/${waId}`;
        await sendTelegram(
          `📦 Nueva consulta - ${STORE_NAME}

👤 Cliente: ${waId}
📝 Detalles: ${text}

Respondé (respondiendo a ESTE mensaje):
- 7000 2000   (precio envío)
- NO          (no hay stock)

👉 ${waLink}`
        );
        return res.sendStatus(200);
      }

      session.state = "ESPERANDO_DETALLES";
      await sendWhatsAppText(waId, msgAskDetails(session));
      return res.sendStatus(200);
    }

    const t = (text || "").toLowerCase();

    if (t.includes("horario") || t.includes("abren") || t.includes("cierran")) {
      await sendWhatsAppText(waId, `🕘 Horario: ${HOURS_DAY}`);
      return res.sendStatus(200);
    }

    if (t.includes("ubic") || t.includes("donde") || t.includes("direc")) {
      if (STORE_TYPE === "fisica" && MAPS_URL) {
        await sendWhatsAppText(waId, `📍 Ubicación: ${MAPS_URL}`);
      } else {
        await sendWhatsAppText(waId, `Somos tienda virtual 🙌 Mandame la captura/foto del producto y te ayudo con gusto.`);
      }
      return res.sendStatus(200);
    }

    if (t.includes("precio") || t.includes("cuanto") || t.includes("disponible") || t.includes("tienen")) {
      await sendWhatsAppText(waId, `Listo 🙌 Mandame la foto/captura del producto y me decís talla, color o tamaño para confirmarte.`);
      return res.sendStatus(200);
    }

    await sendWhatsAppText(waId, `Dale 🙌 Mandame la foto/captura del producto y me decís talla, color o tamaño para ayudarte.`);
    return res.sendStatus(200);
  }

  return res.sendStatus(200);
});

/**
 * ============================
 *  TELEGRAM INBOUND (vendedor)
 * ============================
 */
app.post("/telegram", async (req, res) => {
  try {
    ensureMonthlyResetIfNeeded();

    if (TELEGRAM_SECRET_TOKEN) {
      const header = req.headers["x-telegram-bot-api-secret-token"];
      if (header !== TELEGRAM_SECRET_TOKEN) return res.sendStatus(403);
    }

    const update = req.body;
    const msg = update?.message;
    if (!msg) return res.sendStatus(200);

    const waId = extractWaIdFromTelegramUpdate(update);
    if (!waId) return res.sendStatus(200);

    const session = getSession(waId);
    resetCloseTimer(session);

    const sellerText = msg.text || msg.caption || "";
    console.log("📨 Telegram:", { waId, sellerText, state: session.state });

    if (session.state !== "ENVIADO_A_VENDEDOR") return res.sendStatus(200);

    const parsed = parseSellerReplyFromTelegramText(sellerText);

    if (parsed.type === "NO_STOCK") {
      account.metrics.no_stock += 1;
      session.state = "CERRADO_SIN_COSTO";
      session.sent_to_seller = false;
      session.last_offer = null;

      await sendWhatsAppText(waId, `Gracias por esperar 🙌 En este momento no tenemos disponibilidad de ese producto.`);
      return res.sendStatus(200);
    }

    if (parsed.type === "PRICE") {
      account.metrics.quotes_sent += 1;

      session.state = "PRECIO_ENVIADO";
      session.sent_to_seller = false;
      session.last_offer = { price: parsed.price, shipping: parsed.shipping };

      const envioTxt = parsed.shipping ? ` + envío ₡${parsed.shipping}` : "";
      await sendWhatsAppText(
        waId,
        `¡Sí lo tenemos! 🎉\nTe sale en ₡${parsed.price}${envioTxt}.\n\n¿Te interesa comprarlo?\nRespondé:\nSI → para continuar\nNO → si solo estás viendo`
      );
      return res.sendStatus(200);
    }

    await sendTelegram(
      `⚠️ No entendí tu respuesta.\n\nUsá este formato (respondiendo al mensaje del cliente):\n- 7000 2000   (precio envío)\n- NO          (no hay stock)`
    );

    return res.sendStatus(200);
  } catch (err) {
    console.log("❌ Error en /telegram:", err);
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
  console.log("🚀 TICO-bot corriendo en puerto", PORT);
  console.log("✅ Endpoints:", {
    home: "/",
    status: "/status?key=ADMIN_KEY",
    admin_create_activation: "/admin/create-activation?key=ADMIN_KEY&email=cliente@correo.com",
    activate: "/activate/:token",
    meta_webhook: "/webhook",
    telegram_webhook: "/telegram",
  });
});


