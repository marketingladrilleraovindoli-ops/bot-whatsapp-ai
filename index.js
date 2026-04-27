import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "ana123";

const sessions = new Map();
const processedMessages = new Set();

// ==============================
// 📦 CATÁLOGO
// ==============================
const catalogo = {
  adoquin_20x10x6: {
    nombre: "Adoquín 20x10x6",
    imagenes: [
      "https://via.placeholder.com/500x500?text=Adoquin1",
      "https://via.placeholder.com/500x500?text=Adoquin2"
    ]
  },

  adoquin_20x10x4: {
    nombre: "Adoquín 20x10x4",
    imagenes: [
      "https://via.placeholder.com/500x500?text=Adoquin3",
      "https://via.placeholder.com/500x500?text=Adoquin4"
    ]
  }
};

// ==============================
// NORMALIZAR TEXTO
// ==============================
function normalizar(texto) {
  return texto
    .toLowerCase()
    .replace(/doquin|adoquines|adoqin|adokines/g, "adoquin");
}

// ==============================
// DETECTAR PRODUCTO
// ==============================
function detectarProducto(texto) {
  if (texto.includes("20x10x6")) return "adoquin_20x10x6";
  if (texto.includes("20x10x4")) return "adoquin_20x10x4";

  if (texto.includes("adoquin")) return "GENERAL";

  return null;
}

// ==============================
// ENVIAR TEXTO
// ==============================
async function enviarTexto(to, body) {
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
// ENVIAR IMÁGENES
// ==============================
async function enviarImagenes(to, producto) {
  const item = catalogo[producto];
  if (!item) return;

  await enviarTexto(to, `mira 👇`);

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
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    await new Promise(r => setTimeout(r, 600));
  }
}

// ==============================
// VERIFY
// ==============================
app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

// ==============================
// WEBHOOK
// ==============================
app.post("/webhook", async (req, res) => {
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;

    if (value?.statuses) return res.sendStatus(200);

    const msg = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    const id = msg.id;

    let text = msg.text?.body;
    if (!text) return res.sendStatus(200);

    text = normalizar(text);

    if (processedMessages.has(id)) return res.sendStatus(200);
    processedMessages.add(id);

    console.log("Mensaje:", text);

    // ==============================
    // SESIÓN
    // ==============================
    if (!sessions.has(from)) {
      sessions.set(from, {
        producto: null,
        esperandoImagen: false
      });
    }

    const session = sessions.get(from);

    // ==============================
    // INTENCIÓN
    // ==============================
    const producto = detectarProducto(text);
    if (producto) session.producto = producto;

    const esSi = ["si", "sí", "dale", "ok"].includes(text);

    const quiereTodo =
      text.includes("todo") ||
      text.includes("cuales") ||
      text.includes("tienen");

    const quiereVer =
      text.includes("ver") ||
      text.includes("mostrar") ||
      text.includes("foto");

    // ==============================
    // MOSTRAR TODO
    // ==============================
    if (quiereTodo) {
      let lista = "manejamos estos:\n\n";

      Object.values(catalogo).forEach(p => {
        lista += `• ${p.nombre}\n`;
      });

      lista += "\ndime cuál quieres ver 👍";

      await enviarTexto(from, lista);
      return res.sendStatus(200);
    }

    // ==============================
    // RESPUESTA INTELIGENTE
    // ==============================

    // 👉 usuario dice "adoquines"
    if (session.producto === "GENERAL") {
      await enviarTexto(
        from,
        "sí 👍 manejamos varios\nquieres que te muestre referencias?"
      );

      session.esperandoImagen = true;
      return res.sendStatus(200);
    }

    // 👉 usuario dijo SI después
    if (esSi && session.esperandoImagen) {
      let lista = "tengo estos:\n\n";

      Object.values(catalogo).forEach(p => {
        lista += `• ${p.nombre}\n`;
      });

      lista += "\ndime cuál quieres ver 👍";

      await enviarTexto(from, lista);

      session.esperandoImagen = false;
      return res.sendStatus(200);
    }

    // 👉 usuario eligió producto
    if (catalogo[session.producto]) {
      await enviarImagenes(from, session.producto);
      return res.sendStatus(200);
    }

    // ==============================
    // FALLBACK HUMANO
    // ==============================
    await enviarTexto(from, "hola 😊 en qué te ayudo?");
    res.sendStatus(200);

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.sendStatus(200);
  }
});

// ==============================
app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor activo");
});
