import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "ana123";

// ==============================
// MEMORIA
// ==============================
const sessions = new Map();
const processedMessages = new Set();

// ==============================
// CATÁLOGO REAL BASE (puedes crecerlo)
// ==============================
const catalogo = {
  adoquin_20x10x6: {
    nombre: "Adoquín 20x10x6",
    uso: "ideal para exteriores, tráfico peatonal y vehicular",
    rendimiento: 50,
    tonos: ["durazno", "canelo", "matizado"]
  },
  adoquin_24x12x6: {
    nombre: "Adoquín 24x12x6",
    uso: "más robusto, recomendado para tráfico pesado",
    rendimiento: 35,
    tonos: ["gris", "rojo", "matizado"]
  },
  fachaleta: {
    nombre: "Fachaleta (Thinbrick)",
    uso: "acabados decorativos tipo ladrillo",
    tonos: ["nero", "bianco", "toscano", "capuccino"]
  }
};

// ==============================
// VERIFY META
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

    // ❌ evitar eventos que no son mensajes
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

    console.log("Mensaje:", text);

    // ==============================
    // CREAR SESIÓN
    // ==============================
    if (!sessions.has(from)) {
      sessions.set(from, {
        history: [],
        producto: null,
        metros: null,
        ubicacion: null,
        calculado: false
      });
    }

    const session = sessions.get(from);

    // ==============================
    // GUARDAR HISTORIAL (IMPORTANTE)
    // ==============================
    session.history.push({ role: "user", content: text });
    if (session.history.length > 10) session.history.shift();

    // ==============================
    // DETECCIÓN INTELIGENTE
    // ==============================
    if (text.includes("20") && text.includes("10") && text.includes("6")) {
      session.producto = "adoquin_20x10x6";
    }

    if (text.includes("24") && text.includes("12") && text.includes("6")) {
      session.producto = "adoquin_24x12x6";
    }

    if (text.includes("facha") || text.includes("thinbrick")) {
      session.producto = "fachaleta";
    }

    if (text.includes("metro")) {
      const num = parseInt(text);
      if (num) session.metros = num;
    }

    if (text.includes("cogua") || text.includes("zipa") || text.includes("bogota")) {
      session.ubicacion = text;
    }

    // ==============================
    // RESPUESTA INTELIGENTE
    // ==============================
    let reply = null;

    const producto = catalogo[session.producto];

    // 🔹 RESPUESTA DE PRODUCTO
    if (producto && !session.metros && !reply) {
      reply = `sí 👍 ese ${producto.nombre.toLowerCase()} es ${producto.uso}`;
    }

    // 🔹 CÁLCULO REAL
    if (producto && session.metros && !session.calculado && producto.rendimiento) {
      const total = session.metros * producto.rendimiento;
      reply = `para ${session.metros} m² necesitas aprox ${total} unidades 👍`;
      session.calculado = true;
    }

    // 🔹 ENVÍO
    if (session.ubicacion && !session.envioRespondido) {
      reply = `sí hacemos envío hasta ${session.ubicacion} 👍 te reviso el costo`;
      session.envioRespondido = true;
    }

    // 🔹 TONOS
    if (producto && (text.includes("tono") || text.includes("color"))) {
      reply = `manejamos tonos ${producto.tonos.join(", ")} 👍`;
    }

    // 🔹 IMÁGENES
    if (text.includes("imagen") || text.includes("foto")) {
      await axios.post(
        `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          to: from,
          type: "image",
          image: {
            link: "https://i.imgur.com/8Km9tLL.jpg" // cambia por tus reales
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
    // IA SOLO SI NO HAY RESPUESTA
    // ==============================
    if (!reply) {
      const systemPrompt = `
Eres Ana de Ladrillera La Toscana.

Hablas como persona real de Colombia.

Reglas:
- Respuestas cortas
- Natural (ej: "dale", "ya te reviso", "que pena")
- No suenas robot
- No repites preguntas
- No presionas venta
- Ayudas fácil
- Recuerdas lo que el cliente dijo

Objetivo:
- ayudar
- guiar a cotizar
- cerrar venta de forma natural

Nunca des info que no pidan.
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
    }

    // guardar respuesta en memoria
    session.history.push({ role: "assistant", content: reply });

    // ==============================
    // DELAY HUMANO (REALISTA)
    // ==============================
    const delay = Math.floor(Math.random() * 3000) + 1500;
    await new Promise(r => setTimeout(r, delay));

    // ==============================
    // RESPONDER
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
