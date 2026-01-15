/**
 * TICO-bot (WhatsApp only) - FINAL
 * - Cliente escribe por WhatsApp (Meta Cloud API inbound /webhook)
 * - Bot responde al cliente por WhatsApp (Cloud API outbound)
 * - Dueño recibe avisos por WhatsApp (OWNER_WA_ID) y responde con comandos:
 *    Q <waId> <precio> [envio]
 *    NO <waId>
 *    PACK <packs>
 *    PEND
 *    CONFIRM <waId> [nota]
 *    STATUS
 *    REPORT
 *    REPORT3
 *
 * - SINPE SMS PRO: GET /sinpe-sms?secret=...&msg=...&time=... (from opcional)
 */

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// fetch compatible (Node 18+ tiene fetch global; si no, usa node-fetch)
const fetchFn =
  global.fetch ||
  ((...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args)));

/**
 * ============================
 *  VARIABLES (Railway → Variables)
 * ============================
 */

// Meta Webhook verify
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "tico_verify_123";

// WhatsApp Cloud API
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";

// Dueño (para notificaciones y comandos)
const OWNER_WA_ID = String(process.env.OWNER_WA_ID || "").trim(); // ej: 5068xxxxxxx (sin +)
const OWNER_CMD_KEY = String(process.env.OWNER_CMD_KEY || "").trim(); // opcional; si está, exigimos "KEY <clave> ..." en comandos

// Tienda (1 cuenta por instancia)
const STORE_NAME = process.env.STORE_NAME || "TICO-bot";
const CATALOG_URL = process.env.CATALOG_URL || "";
const HOURS_DAY = process.env.HOURS_DAY || "9am-7pm";
const STORE_TYPE = (process.env.STORE_TYPE || "virtual").toLowerCase(); // virtual | fisica
const MAPS_URL = process.env.MAPS_URL || "";

// SINPE (para mostrar al cliente)
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

// Activación 1-uso (QR)
const ONBOARD_WA_NUMBER = process.env.ONBOARD_WA_NUMBER || ""; // tu WhatsApp para onboarding
const TOKENS_PERSIST = String(process.env.TOKENS_PERSIST || "") === "1"; // activations
const STATS_PERSIST = String(process.env.STATS_PERSIST || "") === "1"; // stats mensuales (últimos 3 meses)

// SINPE SMS (PRO) - modo GET por querystring (tu app)
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
    owner_notifications: 0,
    owner_commands: 0,
  },
};

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

  // snapshot mes anterior
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

  // reset mes nuevo
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
    owner_notifications: 0,
    owner_commands: 0,
  };

  console.log(`🔄 Reset mensual aplicado: ${key}`);
}

/**
 * ============================
 *  ACTIVACIONES 1-USO (QR)
 * ============================
 */
const ACTIVATIONS_FILE = path.join(process.cwd(), "activations.json");
const activations = new Map();

function loadActivationsFromDisk() {
  if (!TOKENS_PERSIST) return;
  try {
    if (!fs.existsSync(ACTIVATIONS_FILE)) return;
    const raw = fs.readFileSync(ACTIVATIONS_FILE, "utf-8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const r of arr) if (r?.token) activations.set(r.token, r);
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
  return crypto.randomBytes(18).toString("base64url");
}
function makeActivateUrl(token) {
  if (!BASE_URL) return `/activate/${token}`;
  return `${BASE_URL.replace(/\/$/, "")}/activate/${token}`;
}
function makeQrImageUrl(activateUrl) {
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
      sent_to_owner: false,
      last_activity: Date.now(),
      close_timer: null,
      last_prefix: null,
      last_offer: null, // { price, shipping }
      shipping_details: null,
      pending_sinpe: null, // { expectedAmount, created_ms, status }
      last_case_id: null,  // id para referencia interna
    });
    account.metrics.new_contacts += 1;
  }
  return sessions.get(waId);
}

function resetCloseTimer(session) {
  if (session.close_timer) clearTimeout(session.close_timer);
  session.close_timer = setTimeout(() => {
    session.state = "CERRADO_SIN_COSTO";
    session.sent_to_owner = false;
    session.last_image_id = null;
    session.last_details_text = null;
    session.last_offer = null;
    session.shipping_details = null;
    session.pending_sinpe = null;
    session.last_case_id = null;
    account.metrics.closed_timeout += 1;
    console.log(`⏱️ Caso cerrado por timeout (2h): ${session.waId}`);
  }, CLOSE_AFTER_MS);
}

