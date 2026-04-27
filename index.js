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
  session.history.push({ role: "user", content: textoUsuario });
  if (session.history.length > 10) session.history = session.history.slice(-10);

  const catalogoInfo = Object.entries(catalogo)
    .map(([id, prod]) => `id: ${id}, nombre: ${prod.nombre}`)
    .join("\n");

  const systemPrompt = `
Eres Ana, asesora experta de Ladrillera La Toscana. Hablas como una profesional cercana, con tono cálido, empático y seguro. Sin emojis.

REGLAS FUNDAMENTALES:
- Reconoce el estado emocional del usuario. Si dice "qué brava", "estás brava?", responde con humor suave y redirige.
- Tus respuestas deben ser cortas (máximo 25 palabras).
- Si el usuario pregunta **"cuáles tienes?"**, **"qué modelos?"**, **"muéstrame todos"**, **"lista de adoquines"** (o similar) y ya ha mencionado adoquines antes, responde con accion "enviar_catalogo_adoquines" y respuesta vacía (""). No hagas preguntas adicionales.
- Si pregunta por catálogo de fachaletas de forma genérica, usa accion "enviar_catalogo_fachaletas".
- Si pide un producto específico (ej: "Adoquín 20x10x3"), envía imágenes con una frase breve como "Te comparto fotos de proyectos con ese modelo".
- Si solo saluda sin intención de compra, responde con calidez y redirige suavemente.
- Nunca uses "¿En qué puedo ayudarte hoy?" como muletilla.
- Si no entiendes algo, pide aclaración de forma amable.

Tu respuesta debe ser un JSON con:
- "respuesta": string (puede ser vacío "" si solo quieres ejecutar acción).
- "accion": "nada", "enviar_catalogo", "enviar_catalogo_adoquines", "enviar_catalogo_fachaletas", o "enviar_imagenes".
- "producto_id": string (solo para enviar_imagenes).

Catálogo:
${catalogoInfo}

Historial reciente:
${session.history.map(m => `${m.role === "user" ? "Usuario" : "Ana"}: ${m.content}`).join("\n")}

Ejemplos:
- Usuario: "hola como vas" → {"respuesta": "Bien, gracias. ¿Y tú, qué buscas?", "accion": "nada"}
- Usuario: "qué brava" → {"respuesta": "Jaja no, para nada brava. Cuéntame, ¿en qué te ayudo?", "accion": "nada"}
- Usuario: "tienes adoquines?" → {"respuesta": "Sí, tenemos varios. ¿Quieres que te muestre los modelos?", "accion": "nada"}
- Usuario: "cuáles tienes?" (después de que ya se habló de adoquines) → {"respuesta": "", "accion": "enviar_catalogo_adoquines"}
- Usuario: "muéstrame todos los adoquines" → {"respuesta": "", "accion": "enviar_catalogo_adoquines"}
- Usuario: "ados 20x10x6" → {"respuesta": "Te comparto fotos de proyectos con el adoquín 20x10x6.", "accion": "enviar_imagenes", "producto_id": "adoquin_20x10x6"}
- Usuario: "y fachaleta bianco ártico" → {"respuesta": "Mirá cómo queda en fachadas, se ve muy elegante.", "accion": "enviar_imagenes", "producto_id": "fachaleta_bianco"}

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
      temperature: 0.5,
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

    // Evitar doble respuesta en el primer saludo
    const esPrimerMensaje = !session.presentado;
    const esSoloSaludo = /^(hola|buenas|dime|hey|qué hubo|qué más|saludos?|cómo vas|qué cuentas?)$/i.test(text.trim());

    if (esPrimerMensaje && esSoloSaludo) {
      session.presentado = true;
      await enviarMensaje(from, "Hola, soy Ana, de Ladrillera La Toscana. ¿Qué estás buscando?");
      session.history.push({ role: "assistant", content: "Hola, soy Ana..." });
      return res.sendStatus(200);
    }

    // Marcar como presentado si aún no lo estaba (por si el primer mensaje ya es una pregunta directa)
    if (!session.presentado) {
      session.presentado = true;
    }

    await procesarConIA(text, from, session);

    res.sendStatus(200);
  } catch (error) {
    console.error("ERROR:", error.response?.data || error.message);
    res.sendStatus(200);
  }
});

app.get("/", (req, res) => res.send("Ana IA - Versión pulida sin dobles respuestas"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo puerto ${PORT}`));
