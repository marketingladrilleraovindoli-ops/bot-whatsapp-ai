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
// 📦 CATÁLOGO (EDITA SOLO IMÁGENES)
// ==============================
const catalogo = {
  adoquin_20x10x6: {
    nombre: "Adoquín 20x10x6",
    uso: "ideal para exterior",
    rendimiento: 50,
    tonos: ["durazno", "canelo", "matizado"],
    imagenes: [
      "https://TU-IMAGEN-1.jpg",
      "https://TU-IMAGEN-2.jpg"
    ]
  },

  adoquin_20x10x4: {
    nombre: "Adoquín 20x10x4",
    rendimiento: 50,
    tonos: ["durazno", "canelo", "matizado"],
    imagenes: [
      "https://TU-IMAGEN-1.jpg",
      "https://TU-IMAGEN-2.jpg"
    ]
  },

  fachaleta_cappuccino: {
    nombre: "Fachaleta Cappuccino",
    imagenes: [
      "https://TU-IMAGEN-1.jpg",
      "https://TU-IMAGEN-2.jpg"
    ]
  },

  fachaleta_toscano: {
    nombre: "Fachaleta Toscano",
    imagenes: [
      "https://TU-IMAGEN-1.jpg",
      "https://TU-IMAGEN-2.jpg"
    ]
  }
};

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

    // ❌ ignorar estados
    if (value?.statuses) return res.sendStatus(200);

    const message = value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const msgId = message.id;
    const text = message.text?.body?.toLowerCase().trim();

    if (!text) return res.sendStatus(200);

    // ❌ evitar duplicados
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
        ubicacion: null,
        calculado: false,
        envioRespondido: false
      });
    }

    const session = sessions.get(from);

    // guardar historial
    session.history.push({ role: "user", content: text });
    if (session.history.length > 6) session.history.shift();

    // ==============================
    // 🔍 DETECCIÓN INTELIGENTE
    // ==============================
    if (text.includes("20") && text.includes("10") && text.includes("6")) {
      session.producto = "adoquin_20x10x6";
    }

    if (text.includes("20") && text.includes("10") && text.includes("4")) {
      session.producto = "adoquin_20x10x4";
    }

    if (text.includes("cappuccino")) {
      session.producto = "fachaleta_cappuccino";
    }

    if (text.includes("toscano")) {
      session.producto = "fachaleta_toscano";
    }

    // metros
    if (text.includes("metro")) {
      const num = parseInt(text);
      if (num) session.metros = num;
    }

    // ubicación
    if (
      text.includes("cogua") ||
      text.includes("zipa") ||
      text.includes("bogota")
    ) {
      session.ubicacion = text;
    }

    const quiereImagen =
      text.includes("imagen") ||
      text.includes("foto") ||
      text.includes("ver") ||
      text.includes("muestr");

    // ==============================
    // 🖼️ IMÁGENES (REAL)
    // ==============================
    if (quiereImagen && session.producto && catalogo[session.producto]) {
      await axios.post(
        `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          to: from,
          text: { body: "mira 👍" }
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            "Content-Type": "application/json"
          }
        }
      );

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

        await new Promise(r => setTimeout(r, 900));
      }

      return res.sendStatus(200);
    }

    // ==============================
    // 🧠 RESPUESTAS DIRECTAS (rápidas)
    // ==============================
    let reply = null;

    if (session.producto && !session.metros) {
      reply = "sí 👍 ese es muy usado";
    }

    if (
      session.producto &&
      session.metros &&
      !session.calculado &&
      catalogo[session.producto]?.rendimiento
    ) {
      const unidades = session.metros * catalogo[session.producto].rendimiento;
      reply = `para ${session.metros} m² necesitas aprox ${unidades} unidades 👍`;
      session.calculado = true;
    }

    if (session.ubicacion && !session.envioRespondido) {
      reply = `dale 👍 hasta ${session.ubicacion} sí hacemos envío, te reviso el costo`;
      session.envioRespondido = true;
    }

    if (text.includes("color") || text.includes("tono")) {
      const tonos = catalogo[session.producto]?.tonos;
      if (tonos) {
        reply = `tenemos ${tonos.join(", ")} 👍`;
      }
    }

    // ==============================
    // 🤖 IA (CON MEMORIA REAL)
    // ==============================
    if (!reply) {
      const systemPrompt = `
Eres Ana, asesora de Ladrillera La Toscana.

Hablas como una persona real.

Reglas:
- respuestas cortas
- natural (ej: "dale", "perfecto", "ya te reviso")
- no suenas robot
- no repites preguntas
- ayudas fácil
- no presionas venta
- no das info que no pidan
- si no entiendes: "qué pena, no te entendí bien"
`;

      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
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
      session.history.push({ role: "assistant", content: reply });
    }

    // ==============================
    // ⏱️ DELAY HUMANO REAL
    // ==============================
    const delay = Math.floor(Math.random() * 2500) + 1200;
    await new Promise(r => setTimeout(r, delay));

    // ==============================
    // 📤 RESPUESTA
    // ==============================
    await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: from,
        text: { body: reply }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

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