function resetCaseForNewPhoto(session) {
  session.state = "ESPERANDO_DETALLES";
  session.last_image_id = null;
  session.last_details_text = null;
  session.sent_to_owner = false;
  session.last_offer = null;
  session.shipping_details = null;
  session.pending_sinpe = null;
  session.last_case_id = crypto.randomBytes(6).toString("hex");
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
 *  WhatsApp helpers
 * ============================
 */
async function sendWhatsAppText(toWaId, bodyText) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.log("⚠️ WhatsApp send desactivado (faltan WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID).");
    console.log("↳ Respuesta que se hubiera enviado:", { toWaId, bodyText });
    return;
  }

  const url = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  await fetchFn(url, {
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

function mustHaveOwner() {
  return Boolean(OWNER_WA_ID);
}

async function notifyOwner(text) {
  if (!mustHaveOwner()) {
    console.log("⚠️ OWNER_WA_ID no configurado. No puedo notificar al dueño.");
    return;
  }
  account.metrics.owner_notifications += 1;
  await sendWhatsAppText(OWNER_WA_ID, text);
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

  // Monto: "5,300.00" o "30,000.00"
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

  // Nombre: "de MARIA..."
  let payer = null;
  const p = t.match(/\bColones\s+de\s+(.+?)\s+por\s+SINPE/i);
  if (p) payer = p[1].trim();

  // Referencia
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
 *  HTML Activación (QR 1-uso)
 * ============================
 */
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

/**
 * ============================
 *  OWNER COMMANDS (WhatsApp)
 * ============================
 */
function stripOwnerKeyPrefix(text) {
  const raw = String(text || "").trim();
  if (!OWNER_CMD_KEY) return raw;
  // exige: KEY <clave> <comando...>
  const parts = raw.split(/\s+/);
  if (parts.length >= 3 && parts[0].toUpperCase() === "KEY" && parts[1] === OWNER_CMD_KEY) {
    return parts.slice(2).join(" ");
  }
  return null; // no autorizado
}

function formatStatus() {
  return `📊 ${STORE_NAME}
Mes: ${account.month_key}

🪙 Fichas:
- Plan: ${account.monthly_tokens}
- Packs: ${account.tokens_packs_added}
- Total: ${tokensTotal()}
- Usadas: ${account.tokens_used}
- Restantes: ${tokensRemaining()}

📈 Métricas:
- Chats: ${account.metrics.chats_total}
- Nuevos: ${account.metrics.new_contacts}
- Cotizaciones pedidas: ${account.metrics.quotes_requested}
- Cotizaciones enviadas: ${account.metrics.quotes_sent}
- No stock: ${account.metrics.no_stock}
- SI: ${account.metrics.intent_yes}
- NO: ${account.metrics.intent_no}
- Timeouts: ${account.metrics.closed_timeout}
- SINPE SMS: ${account.metrics.sinpe_sms_received}
- Auto SINPE: ${account.metrics.sinpe_auto_confirmed}
- Manual SINPE: ${account.metrics.sinpe_manual_confirmed}`;
}

function reportLast3Text() {
  const m0 = account.month_key;
  const m1 = previousMonthKey(m0);
  const m2 = previousMonthKey(m1);

  const current = snapshotCurrentMonth();
  statsMonthly.set(current.month, current);

  const list = [m0, m1, m2]
    .map((m) => statsMonthly.get(m))
    .filter(Boolean);

  const lines = list.map((s) => {
    return `📅 ${s.month}
- Chats: ${s.metrics.chats_total}
- Cotiz. pedidas: ${s.metrics.quotes_requested}
- SI: ${s.metrics.intent_yes}
- NO: ${s.metrics.intent_no}
- Fichas usadas: ${s.tokens.used}/${s.tokens.total}`;
  });

  if (!lines.length) return "Aún no hay data de meses anteriores 🙌";
  return `📌 Resumen últimos 3 meses (${m0}, ${m1}, ${m2})\n\n${lines.join("\n\n")}`;
}

async function handleOwnerCommand(ownerTextRaw) {
  const cleaned = stripOwnerKeyPrefix(ownerTextRaw);
  if (cleaned === null) {
    await sendWhatsAppText(OWNER_WA_ID, "⛔ Comando no autorizado. (Te falta KEY <clave> ...)");
    return;
  }

  const text = cleaned.trim();
  if (!text) return;

  account.metrics.owner_commands += 1;

  const up = text.toUpperCase();

  // HELP
  if (up === "HELP" || up === "AYUDA") {
    await sendWhatsAppText(
      OWNER_WA_ID,
      `Comandos:
- Q <waId> <precio> [envio]
- NO <waId>
- PACK <packs>
- PEND
- CONFIRM <waId> [nota]
- STATUS
- REPORT
- REPORT3

Ejemplos:
Q 50688888888 7900 2000
NO 50688888888
PACK 1
PEND
CONFIRM 50688888888 ok
STATUS
REPORT3`
    );
    return;
  }

  // STATUS
  if (up === "STATUS") {
    await sendWhatsAppText(OWNER_WA_ID, formatStatus());
    return;
  }

  // REPORT / REPORT3
  if (up === "REPORT") {
    const current = snapshotCurrentMonth();
    await sendWhatsAppText(
      OWNER_WA_ID,
      `📌 Reporte mes ${current.month}\n- Chats: ${current.metrics.chats_total}\n- Cotiz. pedidas: ${current.metrics.quotes_requested}\n- SI: ${current.metrics.intent_yes}\n- NO: ${current.metrics.intent_no}\n- Fichas: ${current.tokens.used}/${current.tokens.total}`
    );
    return;
  }
  if (up === "REPORT3") {
    await sendWhatsAppText(OWNER_WA_ID, reportLast3Text());
    return;
  }

  // PACK <packs>
  if (up.startsWith("PACK")) {
    const parts = text.split(/\s+/);
    const packs = Math.max(1, Number(parts[1] || 1));
    account.tokens_packs_added += packs * PACK_TOKENS;
    await sendWhatsAppText(
      OWNER_WA_ID,
      `✅ Pack aplicado\nPacks: ${packs}\nTotal fichas: ${tokensTotal()}\nRestantes: ${tokensRemaining()}`
    );
    return;
  }

  // PEND (pendientes SINPE)
  if (up === "PEND") {
    const list = [];
    for (const s of sessions.values()) {
      if (s?.state === "ESPERANDO_SINPE" && s?.pending_sinpe?.status === "pending") {
        list.push(`- ${s.waId} (monto: ${s.pending_sinpe.expectedAmount || "?"})`);
      }
    }
    await sendWhatsAppText(
      OWNER_WA_ID,
      list.length ? `💳 Pendientes SINPE:\n${list.join("\n")}` : "No hay pendientes SINPE 🙌"
    );
    return;
  }

  // NO <waId>
  if (up.startsWith("NO ")) {
    const parts = text.split(/\s+/);
    const waId = parts[1];
    if (!waId) {
      await sendWhatsAppText(OWNER_WA_ID, "Usá: NO <waId>");
      return;
    }
    const s = getSession(waId);
    s.state = "CERRADO_SIN_COSTO";
    s.sent_to_owner = false;
    s.last_offer = null;
    await sendWhatsAppText(waId, `Gracias por esperar 🙌 En este momento no tenemos disponibilidad de ese producto.`);
    await sendWhatsAppText(OWNER_WA_ID, `✅ Enviado NO STOCK a ${waId}`);
    account.metrics.no_stock += 1;
    return;
  }

  // Q <waId> <precio> [envio]
  if (up.startsWith("Q ")) {
    const parts = text.split(/\s+/);
    const waId = parts[1];
    const price = Number(String(parts[2] || "").replace(/[^\d]/g, ""));
    const shipping = parts[3] ? Number(String(parts[3]).replace(/[^\d]/g, "")) : null;

    if (!waId || !price) {
      await sendWhatsAppText(OWNER_WA_ID, "Usá: Q <waId> <precio> [envio]\nEj: Q 50688888888 7900 2000");
      return;
    }

    const s = getSession(waId);
    s.state = "PRECIO_ENVIADO";
    s.sent_to_owner = false;
    s.last_offer = { price, shipping: shipping || null };

    account.metrics.quotes_sent += 1;

    const envioTxt = shipping ? ` + envío ₡${shipping}` : "";
    await sendWhatsAppText(
      waId,
      `¡Sí lo tenemos! 🎉\nTe sale en ₡${price}${envioTxt}.\n\n¿Te interesa comprarlo?\nRespondé:\nSI → para continuar\nNO → si solo estás viendo`
    );

    await sendWhatsAppText(OWNER_WA_ID, `✅ Precio enviado a ${waId} (₡${price}${shipping ? ` +₡${shipping}` : ""})`);
    return;
  }

  // CONFIRM <waId> [nota]
  if (up.startsWith("CONFIRM")) {
    const parts = text.split(/\s+/);
    const waId = parts[1];
    const note = parts.slice(2).join(" ").trim();

    if (!waId) {
      await sendWhatsAppText(OWNER_WA_ID, "Usá: CONFIRM <waId> [nota]");
      return;
    }

    const s = getSession(waId);
    if (s.state !== "ESPERANDO_SINPE") {
      await sendWhatsAppText(OWNER_WA_ID, `Ese cliente no está esperando SINPE. Estado actual: ${s.state}`);
      return;
    }

    s.pending_sinpe.status = "paid";
    s.pending_sinpe.paid_at = new Date().toISOString();
    s.state = "PAGO_CONFIRMADO";
    account.metrics.sinpe_manual_confirmed += 1;

    await sendWhatsAppText(waId, `¡Listo! 🙌 Ya quedó confirmado el SINPE. En un toque te confirmamos el apartado y la entrega.`);
    await sendWhatsAppText(OWNER_WA_ID, `✅ SINPE confirmado manual para ${waId}${note ? `\nNota: ${note}` : ""}`);
    return;
  }

  // default
  await sendWhatsAppText(OWNER_WA_ID, "No entendí ese comando. Escribí HELP para ver la lista.");
}

/**
 * ============================
 *  ENDPOINTS
 * ============================
 */
app.get("/", (req, res) => res.send("OK - TICO-bot vivo ✅"));

/**
 * STATUS (Admin)
 * GET /status?key=ADMIN_KEY
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
    activations_count: activations.size,
    pro: {
      sinpe_sms_enabled: Boolean(SINPE_SMS_SECRET),
      sinpe_sms_lookback_min: SINPE_SMS_LOOKBACK_MIN,
    },
    owner: {
      owner_wa_id_configured: Boolean(OWNER_WA_ID),
      owner_cmd_key_required: Boolean(OWNER_CMD_KEY),
    },
  });
});

/**
 * REPORTES (Admin)
 * GET /admin/report?key=ADMIN_KEY
 * GET /admin/report?key=ADMIN_KEY&mode=last3
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
 * ADMIN: agregar pack de fichas
 * GET /admin/add-pack?key=ADMIN_KEY&packs=1
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
 * ADMIN: crear QR 1-uso (post-pago)
 * GET /admin/create-activation?key=ADMIN_KEY&email=cliente@correo.com
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
 * ACTIVACIÓN 1-USO (QR)
 * GET /activate/:token
 */
app.get("/activate/:token", (req, res) => {
  const token = String(req.params.token || "").trim();
  const r = activations.get(token);

  if (!r) {
    return res.status(404).send(renderActivatePage({
      ok: false,
      title: "Acceso inválido",
      msg: "Este enlace no existe o ya expiró. Escribinos para ayudarte.",
      buttonText: ONBOARD_WA_NUMBER ? "Escribir por WhatsApp" : null,
      buttonUrl: ONBOARD_WA_NUMBER ? `https://wa.me/${ONBOARD_WA_NUMBER}` : null,
    }));
  }

  if (r.status === "used") {
    return res.status(410).send(renderActivatePage({
      ok: false,
      title: "Acceso ya usado",
      msg: "Este enlace ya fue activado antes. Si necesitás otro acceso, escribinos y lo resolvemos.",
      buttonText: ONBOARD_WA_NUMBER ? "Escribir por WhatsApp" : null,
      buttonUrl: ONBOARD_WA_NUMBER ? `https://wa.me/${ONBOARD_WA_NUMBER}` : null,
    }));
  }

  // quemar token
  r.status = "used";
  r.used_at = new Date().toISOString();
  activations.set(token, r);
  saveActivationsToDisk();

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

/**
 * META: Verificación webhook
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
 * WHATSAPP INBOUND
 */
app.post("/webhook", async (req, res) => {
  try {
    ensureMonthlyResetIfNeeded();

    const msg = extractMessage(req.body);
    if (!msg) return res.sendStatus(200);

    const { waId, type, text, imageId, caption } = msg;

    account.metrics.chats_total += 1;

    // Dueño manda comando al bot (por WhatsApp)
    if (OWNER_WA_ID && waId === OWNER_WA_ID && type === "text") {
      await handleOwnerCommand(text);
      return res.sendStatus(200);
    }

    // Cliente normal
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
        session.sent_to_owner = true;
        session.state = "ENVIADO_A_DUENO";
        account.metrics.quotes_requested += 1;

        await notifyOwner(
          `📦 NUEVA CONSULTA - ${STORE_NAME}
Cliente: ${waId}
Detalle: ${captionText}

Respondé con:
Q ${waId} <precio> [envio]
NO ${waId}`
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
      session.sent_to_owner = false;

      const captionText = (caption || "").trim();

      if (captionText && isMinimalDetail(captionText)) {
        session.last_details_text = captionText;
        session.sent_to_owner = true;
        session.state = "ENVIADO_A_DUENO";
        account.metrics.quotes_requested += 1;

        await sendWhatsAppText(waId, `Dame un toque, voy a revisar si lo tenemos 👍`);

        await notifyOwner(
          `📦 NUEVA CONSULTA - ${STORE_NAME}
Cliente: ${waId}
Detalle: ${captionText}

Respondé con:
Q ${waId} <precio> [envio]
NO ${waId}`
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
          // consume ficha SOLO aquí
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

      // En tienda física: elegir ENVÍO o RECOGER
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

          await notifyOwner(
            `💳 Cliente esperando SINPE
Cliente: ${waId}
Monto esperado: ${expected || "?"}

Podés confirmar manual:
CONFIRM ${waId} ok

O ver pendientes:
PEND`
          );

          return res.sendStatus(200);
        }

        await sendWhatsAppText(waId, `¿Me confirmás si querés 1) ENVÍO o 2) RECOGER? 🙌`);
        return res.sendStatus(200);
      }

      // Capturar datos de envío (si aplica)
      if (session.state === "PIDIENDO_DATOS_ENVIO") {
        session.shipping_details = (text || "").trim();
        session.state = "ENVIO_LISTO";

        const offer = session.last_offer || {};
        const envioTxt = offer.shipping ? `Envío: ₡${offer.shipping}` : "Envío: (por definir)";
        const precioTxt = offer.price ? `Precio: ₡${offer.price}` : "Precio: (pendiente)";

        await sendWhatsAppText(waId, `Perfecto 🙌 Ya casi. En un toque te confirmamos y te enviamos el detalle final.`);
        await notifyOwner(
          `📦 ENVÍO LISTO - ${STORE_NAME}
Cliente: ${waId}
Datos: ${session.shipping_details || "(no capturado)"}

${precioTxt}
${envioTxt}`
        );

        return res.sendStatus(200);
      }

      // Texto después de foto (detalles)
      if (session.last_image_id && !session.sent_to_owner) {
        if (isMinimalDetail(text)) {
          session.last_details_text = text;
          session.sent_to_owner = true;
          session.state = "ENVIADO_A_DUENO";
          account.metrics.quotes_requested += 1;

          await sendWhatsAppText(waId, `Dame un toque, voy a revisar si lo tenemos 👍`);

          await notifyOwner(
            `📦 NUEVA CONSULTA - ${STORE_NAME}
Cliente: ${waId}
Detalle: ${text}

Respondé con:
Q ${waId} <precio> [envio]
NO ${waId}`
          );
          return res.sendStatus(200);
        }

        session.state = "ESPERANDO_DETALLES";
        await sendWhatsAppText(waId, msgAskDetails(session));
        return res.sendStatus(200);
      }

      // FAQ rápido
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
        await sendWhatsAppText(waId, `Listo 🙌 Mandame la foto/captura del producto y me decís talla, color o tamaño para confirmarte.`);
        return res.sendStatus(200);
      }

      await sendWhatsAppText(waId, `Dale 🙌 Mandame la foto/captura del producto y me decís talla, color o tamaño para ayudarte.`);
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (e) {
    console.log("❌ Error en /webhook:", e?.message || e);
    return res.sendStatus(200);
  }
});

/**
 * ============================
 *  SINPE SMS (PRO) - GET por query
 *  GET /sinpe-sms?secret=XXX&msg=...&time=...&from=...
 *
 *  - "from" es OPCIONAL (si no viene, usamos "SINPE SMS")
 *  - Para tu app: si solo permite msg, perfecto.
 * ============================
 */
app.get("/sinpe-sms", async (req, res) => {
  try {
    ensureMonthlyResetIfNeeded();

    if (!SINPE_SMS_SECRET) return res.status(400).send("SINPE_SMS_SECRET no configurado");

    const secret = String(req.query.secret || "");
    if (secret !== SINPE_SMS_SECRET) return res.status(403).send("Forbidden");

    const from = String(req.query.from || "SINPE SMS");
    const msg = String(req.query.msg || "");
    const time = String(req.query.time || new Date().toISOString());

    if (!msg) return res.status(400).json({ ok: false, error: "missing msg" });

    account.metrics.sinpe_sms_received += 1;

    const parsed = parseSinpeSms(msg);

    // Auditoría al dueño (WhatsApp)
    await notifyOwner(
      `💳 SINPE SMS - ${STORE_NAME}
Origen: ${from}
Hora: ${time}
Monto: ${parsed.amount ? `₡${parsed.amount}` : "No detectado"}
${parsed.payer ? `De: ${parsed.payer}` : ""}
${parsed.reference ? `Ref: ${parsed.reference}` : ""}

Texto:
${parsed.raw}`
    );

    // Auto-match solo si hay monto detectado
    if (!parsed.amount) return res.json({ ok: true, matched: false, reason: "no_amount" });

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

      await notifyOwner(`✅ PAGO AUTO-CONFIRMADO\nCliente: ${s.waId}\nMonto: ₡${parsed.amount}`);

      return res.json({ ok: true, matched: true, waId: s.waId });
    }

    if (candidates.length > 1) {
      await notifyOwner(
        `⚠️ SINPE ₡${parsed.amount} calza con ${candidates.length} pedidos.\nNo se confirmó automático. Usá PEND y CONFIRM manual.`
      );
      return res.json({ ok: true, matched: false, reason: "multiple_candidates", count: candidates.length });
    }

    return res.json({ ok: true, matched: false, reason: "no_candidates" });
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

app.listen(PORT, async () => {
  const base = BASE_URL ? BASE_URL.replace(/\/$/, "") : "(set BASE_URL)";
  console.log("🚀 TICO-bot corriendo en puerto", PORT);
  console.log("✅ Endpoints:");
  console.log(`- Home: ${base}/`);
  console.log(`- Meta verify/inbound: ${base}/webhook`);
  console.log(`- Status: ${base}/status?key=ADMIN_KEY`);
  console.log(`- Report: ${base}/admin/report?key=ADMIN_KEY`);
  console.log(`- Report3: ${base}/admin/report?key=ADMIN_KEY&mode=last3`);
  console.log(`- Add pack: ${base}/admin/add-pack?key=ADMIN_KEY&packs=1`);
  console.log(`- Create activation: ${base}/admin/create-activation?key=ADMIN_KEY&email=cliente@correo.com`);
  console.log(`- SINPE SMS (GET): ${base}/sinpe-sms?secret=...&msg=...&time=...&from=...`);
  console.log("✅ WhatsApp owner:", OWNER_WA_ID ? `OK (${OWNER_WA_ID})` : "NO (set OWNER_WA_ID)");
  if (OWNER_WA_ID) {
    // mensaje inicial para que el dueño sepa que ya está vivo
    await notifyOwner(`✅ ${STORE_NAME} activo.\nEscribí HELP para ver comandos.`);
  }
});







