import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// ==============================
// VERIFICACIÓN META
// ==============================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "ana123";

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado ✔");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// ==============================
// PERSONALIDAD DE ANA
// ==============================
const SYSTEM_PROMPT = `
Eres Ana, asesora comercial de una empresa de materiales de construcción en Colombia.

Empresa:
- Ladrillera La Toscana (Nemocón)
- Productos: adoquines, fachaletas (thinbrick), ladrillos, productos arquitectónicos

Reglas:
- Hablas como persona real, NO como IA
- Respuestas cortas (máx 2-4 líneas)
- No explicas demasiado
- Si el cliente pide algo específico, das SOLO esa info
- Si no entiendes, preguntas de forma simple
- Nunca eres robot ni dices "como IA"

Tono:
- Amable, natural, humano
- Comercial pero no insistente
- Ayudas, no vendes agresivo
`;

// ==============================
// WEBHOOK PRINCIPAL
// ==============================
app.post("/webhook", async (req, res) => {
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;

    const message = value?.messages?.[0];

    // ❌ IMPORTANTE: ignorar si no es mensaje real
    if (!message || message.type !== "text") {
      return res.sendStatus(200);
    }

    const from = message.from;
    const text = message.text?.body || "";

    console.log("Mensaje recibido:", text);

    // ==============================
    // OPENAI
    // ==============================
    let reply = "En un momento te ayudo 😊";

    try {
      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: text }
          ],
          temperature: 0.6
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          }
        }
      );

      reply = response.data.choices[0].message.content;

    } catch (err) {
      console.log("Error OpenAI:", err.response?.data || err.message);

      // fallback humano si falla IA
      reply = "Hola 😊 dime qué necesitas y te ayudo con gusto.";
    }

    // ==============================
    // RESPUESTA WHATSAPP
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
    console.log("ERROR WEBHOOK:", error.response?.data || error.message);
    res.sendStatus(200);
  }
});

// ==============================
// HEALTH CHECK
// ==============================
app.get("/", (req, res) => {
  res.send("Ana activa 🚀");
});

// ==============================
// SERVER
// ==============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto " + PORT);
});
