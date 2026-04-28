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

    if (texto.includes("20x10x3") && key.includes("20x10x3")) return key;
    if (texto.includes("20x10x4") && key.includes("20x10x4")) return key;
    if (texto.includes("20x10x6") && key.includes("20x10x6")) return key;
    if (texto.includes("20x10x8") && key.includes("20x10x8")) return key;

    if (texto.includes("cappuccino")) return "fachaleta_cappuccino";
    if (texto.includes("nero")) return "fachaleta_nero";
    if (texto.includes("toscano")) return "fachaleta_toscano";
    if (texto.includes("bianco")) return "fachaleta_bianco";
  }

  if (texto.includes("adoquin")) return "GENERAL_ADOQUINES";

  return null;
}

// ==============================
// 🧠 DETECTORES
// ==============================
function esSaludo(texto) {
  return ["hola", "hol", "buenas", "hey", "ola"].includes(texto);
}

function esSi(texto) {
  return ["si", "sí", "dale", "ok", "listo", "de una"].includes(texto);
}

function quiereImagen(texto) {
  return (
    texto.includes("imagen") ||
    texto.includes("imagenes") ||
    texto.includes("foto") ||
    texto.includes("ver") ||
    texto.includes("muestra") ||
    texto.includes("mostrar")
  );
}

function quiereTodo(texto) {
  return (
    texto.includes("todo") ||
    texto.includes("todos") ||
    texto.includes("catalogo")
  );
}

function preguntaEnvio(texto) {
  return texto.includes("envio") || texto.includes("envían") || texto.includes("envian");
}

// ==============================
// 📤 MENSAJE
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
// 🖼️ IMÁGENES
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
// 📦 CATÁLOGO
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
        esperando: null,
        saludo: false,
        iniciado: false
      });
    }

    const session = sessions.get(from);

    const productoDetectado = detectarProducto(text);
    if (productoDetectado) session.producto = productoDetectado;

    // ==============================
    // 👋 SALUDO (UNA SOLA VEZ)
    // ==============================
    if (esSaludo(text) && !session.saludo) {
      session.saludo = true;
      await enviarMensaje(from, "hola 👍 en qué te ayudo?");
      return res.sendStatus(200);
    }

    // ==============================
    // 🚚 ENVÍOS
    // ==============================
    if (preguntaEnvio(text)) {
      await enviarMensaje(
        from,
        "sí 👍 manejamos envíos\n\npásame la ubicación y te reviso el costo"
      );
      return res.sendStatus(200);
    }

    // ==============================
    // 🚀 ENTRADA DIRECTA
    // ==============================
    if (session.producto && !session.iniciado) {
      session.iniciado = true;

      await enviarMensaje(from, "perfecto 👍 ya te muestro");

      if (session.producto === "GENERAL_ADOQUINES") {
        await mostrarCatalogo(from);
        session.esperando = "elegir_producto";
      } else {
        await enviarImagenes(from, session.producto);
      }

      return res.sendStatus(200);
    }

    // ==============================
    // 📦 VER TODO
    // ==============================
    if (quiereTodo(text)) {
      await mostrarCatalogo(from);
      session.esperando = "elegir_producto";
      return res.sendStatus(200);
    }

    // ==============================
    // 👀 SI DICE "SI"
    // ==============================
    if (esSi(text)) {
      if (session.producto && session.producto !== "GENERAL_ADOQUINES") {
        await enviarImagenes(from, session.producto);
        return res.sendStatus(200);
      }

      if (session.esperando === "mostrar_catalogo") {
        await mostrarCatalogo(from);
        session.esperando = "elegir_producto";
        return res.sendStatus(200);
      }
    }

    // ==============================
    // 🖼️ IMÁGENES
    // ==============================
    if (quiereImagen(text) && session.producto) {
      if (session.producto === "GENERAL_ADOQUINES") {
        await mostrarCatalogo(from);
        return res.sendStatus(200);
      }

      await enviarImagenes(from, session.producto);
      return res.sendStatus(200);
    }

    // ==============================
    // 🤖 IA FALLBACK
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

- directa
- amable
- sin rodeos
- no dices "cómo estás"
- ayudas a comprar
- natural tipo: "perfecto", "dale", "ya te reviso"
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
