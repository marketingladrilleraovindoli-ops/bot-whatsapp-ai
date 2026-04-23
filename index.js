import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// Webhook de WhatsApp
app.post("/webhook", async (req, res) => {
  const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (!message) return res.sendStatus(200);

  const from = message.from;
  const text = message.text?.body || "";

  try {
    // OpenAI
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-5-mini",
        messages: [
          { role: "system", content: "Eres un asistente de WhatsApp, responde corto y claro." },
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

    const reply = response.data.choices[0].message.content;

    // WhatsApp reply
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
    res.sendStatus(500);
  }
});

app.get("/", (req, res) => {
  res.send("Bot WhatsApp activo 🚀");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor corriendo en puerto " + PORT));
