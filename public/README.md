# 🤖 TICO-bot con Panel Web

Bot de WhatsApp para emprendedores costarricenses con **Panel Web en tiempo real**.

## ✨ Características

- 📱 **Panel Web** - Controlá tu negocio desde el celular como una app
- 🔔 **Notificaciones en tiempo real** - Ves los mensajes al instante
- 💰 **Enviar precios con un toque** - Sin escribir nada
- 📊 **Métricas del día** - Chats, ventas, cotizaciones
- 🎟️ **Sistema de fichas** - Solo pagás por clientes reales
- 🤖 **IA opcional** - Responde preguntas frecuentes automáticamente
- 🌙 **Modo nocturno** - Captura leads mientras dormís

## 🚀 Instalación

### 1. Clonar o subir archivos

```bash
# Estructura necesaria:
tico-bot-panel/
├── index.js
├── package.json
├── .env
└── public/
    ├── index.html
    └── manifest.json
```

### 2. Instalar dependencias

```bash
npm install
```

### 3. Configurar variables

Copiá `.env.example` a `.env` y configurá tus datos:

```bash
cp .env.example .env
```

Variables mínimas necesarias:
- `WHATSAPP_TOKEN` - Token de Meta
- `WHATSAPP_PHONE_NUMBER_ID` - ID del número
- `PANEL_PIN` - PIN de 4 dígitos para el panel
- `STORE_NAME` - Nombre de tu tienda
- `SINPE_NUMBER` - Número SINPE
- `SINPE_NAME` - Nombre del titular

### 4. Iniciar

```bash
npm start
```

El servidor inicia en `http://localhost:3000`

## 📱 Usar el Panel

1. Abrí `https://tu-dominio.com` en el navegador del cel
2. Ingresá el PIN de 4 dígitos
3. ¡Listo! Ya podés:
   - Ver clientes pendientes
   - Enviar precios con un toque
   - Ver métricas en tiempo real

### Instalar como App (PWA)

En Chrome/Safari:
1. Abrí el panel en el navegador
2. Tocá "Agregar a pantalla de inicio"
3. ¡Ya tenés tu app! 🎉

## 🔧 Deploy en Railway/Render

### Railway

1. Conectá tu repo de GitHub
2. Agregá las variables de entorno
3. Deploy automático

### Render

1. New Web Service
2. Conectá el repo
3. Build: `npm install`
4. Start: `npm start`
5. Agregá variables de entorno

## 📋 Endpoints

| Ruta | Descripción |
|------|-------------|
| `/` | Panel Web |
| `/webhook` | Webhook de Meta |
| `/health` | Health check |
| `/status?key=ADMIN_KEY` | Estado del bot |
| `/inbox?key=ADMIN_KEY` | Pendientes (JSON) |

## 🔒 Seguridad

- El panel requiere PIN de 4 dígitos
- Usá HTTPS en producción
- Configurá `APP_SECRET` para validar webhooks de Meta

## 💡 Tips

1. **Cambiá el PIN** regularmente
2. **Activá HTTPS** en producción
3. **Configurá la IA** para responder FAQs automáticamente
4. **Revisá las métricas** para optimizar tu negocio

## 🆘 Soporte

¿Problemas? Revisá:
1. Las variables de entorno estén bien configuradas
2. El webhook de Meta apunte a `https://tu-dominio.com/webhook`
3. El número de WhatsApp esté verificado

---

Hecho con 💚 para emprendedores ticos 🇨🇷
