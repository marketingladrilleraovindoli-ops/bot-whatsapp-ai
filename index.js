import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "ana123";

// memoria usuarios
const sessions = new Map();
const processedMessages = new Set();

// ==============================
// VERIFY
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
// WEBHOOK
// ==============================
app.post("/webhook", async (req, res) => {
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;

    // ❌ evitar mensajes fantasma
    if (value?.statuses) return res.sendStatus(200);

    const message = value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const msgId = message.id;
    const text = message.text?.body?.toLowerCase().trim();

    if (!text) return res.sendStatus(200);

    // ❌ duplicados
    if (processedMessages.has(msgId)) return res.sendStatus(200);
    processedMessages.add(msgId);

    console.log("Mensaje:", text);

    // ==============================
    // SESIÓN
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

    // ==============================
    // DETECTAR INTENCIÓN
    // ==============================
    if (text.includes("20") && text.includes("10") && text.includes("6")) {
      session.producto = "adoquin_20x10x6";
    }

    if (text.includes("metro")) {
      const num = parseInt(text);
      if (num) session.metros = num;
    }

    if (text.includes("cogua") || text.includes("zipa") || text.includes("bogota")) {
      session.ubicacion = text;
    }

    // ==============================
    // RESPUESTAS INTELIGENTES
    // ==============================
    let reply = null;

    // PRODUCTO
    if (session.producto === "adoquin_20x10x6" && !session.metros) {
      reply = "sí claro 👍 ese es de los más usados para exterior";
    }

    // CALCULO REAL
    if (session.producto === "adoquin_20x10x6" && session.metros && !session.calculado) {
      const unidades = session.metros * 50;
      reply = `para ${session.metros} m² necesitas aprox ${unidades} adoquines 👍`;
      session.calculado = true;
    }

    // ENVÍO
    if (session.ubicacion && !session.envioRespondido) {
      reply = `dale 👍 hasta ${session.ubicacion} sí hacemos envío, te reviso el costo exacto`;
      session.envioRespondido = true;
    }

    // TONALIDADES
    if (text.includes("tono") || text.includes("color")) {
      reply = "manejamos durazno, canelo y matizado 👍";
    }

    // IMÁGENES
    if (text.includes("imagen") || text.includes("foto")) {
      await axios.post(
        `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          to: from,
          type: "image",
          image: {
            link: "https://i.imgur.com/yourimage.jpg"
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

    // SI NO HAY RESPUESTA → IA
    if (!reply) {
      const systemPrompt = `
Eres Ana de Ladrillera La Toscana.

Hablas como persona real, corta y natural.

- no suenas robot
- no repites preguntas
- ayudas fácil
- dices cosas como "dale", "perfecto", "ya te reviso"
- guías a cotizar o comprar

no das info que no pidan
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
    // DELAY HUMANO
    // ==============================
    const delay = Math.floor(Math.random() * 2000) + 1500;
    await new Promise(r => setTimeout(r, delay));

    // ==============================
    // RESPUESTA
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
    console.error(error.response?.data || error.message);
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
