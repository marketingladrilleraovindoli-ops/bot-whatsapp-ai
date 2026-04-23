import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// ==============================
// CONFIG
// ==============================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "ana123";

// memoria simple
const sessions = new Map();

// evitar duplicados
const processedMessages = new Set();

// ==============================
// WEBHOOK VERIFY
// ==============================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado ✔");
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});

// ==============================
// WEBHOOK PRINCIPAL
// ==============================
app.post("/webhook", async (req, res) => {
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const from = message.from;
    const msgId = message.id;
    const text = message.text?.body?.trim()?.toLowerCase() || "";

    // evitar duplicados
    if (processedMessages.has(msgId)) return res.sendStatus(200);
    processedMessages.add(msgId);

    if (processedMessages.size > 2000) processedMessages.clear();

    // ignorar eco
    if (message.context?.from) return res.sendStatus(200);

    console.log("Mensaje recibido:", text);

    // ==============================
    // MEMORIA
    // ==============================
    if (!sessions.has(from)) {
      sessions.set(from, {
        history: [],
        stage: "inicio",
        lastProduct: null
      });
    }

    const session = sessions.get(from);

    session.history.push({ role: "user", content: text });
    if (session.history.length > 8) session.history.shift();

    // detectar intención simple (esto ayuda MUCHO)
    if (text.includes("adoquin")) session.lastProduct = "adoquin";
    if (text.includes("fachaleta") || text.includes("thinbrick")) session.lastProduct = "fachaleta";

    // ==============================
    // PROMPT ANA (MEJORADO HUMANO)
    // ==============================
    const systemPrompt = `
Eres Ana, asesora comercial de Ladrillera La Toscana en Némocón.

Personalidad:
- Muy humana, amable y simple
- Respuestas cortas (máx 2 líneas)
- No suenas a IA ni robótica
- Ayudas a elegir productos, no presionas venta
- Si no tienes info exacta, preguntas simple

Reglas:
- Nunca des información que no pidan
- Si el cliente ya dijo un producto, NO repreguntar lo mismo
- Si el usuario está interesado, guía paso a paso simple

Productos:
- Adoquines (varios tamaños)
- Fachaletas / Thinbrick
- Ladrillos estructurales
- Refractarios

Si el usuario pide algo específico (ej: 20x10x6):
responde SOLO ese producto y pregunta siguiente paso simple como:
"¿Lo necesitas para piso o exterior?"
`;

    // ==============================
    // OPENAI
    // ==============================
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          ...session.history
        ],
        temperature: 0.4
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const reply = response.data.choices[0].message.content;

    session.history.push({ role: "assistant", content: reply });

    // ==============================
    // WHATSAPP RESPONSE
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
    console.error("ERROR WEBHOOK:", error.response?.data || error.message);
    res.sendStatus(200);
  }
});

// ==============================
// SERVER
// ==============================
app.get("/", (req, res) => {
  res.send("Ana bot activo 🚀");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto " + PORT);
});
