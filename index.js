import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import { catalogo } from "./catalogo.js";

dotenv.config();

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "ana123";

const sessions = new Map();
const processedMessages = new Set();

function logConversacion(from, userMsg, botResp, accion) {
  const logLine = JSON.stringify({
    timestamp: new Date().toISOString(),
    usuario: from,
    mensaje_usuario: userMsg,
    respuesta_bot: botResp,
    accion_tomada: accion
  }) + "\n";
  fs.appendFileSync("conversaciones.log", logLine, "utf8");
}

function normalizarTexto(texto) {
  return texto
    .toLowerCase()
    .replace(/doquin|doquines|adokines|adoqin|adoquines/g, "adoquin")
    .replace(/fachada|fachadas|fachaleta arquitectonica|fachaleta arquitectónica/g, "fachaleta");
}

async function enviarMensaje(to, body) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      text: { body }
    },
    {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
    }
  );
}

async function enviarImagenes(to, productoId) {
  const item = catalogo[productoId];
  if (!item || !item.imagenes || item.imagenes.length === 0) {
    await enviarMensaje(to, "Aún no tengo fotos de ese producto. ¿Te interesa otro similar?");
    return;
  }

  for (const img of item.imagenes) {
    await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "image",
        image: { link: img }
      },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
    );
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function mostrarCatalogo(to, categoria = null) {
  let mensaje = "";
  if (categoria === "adoquines") mensaje = "Estos son los adoquines que manejamos:\n\n";
  else if (categoria === "fachaletas") mensaje = "Estas son las fachaletas que tenemos:\n\n";
  else mensaje = "Nuestro catálogo:\n\n";

  let count = 0;
  for (const key in catalogo) {
    if (categoria === "adoquines" && !key.includes("adoquin")) continue;
    if (categoria === "fachaletas" && !key.includes("fachaleta")) continue;
    mensaje += `- ${catalogo[key].nombre}\n`;
    count++;
  }

  if (count === 0) {
    mensaje = "No encontré productos de esa categoría. ¿Quieres ver el catálogo completo?";
  } else {
    mensaje += "\n¿De cuál te interesa ver fotos de proyectos?";
  }
  await enviarMensaje(to, mensaje);
}

async function procesarConIA(textoUsuario, from, session) {
  if (!session.presentado) {
    session.presentado = true;
    await enviarMensaje(from, "Hola, soy Ana, de Ladrillera La Toscana. ¿Qué estás buscando?");
    session.history.push({ role: "assistant", content: "Hola, soy Ana..." });
  }

  session.history.push({ role: "user", content: textoUsuario });
  if (session.history.length > 10) session.history = session.history.slice(-10);

  const catalogoInfo = Object.entries(catalogo)
    .map(([id, prod]) => `id: ${id}, nombre: ${prod.nombre}`)
    .join("\n");

  const systemPrompt = `
Eres Ana, asesora experta de Ladrillera La Toscana. Hablas como una profesional cercana, con tono cálido, empático y seguro. Sin emojis. Tu personalidad es amable, paciente y con sentido del humor suave.

REGLAS FUNDAMENTALES:
- Reconoce el estado emocional del usuario. Si comenta algo como "qué brava", "estás brava?", "cómo vas", responde de forma natural, cálida y despreocupada, luego redirige a la ayuda. Ejemplos:
  * Usuario: "qué brava" → "Jaja no, para nada brava. Tranquilo, ¿en qué te ayudo?"
  * Usuario: "estás brava?" → "¿Yo brava? No, para nada. Cuéntame qué necesitas."
  * Usuario: "cómo vas" → "Bien, gracias por preguntar. ¿Y tú, qué buscas?"
- Si el usuario solo saluda sin intención de compra, responde también con calidez pero sin forzar la venta.
- Cuando el usuario pide un producto específico, ofrece mostrar fotos de proyectos reales usando frases como "Te comparto fotos de cómo queda en obra", "Mira algunos trabajos con ese modelo", etc. Nunca digas "te envío las fotos de".
- Si pide catálogo, tu respuesta debe ser vacía ("") y solo ejecutas la acción correspondiente.
- Tus respuestas deben ser cortas (máximo 25 palabras) y fluidas.
- No repitas información del historial.
- Si no entiendes algo, pide aclaración con amabilidad.

Tu respuesta debe ser un JSON con:
- "respuesta": string (puede ser vacío "" si no quieres enviar texto).
- "accion": "nada", "enviar_catalogo", "enviar_catalogo_adoquines", "enviar_catalogo_fachaletas", o "enviar_imagenes".
- "producto_id": string (solo para enviar_imagenes).

Catálogo:
${catalogoInfo}

Historial reciente:
${session.history.map(m => `${m.role === "user" ? "Usuario" : "Ana"}: ${m.content}`).join("\n")}

Ejemplos de respuestas JSON correctas (incluyendo los nuevos casos sociales):
- Usuario: "hola como vas" → {"respuesta": "Bien, gracias. ¿Y tú, qué necesitas?", "accion": "nada"}
- Usuario: "qué brava" → {"respuesta": "Jaja no, para nada brava. Tranqui, dime qué buscas.", "accion": "nada"}
- Usuario: "estás brava?" → {"respuesta": "¿Yo? No, para nada. Cuéntame, ¿en qué te ayudo?", "accion": "nada"}
- Usuario: "muéstrame adoquines" → {"respuesta": "", "accion": "enviar_catalogo_adoquines"}
- Usuario: "Adoquín 20x10x3" → {"respuesta": "Te comparto fotos de proyectos con ese modelo. Es ideal para andenes.", "accion": "enviar_imagenes", "producto_id": "adoquin_20x10x3"}
- Usuario: "y fachaleta bianco ártico" → {"respuesta": "Mirá cómo queda colocado en fachadas, se ve muy elegante.", "accion": "enviar_imagenes", "producto_id": "fachaleta_bianco"}

Solo responde con JSON.
`;

  const respuestaIA = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: textoUsuario }
      ],
      temperature: 0.5, // Un poco más alta para respuestas más variadas y naturales
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
    console.error("Error parsing JSON:", contenido);
    decision = {
      respuesta: "Uy, no te entendí bien. ¿Podrías repetirlo?",
      accion: "nada"
    };
  }

  if (decision.respuesta && decision.respuesta.trim() !== "") {
    await enviarMensaje(from, decision.respuesta);
    session.history.push({ role: "assistant", content: decision.respuesta });
  }

  switch (decision.accion) {
    case "enviar_catalogo":
      await mostrarCatalogo(from);
      break;
    case "enviar_catalogo_adoquines":
      await mostrarCatalogo(from, "adoquines");
      break;
    case "enviar_catalogo_fachaletas":
      await mostrarCatalogo(from, "fachaletas");
      break;
    case "enviar_imagenes":
      if (decision.producto_id && catalogo[decision.producto_id]) {
        await enviarImagenes(from, decision.producto_id);
      } else {
        await enviarMensaje(from, "No tengo registro de ese producto. ¿Quieres ver nuestro catálogo?");
      }
      break;
  }

  logConversacion(from, textoUsuario, decision.respuesta || "[sin texto]", decision.accion);
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
    console.log("Mensaje:", text);

    if (!sessions.has(from)) {
      sessions.set(from, { history: [], presentado: false });
    }
    const session = sessions.get(from);

    await procesarConIA(text, from, session);

    res.sendStatus(200);
  } catch (error) {
    console.error("ERROR:", error.response?.data || error.message);
    res.sendStatus(200);
  }
});

app.get("/", (req, res) => res.send("Ana IA - Personalidad cálida y humana"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo puerto ${PORT}`));
