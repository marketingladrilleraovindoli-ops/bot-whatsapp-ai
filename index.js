import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { catalogo } from "./catalogo.js";

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
// NORMALIZAR TEXTO
// ==============================
function normalizarTexto(texto) {
  return texto
    .toLowerCase()
    .replace(/doquin|doquines|adokines|adoqin|adoquines/g, "adoquin")
    .replace(/fachada|fachadas/g, "fachaleta");
}

// ==============================
// FUNCIONES DE ACCIÓN
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
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
      }
    }
  );
}

async function enviarImagenes(to, productoId) {
  const item = catalogo[productoId];
  if (!item || !item.imagenes || item.imagenes.length === 0) {
    await enviarMensaje(to, "Aún no tengo fotos de ese producto.");
    return;
  }

  await enviarMensaje(to, `Aquí tienes ${item.nombre}:`);

  for (const img of item.imagenes) {
    await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "image",
        image: { link: img }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
        }
      }
    );
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function mostrarCatalogo(to) {
  let mensaje = "Estos son los productos que manejamos:\n\n";
  for (const key in catalogo) {
    mensaje += `- ${catalogo[key].nombre}\n`;
  }
  mensaje += "\nSi quieres fotos o precios de alguno, solo dime.";
  await enviarMensaje(to, mensaje);
}

// ==============================
// IA CENTRAL CON DECISIÓN ESTRUCTURADA
// ==============================
async function procesarConIA(textoUsuario, from) {
  // Construir información del catálogo para la IA
  const catalogoInfo = Object.entries(catalogo)
    .map(([id, prod]) => {
      let info = `- id: ${id}, nombre: ${prod.nombre}`;
      if (prod.tonos) info += `, tonos: ${prod.tonos.join(", ")}`;
      if (prod.rendimiento) info += `, rendimiento: ${prod.rendimiento} unidades/m2`;
      return info;
    })
    .join("\n");

  const systemPrompt = `
Eres Ana, asesora experta de Ladrillera La Toscana. Hablas de forma natural, directa y amable. No usas emojis. No preguntas "cómo estás". Ayudas a elegir productos de construcción (adoquines, fachaletas, etc.) con respuestas cortas y seguras.

Tu trabajo es entender al usuario y responder con un JSON que contenga:
- "respuesta": string (lo que le dirás al usuario).
- "accion": string (puede ser "nada", "enviar_catalogo", o "enviar_imagenes").
- "producto_id": string (solo si accion es "enviar_imagenes", debe coincidir exactamente con alguna de las ids del catálogo).

Reglas importantes:
- Si el usuario pide ver el catálogo ("qué productos tienes", "muéstrame todo", "qué manejas", etc.) → accion="enviar_catalogo".
- Si el usuario pide fotos de un producto específico (ej: "enséñame el adoquín 20x10x3", "quiero ver la fachaleta cappuccino", "muéstrame el adoquin ecológico") → accion="enviar_imagenes" y producto_id debe coincidir exactamente con la id del catálogo (ej: "adoquin_20x10x3", "fachaleta_cappuccino").
- Si el usuario solo saluda o hace una pregunta general (precios, disponibilidad, envíos, etc.) → accion="nada". Pero responde de forma útil y natural.
- Siempre da una respuesta amable y útil en el campo "respuesta".
- Si no entiendes o falta información, responde con accion="nada" y pide aclaración de forma natural.

Catálogo disponible (id → nombre):
${catalogoInfo}

Ejemplos de respuesta JSON:
{"respuesta": "Hola, ¿en qué te ayudo?", "accion": "nada"}
{"respuesta": "Claro, te muestro nuestro catálogo.", "accion": "enviar_catalogo"}
{"respuesta": "Perfecto, enseguida te envío las fotos del adoquín 20x10x3.", "accion": "enviar_imagenes", "producto_id": "adoquin_20x10x3"}
{"respuesta": "Manejamos envíos a toda la región. ¿Cuál es tu ubicación para darte un costo exacto?", "accion": "nada"}

Recuerda: solo envías JSON, sin texto adicional.
`;

  const respuestaIA = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: textoUsuario }
      ],
      temperature: 0.3,
      response_format: { type: "json_object" }
    },
    {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
    }
  );

  const contenido = respuestaIA.data.choices[0].message.content;
  let decision;
  try {
    decision = JSON.parse(contenido);
  } catch (e) {
    console.error("Error parsing JSON de IA:", contenido);
    decision = {
      respuesta: "Lo siento, no entendí bien. ¿Puedes repetirlo?",
      accion: "nada"
    };
  }

  // Enviar respuesta textual
  await enviarMensaje(from, decision.respuesta);

  // Ejecutar acción si existe
  if (decision.accion === "enviar_catalogo") {
    await mostrarCatalogo(from);
  } else if (decision.accion === "enviar_imagenes" && decision.producto_id && catalogo[decision.producto_id]) {
    await enviarImagenes(from, decision.producto_id);
  }
}

// ==============================
// WEBHOOKS
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

app.post("/webhook", async (req, res) => {
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (value?.statuses) return res.sendStatus(200);

    const message = value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const msgId = message.id;
    let text = message.text?.body;
    if (!text) return res.sendStatus(200);

    if (processedMessages.has(msgId)) return res.sendStatus(200);
    processedMessages.add(msgId);

    text = normalizarTexto(text);
    console.log("Mensaje recibido:", text);

    if (!sessions.has(from)) {
      sessions.set(from, { history: [] });
    }

    await procesarConIA(text, from);

    res.sendStatus(200);
  } catch (error) {
    console.error("ERROR EN WEBHOOK:", error.response?.data || error.message);
    res.sendStatus(200);
  }
});

app.get("/", (req, res) => {
  res.send("Ana IA - Asesora experta de Ladrillera La Toscana");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});
