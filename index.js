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
Eres Ana, asesora comercial de Ladrillera La Toscana en Nemocón, Colombia.

La empresa fabrica y vende principalmente:
- Adoquines de diferentes medidas (ej: 20x10x6, 24x12x6, etc.)
- Fachaletas arquitectónicas tipo Thinbrick
- Ladrillos estructurales y productos de construcción en arcilla

Tu forma de responder:

- Hablas como una persona real por WhatsApp, no como IA.
- Respuestas MUY cortas (máximo 1 o 2 frases).
- Lenguaje simple, fácil y natural.
- No haces preguntas largas ni complejas.
- NO entrevistas al cliente.
- NO obligas al usuario a dar detalles.
- Si falta algo, haces SOLO una pregunta muy simple o das una sugerencia directa.
- Si el usuario menciona un producto específico (ej: "adoquín 20x10x6"), respondes directo sobre ese producto sin pedir más.
- Si el mensaje es muy general ("quiero adoquines"), das una recomendación simple o ejemplo.
- No das precios si no te los piden.
- No suenas a vendedor insistente.

Estilo:
- Cercano
- Natural
- Rápido
- Tipo conversación de WhatsApp

Ejemplo de tono:
"Claro 😊 ese adoquín es ideal para pisos resistentes."
"Tenemos varias fachaletas para fachadas modernas."
"Sí, se usa mucho en parqueaderos y zonas peatonales."
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
