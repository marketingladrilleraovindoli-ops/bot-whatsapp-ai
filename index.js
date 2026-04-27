import express from "express";
import axios from "axios";
import dotenv from "dotenv";

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
// 📦 CATÁLOGO
// ==============================
const catalogo = {
  adoquin_20x10x6: {
    nombre: "Adoquín 20x10x6",
    rendimiento: 50,
    tonos: ["durazno", "canelo", "matizado"],
    imagenes: [
      "https://TU-IMG-1.jpg",
      "https://TU-IMG-2.jpg"
    ]
  },

  adoquin_20x10x4: {
    nombre: "Adoquín 20x10x4",
    rendimiento: 50,
    tonos: ["durazno", "canelo", "matizado"],
    imagenes: [
      "https://TU-IMG-1.jpg",
      "https://TU-IMG-2.jpg"
    ]
  },

  fachaleta_toscano: {
    nombre: "Fachaleta Toscano",
    imagenes: [
      "https://TU-IMG-1.jpg",
      "https://TU-IMG-2.jpg"
    ]
  },

  fachaleta_bianco: {
    nombre: "Fachaleta Bianco Ártico",
    imagenes: [
      "https://TU-IMG-1.jpg",
      "https://TU-IMG-2.jpg"
    ]
  }
};

// 📄 PDF
const CATALOGO_PDF = "https://TU-CATALOGO.pdf";

// ==============================
// 🧠 NORMALIZAR TEXTO
// ==============================
function normalizarTexto(texto) {
  return texto
    .toLowerCase()
    .replace(/doquin|doquines|adokines|adoquines|adoqin/g, "adoquin")
    .replace(/fachada|fachadas/g, "fachaleta");
}

// ==============================
// 🔍 DETECTAR PRODUCTO
// ==============================
function detectarProducto(texto) {
  if (texto.includes("20x10x6")) return "adoquin_20x10x6";
  if (texto.includes("20x10x4")) return "adoquin_20x10x4";
  if (texto.includes("toscano")) return "fachaleta_toscano";
  if (texto.includes("bianco")) return "fachaleta_bianco";

  if (texto.includes("adoquin")) return "GENERAL_ADOQUIN";

  return null;
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
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

// ==============================
// 🖼️ IMÁGENES
// ==============================
async function enviarImagenes(to, producto) {
  const item = catalogo[producto];
  if (!item) return;

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
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    await new Promise(r => setTimeout(r, 700));
  }
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

    // evitar duplicados
    if (processedMessages.has(msgId)) return res.sendStatus(200);
    processedMessages.add(msgId);

    console.log("Mensaje:", text);

    // ==============================
    // SESIÓN
    // ==============================
    if (!sessions.has(from)) {
      sessions.set(from, { producto: null });
    }

    const session = sessions.get(from);

    // ==============================
    // DETECTAR INTENCIÓN
    // ==============================
    const productoDetectado = detectarProducto(text);
    if (productoDetectado) {
      session.producto = productoDetectado;
    }

    const quiereTodo =
      text.includes("todo") ||
      text.includes("todos") ||
      text.includes("cuales") ||
      text.includes("tienen");

    const quiereImagen =
      text.includes("foto") ||
      text.includes("imagen") ||
      text.includes("muestra") ||
      text.includes("ver");

    const quierePDF =
      text.includes("pdf") ||
      text.includes("catalogo");

    // ==============================
    // 📄 PDF
    // ==============================
    if (quierePDF) {
      await axios.post(
        `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          to: from,
          type: "document",
          document: {
            link: CATALOGO_PDF,
            filename: "catalogo.pdf"
          }
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            "Content-Type": "application/json"
          }
        }
      );

      return res.sendStatus(200);
    }

    // ==============================
    // 📦 MOSTRAR TODO
    // ==============================
    if (quiereTodo) {
      let msg = "manejamos:\n\n";

      for (const key in catalogo) {
        msg += `• ${catalogo[key].nombre}\n`;
      }

      msg += "\nsi quieres fotos dime cuál 👍";

      await enviarMensaje(from, msg);
      return res.sendStatus(200);
    }

    // ==============================
    // 🖼️ MOSTRAR IMÁGENES
    // ==============================
    if (quiereImagen) {
      if (!session.producto || session.producto === "GENERAL_ADOQUIN") {
        await enviarMensaje(from, "cuál referencia quieres ver? 👍");
        return res.sendStatus(200);
      }

      await enviarImagenes(from, session.producto);
      return res.sendStatus(200);
    }

    // ==============================
    // RESPUESTA INTELIGENTE
    // ==============================
    let reply = null;

    if (session.producto === "GENERAL_ADOQUIN") {
      reply = "tenemos varios adoquines 👍 quieres que te muestre referencias?";
    }

    if (catalogo[session.producto]) {
      reply = `${catalogo[session.producto].nombre} 👍 quieres fotos o info?`;
    }

    // fallback IA
    if (!reply) {
      reply = "qué necesitas? 👍";
    }

    // delay humano
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
