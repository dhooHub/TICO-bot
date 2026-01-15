/**
 * =========================================================
 * TICO-bot — MVP COMPLETO
 * 1 instancia = 1 negocio
 * WhatsApp: clientes
 * Telegram: dueño / admin
 * =========================================================
 */

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

/* =========================================================
   VARIABLES (Railway → Variables)
   ========================================================= */

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "verify_token";
const ADMIN_KEY = process.env.ADMIN_KEY || "admin_key";

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const TELEGRAM_SECRET_TOKEN = process.env.TELEGRAM_SECRET_TOKEN || "";

const STORE_NAME = process.env.STORE_NAME || "TICO-bot";
const CATALOG_URL = process.env.CATALOG_URL || "";
const HOURS_DAY = process.env.HOURS_DAY || "9am a 7pm";
const STORE_TYPE = (process.env.STORE_TYPE || "virtual").toLowerCase();
const MAPS_URL = process.env.MAPS_URL || "";

const SINPE_NUMBER = process.env.SINPE_NUMBER || "";
const SINPE_NAME = process.env.SINPE_NAME || "";

const BASE_URL = process.env.BASE_URL || "";
const ONBOARD_WA_NUMBER = process.env.ONBOARD_WA_NUMBER || "";

const MONTHLY_TOKENS = Number(process.env.MONTHLY_TOKENS || 100);
const PACK_TOKENS = Number(process.env.PACK_TOKENS || 10);
const PACK_PRICE_CRC = Number(process.env.PACK_PRICE_CRC || 1000);

const TOKENS_PERSIST = String(process.env.TOKENS_PERSIST || "") === "1";

/* =========================================================
   ESTADO DE CUENTA (1 TIENDA)
   ========================================================= */

function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const account = {
  plan: "basic", // basic | pro
  month: monthKey(),
  monthly_tokens: MONTHLY_TOKENS,
  tokens_used: 0,
  tokens_packs_added: 0,
  metrics: {},
};

const metricsByMonth = {}; // { "2026-01": { ... } }

function ensureMonth() {
  const key = monthKey();
  if (!metricsByMonth[key]) {
    metricsByMonth[key] = {
      chats: 0,
      quotes_requested: 0,
      quotes_sent: 0,
      intent_yes: 0,
      intent_no: 0,
      closed_timeout: 0,
    };
  }
  account.month = key;
}

function tokensTotal() {
  return account.monthly_tokens + account.tokens_packs_added;
}
function tokensRemaining() {
  return Math.max(0, tokensTotal() - account.tokens_used);
}
function consumeToken() {
  if (tokensRemaining() <= 0) return false;
  account.tokens_used += 1;
  return true;
}

/* =========================================================
   SESIONES WHATSAPP
   ========================================================= */

const sessions = new Map();
const CLOSE_AFTER_MS = 2 * 60 * 60 * 1000;

function getSession(waId) {
  if (!sessions.has(waId)) {
    sessions.set(waId, {
      waId,
      state: "NEW",
      last_image: null,
      sent_to_seller: false,
      timer: null,
    });
  }
  return sessions.get(waId);
}

function resetTimer(session) {
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    session.state = "CLOSED";
    ensureMonth();
    metricsByMonth[account.month].closed_timeout++;
  }, CLOSE_AFTER_MS);
}

/* =========================================================
   HELPERS
   ========================================================= */

async function sendWhatsApp(to, text) {
  if (!WHATSAPP_TOKEN) return;
  await fetch(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });
}

function isYes(t = "") {
  return ["si", "sí", "claro", "quiero", "dale"].some((k) => t.toLowerCase().includes(k));
}
function isNo(t = "") {
  return ["no", "solo viendo", "gracias"].some((k) => t.toLowerCase().includes(k));
}

/* =========================================================
   WHATSAPP WEBHOOK
   ========================================================= */

app.post("/webhook", async (req, res) => {
  ensureMonth();
  const entry = req.body.entry?.[0]?.changes?.[0]?.value;
  const msg = entry?.messages?.[0];
  if (!msg) return res.sendStatus(200);

  const waId = msg.from;
  const type = msg.type;
  const text = msg.text?.body || "";
  const image = msg.image?.id || null;

  metricsByMonth[account.month].chats++;

  const session = getSession(waId);
  resetTimer(session);

  if (type === "image") {
    session.last_image = image;
    session.state = "WAITING_DETAILS";
    await sendWhatsApp(waId, "¿Qué talla, color o tamaño buscás?");
    return res.sendStatus(200);
  }

  if (session.state === "WAITING_DETAILS" && text) {
    session.state = "PRICE_SENT";
    metricsByMonth[account.month].quotes_requested++;

    await sendTelegram(
      `📦 Nueva consulta\nCliente: ${waId}\nDetalle: ${text}\n\nRespondé:\n7000 2000\nNO`
    );

    await sendWhatsApp(waId, "Dame un toque, voy a revisar 🙌");
    return res.sendStatus(200);
  }

  if (session.state === "PRICE_SENT") {
    if (isYes(text)) {
      if (!consumeToken()) {
        await sendWhatsApp(
          waId,
          `Este mes se agotaron las fichas 🙌\nPack extra: ${PACK_TOKENS} por ₡${PACK_PRICE_CRC}`
        );
        return res.sendStatus(200);
      }

      metricsByMonth[account.month].intent_yes++;
      await sendWhatsApp(
        waId,
        STORE_TYPE === "fisica"
          ? "¿Preferís envío o recoger?"
          : "Pasame nombre, dirección y teléfono 👌"
      );
      return res.sendStatus(200);
    }

    if (isNo(text)) {
      metricsByMonth[account.month].intent_no++;
      session.state = "CLOSED";
      await sendWhatsApp(waId, "Con gusto 🙌");
      return res.sendStatus(200);
    }
  }

  res.sendStatus(200);
});

/* =========================================================
   TELEGRAM (ADMIN / DUEÑO)
   ========================================================= */

app.post("/telegram", async (req, res) => {
  const msg = req.body.message;
  if (!msg || msg.chat?.id != TELEGRAM_CHAT_ID) return res.sendStatus(200);

  const text = (msg.text || "").toUpperCase().trim();
  ensureMonth();

  // CAMBIAR PLAN
  if (text === "PLAN PRO") {
    account.plan = "pro";
    await sendTelegram("✅ Plan actualizado a PRO");
    return res.sendStatus(200);
  }

  if (text === "PLAN BASIC") {
    account.plan = "basic";
    await sendTelegram("✅ Plan actualizado a BASIC");
    return res.sendStatus(200);
  }

  // ESTADO
  if (text === "ESTADO") {
    await sendTelegram(
      `📊 Estado\nPlan: ${account.plan.toUpperCase()}\nFichas restantes: ${tokensRemaining()}\nMes: ${account.month}`
    );
    return res.sendStatus(200);
  }

  // RESUMEN (solo PRO)
  if (text === "RESUMEN") {
    if (account.plan !== "pro") {
      await sendTelegram("📌 RESUMEN disponible solo en PRO");
      return res.sendStatus(200);
    }

    const months = Object.keys(metricsByMonth).slice(-3);
    let out = "📈 Resumen últimos meses\n\n";

    for (const m of months) {
      const d = metricsByMonth[m];
      out += `🗓️ ${m}\n- Chats: ${d.chats}\n- Intenciones: ${d.intent_yes}\n- Cotizaciones: ${d.quotes_sent}\n\n`;
    }

    await sendTelegram(out);
    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

/* =========================================================
   SERVER
   ========================================================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 TICO-bot activo en puerto", PORT);
});




