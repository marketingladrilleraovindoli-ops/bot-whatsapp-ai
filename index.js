import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { catalogo } from "./catalogo.js";

dotenv.config();

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "ana123";

// ==============================
// 🧠 MEMORIA REAL
// ==============================
const sessions = new Map();
const processedMessages = new Set();

// ==============================
// 🧠 NORMALIZAR TEXTO
// ==============================
function normalizar(texto) {
  return texto
    .toLowerCase()
    .replace(/á/g, "a")
    .replace(/é/g, "e")
    .replace(/í/g, "i")
    .replace(/ó/g, "o")
    .replace(/ú/g, "u")
    .replace(/adoquines|adoquin|adoqin|doquines|doquin|adokines/g, "adoquin");
}

// ==============================
// 🧠 DETECTAR PRODUCTO
// ==============================
function detectarProducto(texto) {
  for (const key in catalogo) {
    const nombre = catalogo[key].nombre.toLowerCase();

    if (texto.includes(nombre)) return key;

    // detectar medidas tipo 20x10x6
    const medida = nombre.match(/\d+x\d+x\d+/);
    if (medida && texto.includes(medida[0])) return key;
  }

  return null;
}

// ==============================
// 📤 ENVIAR MENSAJE
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
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

// ==============================
// 🖼️ ENVIAR IMÁGENES
// ==============================
async function enviarImagenes(to, producto) {
  const data = catalogo[producto];

  if (!data?.imagenes?.length) return;

  await enviarMensaje(to, `mira ${data.nombre} 👇`);

  for (const img of data.imagenes) {
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
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    await new Promise(r => setTimeout(r, 700));
  }

  await enviarMensaje(
    to,
    "si quieres te ayudo a calcular lo que necesitas o te doy idea de costo"
  );
}

// ==============================
// ✅ VERIFY META
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

    text = normalizar(text);

    if (processedMessages.has(msgId)) return res.sendStatus(200);
    processedMessages.add(msgId);

    console.log("Mensaje:", text);

    // ==============================
    // 🧠 CREAR SESIÓN
    // ==============================
    if (!sessions.has(from)) {
      sessions.set(from, {
        estado: "inicio",
        producto: null,
        metros: null
      });
    }

    const session = sessions.get(from);

    const esSi = ["si", "dale", "ok", "claro"].includes(text);
    const quiereTodo = text.includes("todo");
    const quiereImagen = text.includes("foto") || text.includes("imagen") || text.includes("ver");

    // ==============================
    // 🔍 DETECTAR PRODUCTO
    // ==============================
    const prod = detectarProducto(text);
    if (prod) {
      session.producto = prod;
      session.estado = "producto_seleccionado";
    }

    // ==============================
    // 🧠 FLUJO INTELIGENTE
    // ==============================

    // 1️⃣ SALUDO
    if (text === "hola" || text === "hol") {
      await enviarMensaje(from, "hola 😊 en que te ayudo?");
      return res.sendStatus(200);
    }

    // 2️⃣ QUIERE ADOQUINES
    if (text.includes("adoquin")) {
      session.estado = "mostrando_catalogo";

      let lista = "manejamos estos:\n\n";

      for (const key in catalogo) {
        lista += `• ${catalogo[key].nombre}\n`;
      }

      lista += "\nsi quieres ver alguno dime cual";

      await enviarMensaje(from, lista);
      return res.sendStatus(200);
    }

    // 3️⃣ MOSTRAR TODO
    if (quiereTodo) {
      let lista = "mira 👇\n\n";

      for (const key in catalogo) {
        lista += `• ${catalogo[key].nombre}\n`;
      }

      lista += "\ndime cual quieres ver";

      await enviarMensaje(from, lista);
      return res.sendStatus(200);
    }

    // 4️⃣ SI DICE "SI"
    if (esSi) {
      if (session.estado === "mostrando_catalogo") {
        await enviarMensaje(from, "cual te muestro?");
        return res.sendStatus(200);
      }

      if (session.estado === "producto_seleccionado") {
        await enviarImagenes(from, session.producto);
        session.estado = "mostro_imagenes";
        return res.sendStatus(200);
      }

      if (session.estado === "mostro_imagenes") {
        await enviarMensaje(from, "cuantos metros necesitas?");
        session.estado = "esperando_metros";
        return res.sendStatus(200);
      }
    }

    // 5️⃣ MOSTRAR IMÁGENES DIRECTO
    if (quiereImagen && session.producto) {
      await enviarImagenes(from, session.producto);
      session.estado = "mostro_imagenes";
      return res.sendStatus(200);
    }

    // 6️⃣ SI YA ELIGIÓ PRODUCTO
    if (session.producto && session.estado === "producto_seleccionado") {
      await enviarImagenes(from, session.producto);
      session.estado = "mostro_imagenes";
      return res.sendStatus(200);
    }

    // 7️⃣ DETECTAR METROS
    if (session.estado === "esperando_metros") {
      const num = parseInt(text);
      if (num) {
        const rendimiento = catalogo[session.producto].rendimiento || 50;
        const total = num * rendimiento;

        await enviarMensaje(
          from,
          `para ${num} m² necesitas aprox ${total} unidades`
        );

        await enviarMensaje(
          from,
          "si quieres te ayudo con precio o envio"
        );

        session.estado = "cotizando";
        return res.sendStatus(200);
      }
    }

    // ==============================
    // 🤖 IA SOLO SI FALLA TODO
    // ==============================
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `
Eres Ana de una ladrillera.

Hablas como persona real:
- corta
- natural
- amable
- no robot
- ayudas fácil
`
          },
          { role: "user", content: text }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    await enviarMensaje(from, response.data.choices[0].message.content);

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
