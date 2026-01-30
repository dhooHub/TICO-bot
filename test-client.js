/*
 * test-client.js
 * Simula una interacción completa: Cliente -> Bot -> Dueño -> Bot -> Cliente
 */

const crypto = require("crypto");

// 🔧 CONFIGURACIÓN (Cambia localhost con tu .env o defaults)
const PORT = 10000;
const BOT_URL = `http://localhost:${PORT}/webhook`;
const APP_SECRET = ""; // Dejar vacío si no pusiste APP_SECRET en el bot. Si pusiste uno, ponelo acá.

// 📱 CLIENTES
const CLIENT_PHONES = "50688881234"; // Un número tico de cliente
const OWNER_PHONE = "50611111111"; // Debe coincidir con tu OWNER_PHONE real o de prueba

// * Función auxiliar para esperar (delay)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// * Simula el envío de un evento de Webhook de WhatsApp
async function sendMsg(from, content, type = "text") {
  console.log(`\n📤 ENVIANDO ${type.toUpperCase()} from ${from}: "${content}"`);

  // Estructura del payload de Meta
  const messageData = {
    from: from,
    id: "wamid_test_" + Date.now(),
    timestamp: Math.floor(Date.now() / 1000),
    type: type,
  };

  if (type === "text") {
    messageData.text = { body: content };
  } else if (type === "image") {
    messageData.image = { id: "img_id_" + Date.now(), caption: content || "" };
  } else if (type === "interactive") {
    // Simula click en botón
    messageData.interactive = {
      type: "button_reply",
      button_reply: { id: content, title: "Click" },
    };
  }

  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WHATSAPP_BUSINESS_ID",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: "1234567890", display_phone_number: "15551234567" },
              contacts: [{ profile: { name: "Juan Test" }, wa_id: from }],
              messages: [messageData],
            },
            field: "messages",
          },
        ],
      },
    ],
  };

  const body = JSON.stringify(payload);
  const headers = { "Content-Type": "application/json" };

  // Firma SHA256 (si usas APP_SECRET)
  if (APP_SECRET) {
    const signature = crypto.createHmac("sha256", APP_SECRET).update(body).digest("hex");
    headers["x-hub-signature-256"] = `sha256=${signature}`;
  }

  try {
    const res = await fetch(BOT_URL, { method: "POST", headers, body });
    console.log(`   ✅ STATUS: ${res.status} ${res.statusText}`);
  } catch (e) {
    console.error(`   ❌ Error conectando al bot:`, e.message);
  }
}

// * FLUJO DE LA PRUEBA
async function runTest() {
  console.log("\n" + "=".repeat(60));
  console.log("🧪 INICIANDO SIMULACIÓN DE TICO-bot...\n");
  console.log("=".repeat(60));

  // 1. Cliente saluda
  await sendMsg(CLIENT_PHONES, "Hola, pura vida");
  await wait(2000);

  // 2. Cliente manda foto de un producto
  await sendMsg(CLIENT_PHONES, "Me interesa este, ¿existe?", "image");
  await wait(3000);

  // 3. Dueño (simulado) contesta desde panel
  // En realidad el dueño daría click en panel, pero simulamos que el bot recibe la acción
  console.log("\n👨‍💼 DUEÑO: El dueño está mirando desde el panel. Aquí el dueño daría click...");
  console.log('   ➡️  EL DUEÑO HACE CLICK EN "ENVIAR PRECIO": ₡15,000 + envío ₡2,500\n');
  await wait(2000);

  // 4. Simulamos respuesta del bot después del precio (el bot ya mandó el mensaje)
  // Ahora el cliente dice que SÍ
  await sendMsg(CLIENT_PHONES, "SI", "text");
  await wait(2000);

  // 4.1 Dueño confirma el envío (emulando que tu código pide confirmación al dueño)
  // Si tu bot tiene OWNER_PHONE, "OWNER_YES", "interactive" -> Simula click en botón
  await wait(2000);

  // 5. Cliente dice que SÍ
  await sendMsg(CLIENT_PHONES, "GAM", "text"); // O Click en botón
  await wait(2000);

  // 6. Cliente elige Envío
  await sendMsg(CLIENT_PHONES, "envio", "text");
  await wait(2000);

  // 7. Cliente manda dirección (activa el SINPE)
  await sendMsg(CLIENT_PHONES, "San José, cerca del parque, casa 24");
  await wait(2000);

  // 8. Cliente manda comprobante (foto no real SINPE/PAGO_CLIENTE)
  await sendMsg(CLIENT_PHONES, "Ya le transferí", "image");
  await wait(2000);

  // 9. Dueño confirma pago
  console.log("\n👨‍💼 DUEÑO: ¡CONFIRMO PAGO!");
  await sendMsg(OWNER_PHONE, "SI_LISTO_PAGADO", "text"); // Confirma desde su WhatsApp
  await wait(2000);

  console.log("\n" + "=".repeat(60));
  console.log("✅ FIN DE LA SIMULACIÓN");
  console.log("=".repeat(60));
}

// ¿Qué vas a ver?
console.log(`
╔════════════════════════════════════════════════════════════╗
║  🧪 SIMULADOR DE CLIENTE PARA TICO-bot                     ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║  Esto simula mensajes de WhatsApp para probar tu bot       ║
║  SIN necesitar verificación de Meta.                       ║
║                                                            ║
║  REQUISITOS:                                               ║
║  1. Tu bot debe estar corriendo en localhost:${PORT}         ║
║  2. Abrí otra terminal y corré: node index.js              ║
║  3. Luego corré este script: node test-client.js           ║
║                                                            ║
║  NOTA: Los mensajes que "envía" el bot no llegarán a       ║
║  WhatsApp real porque no tenés token válido, pero verás    ║
║  los logs en la terminal del bot.                          ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
`);

// Ejecutar
runTest();
