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
// 📦 CATÁLOGO (EDITA CON TUS IMÁGENES)
// ==============================
const catalogo = {
  adoquin_20x10x6: {
    nombre: "Adoquín 20x10x6",
    uso: "ideal para exteriores",
    rendimiento: 50,
    tonos: ["durazno", "canelo", "matizado"],
    imagenes: [
      "https://i.imgur.com/8Km9tLL.jpg",
      "https://i.imgur.com/5tj6S7Ol.jpg",
      "https://i.imgur.com/3ZQ3Z6cl.jpg"
    ]
  },

  fachaleta_capuccino: {
    nombre: "Fachaleta Capuccino",
    imagenes: [
      "https://i.imgur.com/abc1.jpg",
      "https://i.imgur.com/abc2.jpg"
    ]
  },

  fachaleta_toscano: {
    nombre: "Fachaleta Toscano",
    imagenes: [
      "https://i.imgur.com/xyz1.jpg",
      "https://i.imgur.com/xyz2.jpg"
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

    // ❌ evitar estados y eventos raros
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

    // ==============================
    // 🔍 DETECTAR INTENCIÓN
    // ==============================

    if (text.includes("20") && text.includes("10") && text.includes("6")) {
      session.producto = "adoquin_20x10x6";
    }

    if (text.includes("capuccino")) {
      session.producto = "fachaleta_capuccino";
    }

    if (text.includes("toscano")) {
      session.producto = "fachaleta_toscano";
    }

    if (text.includes("metro")) {
      const num = parseInt(text);
      if (num) session.metros = num;
    }

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
    // 🖼️ ENVIAR IMÁGENES
    // ==============================
    if (quiereImagen && catalogo[session.producto]?.imagenes) {
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

        await new Promise(r => setTimeout(r, 800));
      }

      return res.sendStatus(200);
    }

    // ==============================
    // 🧠 RESPUESTAS INTELIGENTES
    // ==============================
    let reply = null;

    if (session.producto === "adoquin_20x10x6" && !session.metros) {
      reply = "sí 👍 ese es muy usado para exterior";
    }

    if (session.producto === "adoquin_20x10x6" && session.metros && !session.calculado) {
      const unidades = session.metros * 50;
      reply = `para ${session.metros} m² necesitas aprox ${unidades} adoquines 👍`;
      session.calculado = true;
    }

    if (session.ubicacion && !session.envioRespondido) {
      reply = `dale 👍 hasta ${session.ubicacion} sí hacemos envío, te reviso el costo`;
      session.envioRespondido = true;
    }

    if (text.includes("tono") || text.includes("color")) {
      reply = "manejamos durazno, canelo y matizado 👍";
    }

    // ==============================
    // 🤖 IA (SOLO SI NO HAY RESPUESTA)
    // ==============================
    if (!reply) {
      const systemPrompt = `
Eres Ana, asesora de Ladrillera La Toscana.

Hablas como persona real.

Reglas:
- respuestas cortas
- natural (ej: "dale", "perfecto", "ya te reviso")
- no repites preguntas
- no suenas robot
- no presionas venta
- ayudas fácil
- no das info que no pidan
- si no entiendes: "qué pena, no te entendí bien"
`;

      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
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

      reply = response.data.choices[0].message.content;
    }

    // ==============================
    // ⏱️ DELAY HUMANO
    // ==============================
    const delay = Math.floor(Math.random() * 2000) + 1500;
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
