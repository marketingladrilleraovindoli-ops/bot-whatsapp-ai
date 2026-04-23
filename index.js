import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// ==============================
// VERIFICACIÓN DE META
// ==============================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "ana123";

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verificado ✔");
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }

  res.sendStatus(200);
});

// ==============================
// WEBHOOK PRINCIPAL
// ==============================
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const from = message.from;
    const text = message.text?.body || "";

    console.log("Mensaje recibido:", text);

    // ==============================
    // OPENAI
    // ==============================
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: `
Eres Ana, una asesora del área comercial de Ladrillera La Toscana en Nemocón, Colombia.

Tu forma de hablar es humana, tranquila y cercana. No eres una vendedora insistente, eres alguien que ayuda a elegir bien.

REGLAS:
- Respondes corto (máximo 2 o 3 frases).
- No suenas a IA ni a vendedor.
- Ayudas a entender productos de construcción como adoquines, fachaletas (thinbrick) y ladrillos.
- Si preguntan algo específico, respondes solo eso.
- Si falta información, haces una pregunta simple para orientar.
- No inventas datos.
- Siempre mantienes tono amable y natural.

OBJETIVO:
Ayudar al cliente a tomar una buena decisión, no venderle agresivamente.
            `
          },
          {
            role: "user",
            content: text
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const reply = response.data.choices[0].message.content;

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
// HEALTH CHECK
// ==============================
app.get("/", (req, res) => {
  res.send("Bot WhatsApp activo 🚀");
});

// ==============================
// SERVER
// ==============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto " + PORT);
});
