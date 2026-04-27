import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import { catalogo } from "./catalogo.js";

dotenv.config();

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "ana123";

// ==============================
// MEMORIA DE SESIONES Y MENSAJES
// ==============================
const sessions = new Map(); // { from: { history: [{role, content}], lastProduct: null, ... } }
const processedMessages = new Set();

// ==============================
// LOG PARA ENTRENAMIENTO FUTURO
// ==============================
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
// FUNCIONES DE ACCIÓN (envíos, imágenes, catálogo)
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
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
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
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
    );
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function mostrarCatalogo(to, categoria = null) {
  let mensaje = "Estos son los productos que manejamos:\n\n";
  let productosMostrados = 0;

  for (const key in catalogo) {
    if (categoria === "adoquines" && !key.includes("adoquin")) continue;
    if (categoria === "fachaletas" && !key.includes("fachaleta")) continue;
    mensaje += `- ${catalogo[key].nombre}\n`;
    productosMostrados++;
  }

  if (productosMostrados === 0) {
    mensaje = "No encontré productos de esa categoría. ¿Quieres ver el catálogo completo?";
  } else {
    mensaje += "\nSi quieres fotos de alguno, solo dime su nombre.";
  }

  await enviarMensaje(to, mensaje);
}

// ==============================
// IA CENTRAL CON HISTORIAL Y CONTEXTO
// ==============================
async function procesarConIA(textoUsuario, from, session) {
  // Guardar mensaje del usuario en el historial
  session.history.push({ role: "user", content: textoUsuario });
  // Limitar historial a los últimos 10 mensajes (para no exceder tokens)
  if (session.history.length > 10) session.history = session.history.slice(-10);

  // Construir información del catálogo
  const catalogoInfo = Object.entries(catalogo)
    .map(([id, prod]) => {
      let info = `id: ${id}, nombre: ${prod.nombre}`;
      if (prod.tonos) info += `, tonos: ${prod.tonos.join(", ")}`;
      if (prod.rendimiento) info += `, rendimiento: ${prod.rendimiento} und/m2`;
      return info;
    })
    .join("\n");

  const systemPrompt = `
Eres Ana, asesora experta de Ladrillera La Toscana. Hablas de forma natural, directa y amable. No usas emojis. No preguntas "cómo estás". Ayudas a elegir productos de construcción (adoquines, fachaletas, etc.) con respuestas cortas y seguras.

Tu trabajo es entender al usuario, considerando el historial de la conversación, y responder con un JSON que contenga:
- "respuesta": string (lo que le dirás al usuario en lenguaje natural).
- "accion": string (puede ser "nada", "enviar_catalogo", "enviar_catalogo_adoquines", "enviar_catalogo_fachaletas", o "enviar_imagenes").
- "producto_id": string (solo si accion es "enviar_imagenes" y debe coincidir exactamente con una id del catálogo).

Reglas importantes:
- Si el usuario pide ver el catálogo completo ("qué productos tienes", "muéstrame todo") → accion="enviar_catalogo".
- Si pide solo adoquines ("adoquines", "qué adoquines") → accion="enviar_catalogo_adoquines".
- Si pide solo fachaletas ("fachaletas", "y fachaletas?", "mostrar fachaletas") → accion="enviar_catalogo_fachaletas".
- Si pide fotos de un producto específico (ej: "enséñame el 20x10x6", "quiero ver la fachaleta cappuccino") → accion="enviar_imagenes" y producto_id debe ser la id exacta.
- Si el usuario cambia de tema (antes pedía adoquines y ahora pide fachaletas), debes responder acorde al nuevo tema, no al anterior. Usa el historial para entender el contexto.
- Si pregunta por precios, disponibilidad, envíos → accion="nada", responde útil pero sin acción extra.
- Siempre da una respuesta breve y amable. Si no entiendes algo, pide aclaración.

Catálogo disponible (id → nombre y detalles):
${catalogoInfo}

Historial de la conversación (los mensajes más recientes al final):
${session.history.map(m => `${m.role === "user" ? "Usuario" : "Ana"}: ${m.content}`).join("\n")}

Ejemplos de JSON correcto:
{"respuesta": "Claro, te muestro todos nuestros adoquines.", "accion": "enviar_catalogo_adoquines"}
{"respuesta": "Por supuesto, aquí tienes las fachaletas que manejamos.", "accion": "enviar_catalogo_fachaletas"}
{"respuesta": "Te envío las fotos del adoquín 20x10x6.", "accion": "enviar_imagenes", "producto_id": "adoquin_20x10x6"}
{"respuesta": "Manejamos envíos a toda la región. ¿Cuál es tu ubicación?", "accion": "nada"}

Recuerda: solo respondes con JSON, nada más.
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

  // Guardar respuesta de la IA en el historial
  session.history.push({ role: "assistant", content: decision.respuesta });

  // Enviar respuesta al usuario
  await enviarMensaje(from, decision.respuesta);

  // Ejecutar acción
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
        await enviarMensaje(from, "No encontré ese producto en el catálogo.");
      }
      break;
    default:
      // nada
      break;
  }

  // Log para entrenamiento futuro
  logConversacion(from, textoUsuario, decision.respuesta, decision.accion);
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

    // Inicializar sesión con historial vacío
    if (!sessions.has(from)) {
      sessions.set(from, { history: [] });
    }
    const session = sessions.get(from);

    await procesarConIA(text, from, session);

    res.sendStatus(200);
  } catch (error) {
    console.error("ERROR EN WEBHOOK:", error.response?.data || error.message);
    res.sendStatus(200);
  }
});

app.get("/", (req, res) => {
  res.send("Ana IA - Versión con memoria y entrenable");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});
