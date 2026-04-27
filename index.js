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

// 📄 PDF catálogo (pon tu link real)
const CATALOGO_PDF = "https://TU-CATALOGO.pdf";

// ==============================
// 🧠 NORMALIZAR TEXTO (ERRORES HUMANOS)
// ==============================
function normalizarTexto(texto) {
  return texto
    .replace(/doquin|doquines|adokines|adoquines|adoqin|adoquin/g, "adoquin")
    .replace(/ladrilo|ladrilos/g, "ladrillo")
    .replace(/fachada|fachadas/g, "fachaleta");
}

// ==============================
// 🧠 DETECCIÓN INTELIGENTE
// ==============================
function detectarProducto(texto) {
  if (texto.includes("adoquin")) return "adoquin_20x10x6";
  if (texto.includes("toscano")) return "fachaleta_toscano";
  if (texto.includes("bianco")) return "fachaleta_bianco";
  return null;
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

    let text = message.text?.body?.toLowerCase().trim();
    if (!text) return res.sendStatus(200);

    text = normalizarTexto(text);

    // ❌ duplicados
    if (processedMessages.has(msgId)) return res.sendStatus(200);
    processedMessages.add(msgId);

    if (processedMessages.size > 1000) processedMessages.clear();

    console.log("Mensaje:", text);

    // ==============================
    // 🧠 SESIÓN
    // ==============================
    if (!sessions.has(from)) {
      sessions.set(from, {
        history: [],
        producto: null,
        metros: null,
        ubicacion: null
      });
    }

    const session = sessions.get(from);

    session.history.push({ role: "user", content: text });
    if (session.history.length > 6) session.history.shift();

    // ==============================
    // 🔍 DETECCIÓN
    // ==============================
    const productoDetectado = detectarProducto(text);

    if (productoDetectado) {
      session.producto = productoDetectado;
    }

    const quiereTodo =
      text.includes("todo") ||
      text.includes("todos") ||
      text.includes("catalogo");

    const quiereImagen =
      text.includes("foto") ||
      text.includes("imagen") ||
      text.includes("ver");

    const quierePDF =
      text.includes("pdf") ||
      text.includes("catalogo completo");

    // ==============================
    // 📄 ENVIAR PDF
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
      let mensaje = "claro 👍 te muestro lo que manejamos:\n\n";

      for (const key in catalogo) {
        mensaje += `• ${catalogo[key].nombre}\n`;
      }

      mensaje += "\nsi quieres fotos dime cuál 👍";

      await axios.post(
        `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          to: from,
          text: { body: mensaje }
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
    // 🖼️ IMÁGENES
    // ==============================
    if (quiereImagen && session.producto && catalogo[session.producto]) {
      for (const img of catalogo[session.producto].imagenes) {
        await axios.post(
          `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: "whatsapp",
            to: from,
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

        await new Promise(r => setTimeout(r, 800));
      }

      return res.sendStatus(200);
    }

    // ==============================
    // 🤔 SI NO ENTIENDE BIEN
    // ==============================
    if (!session.producto && text.includes("adoquin")) {
      await enviarMensaje(from, "¿te refieres a adoquines? 👍");
      return res.sendStatus(200);
    }

    // ==============================
    // 🧠 RESPUESTA BASE
    // ==============================
    let reply = null;

    if (session.producto) {
      reply = "sí 👍 ese lo manejamos, si quieres te muestro fotos";
    }

    // ==============================
    // 🤖 IA CON MEMORIA
    // ==============================
    if (!reply) {
      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `
Eres Ana de Ladrillera La Toscana.

Hablas como persona real.

- corto
- natural
- no robot
- ayudas fácil
- si no entiendes: "qué pena, no te entendí bien"
`
            },
            ...session.history
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          }
        }
      );

      reply = response.data.choices[0].message.content;
    }

    // ==============================
    // ⏱️ DELAY HUMANO
    // ==============================
    await new Promise(r => setTimeout(r, Math.random() * 2000 + 1000));

    await enviarMensaje(from, reply);

    res.sendStatus(200);

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.sendStatus(200);
  }
});

// ==============================
// 📤 FUNCIÓN MENSAJE
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
app.get("/", (req, res) => {
  res.send("Ana PRO activa 🚀");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor activo");
});
