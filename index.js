import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { catalogo } from "./catalogo.js";

dotenv.config();

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "ana123";

// ==============================
// 🧠 MEMORIA
// ==============================
const sessions = new Map();
const processedMessages = new Set();

// ==============================
// 🧠 NORMALIZAR TEXTO
// ==============================
function normalizarTexto(texto) {
  return texto
    .toLowerCase()
    .replace(/doquin|doquines|adokines|adoqin|adoquines/g, "adoquin")
    .replace(/fachada|fachadas/g, "fachaleta");
}

// ==============================
// 🧠 DETECTAR PRODUCTO
// ==============================
function detectarProducto(texto) {
  for (const key in catalogo) {
    const nombre = catalogo[key].nombre.toLowerCase();

    if (texto.includes(nombre)) return key;

    // detectar medidas
    if (texto.includes("20x10x3") && key.includes("20x10x3")) return key;
    if (texto.includes("20x10x4") && key.includes("20x10x4")) return key;
    if (texto.includes("20x10x6") && key.includes("20x10x6")) return key;
    if (texto.includes("20x10x8") && key.includes("20x10x8")) return key;

    // fachaletas por nombre parcial
    if (texto.includes("cappuccino") && key.includes("cappuccino")) return key;
    if (texto.includes("nero") && key.includes("nero")) return key;
    if (texto.includes("toscano") && key.includes("toscano")) return key;
    if (texto.includes("bianco") && key.includes("bianco")) return key;
  }

  if (texto.includes("adoquin")) return "GENERAL_ADOQUINES";

  return null;
}

// ==============================
// 📤 MENSAJE TEXTO
// ==============================
async function enviarMensaje(to, body) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      text: { body }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
      }
    }
  );
}

// ==============================
// 🖼️ ENVIAR IMÁGENES
// ==============================
async function enviarImagenes(to, producto) {
  const item = catalogo[producto];

  if (!item?.imagenes?.length) {
    await enviarMensaje(to, "aún no tengo fotos cargadas 😅");
    return;
  }

  await enviarMensaje(to, `mira ${item.nombre} 👇`);

  for (const img of item.imagenes) {
    await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "image",
        image: { link: img }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
        }
      }
    );

    await new Promise(r => setTimeout(r, 700));
  }
}

// ==============================
// 📦 MOSTRAR CATÁLOGO
// ==============================
async function mostrarCatalogo(to) {
  let mensaje = "mira 👇 manejamos:\n\n";

  for (const key in catalogo) {
    mensaje += `• ${catalogo[key].nombre}\n`;
  }

  mensaje += "\nsi quieres fotos dime cuál 👍";

  await enviarMensaje(to, mensaje);
}

// ==============================
// ✅ VERIFY
// ==============================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});

// ==============================
// 🚀 WEBHOOK
// ==============================
app.post("/webhook", async (req, res) => {
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;

    if (value?.statuses) return res.sendStatus(200);

    const message = value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const msgId = message.id;

    let text = message.text?.body;
    if (!text) return res.sendStatus(200);

    text = normalizarTexto(text);

    // ❌ duplicados
    if (processedMessages.has(msgId)) return res.sendStatus(200);
    processedMessages.add(msgId);

    console.log("Mensaje:", text);

    // ==============================
    // 🧠 SESIÓN
    // ==============================
    if (!sessions.has(from)) {
      sessions.set(from, {
        producto: null,
        esperando: null
      });
    }

    const session = sessions.get(from);

    const productoDetectado = detectarProducto(text);
    if (productoDetectado) session.producto = productoDetectado;

    const esSi = ["si", "sí", "dale", "ok", "listo", "de una"].includes(text);

    const quiereImagen =
      text.includes("imagen") ||
      text.includes("imagenes") ||
      text.includes("foto") ||
      text.includes("ver") ||
      text.includes("muestra") ||
      text.includes("mostrar");

    const quiereTodo =
      text.includes("todo") ||
      text.includes("todos") ||
      text.includes("catalogo");

    // ==============================
    // 📦 MOSTRAR TODO
    // ==============================
    if (quiereTodo) {
      await mostrarCatalogo(from);
      session.esperando = "elegir_producto";
      return res.sendStatus(200);
    }

    // ==============================
    // 🔥 SI YA ELIGIÓ PRODUCTO → MOSTRAR DIRECTO
    // ==============================
    if (session.producto && session.producto !== "GENERAL_ADOQUINES") {
      await enviarImagenes(from, session.producto);
      session.esperando = null;
      return res.sendStatus(200);
    }

    // ==============================
    // 👀 SI DICE "SI"
    // ==============================
    if (esSi && session.esperando === "mostrar_catalogo") {
      await mostrarCatalogo(from);
      session.esperando = "elegir_producto";
      return res.sendStatus(200);
    }

    // ==============================
    // 🧱 ADOQUINES GENERAL
    // ==============================
    if (session.producto === "GENERAL_ADOQUINES") {
      await enviarMensaje(from, "manejamos varios 👍 quieres que te muestre todos?");
      session.esperando = "mostrar_catalogo";
      return res.sendStatus(200);
    }

    // ==============================
    // 🤖 IA (solo fallback)
    // ==============================
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `
Eres Ana de Ladrillera La Toscana.

Hablas como persona real:

- natural
- amable
- corta
- no robot
- ayudas fácil
- no repites
- si no entiendes: "qué pena no te entendí bien"
`
          },
          { role: "user", content: text }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        }
      }
    );

    const reply = response.data.choices[0].message.content;

    await new Promise(r => setTimeout(r, Math.random() * 2000 + 1000));

    await enviarMensaje(from, reply);

    res.sendStatus(200);

  } catch (error) {
    console.error("ERROR:", error.response?.data || error.message);
    res.sendStatus(200);
  }
});

// ==============================
app.get("/", (req, res) => {
  res.send("Ana PRO activa 🚀");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor activo");
});
