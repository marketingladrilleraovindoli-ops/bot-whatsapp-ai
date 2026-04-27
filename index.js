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

// Envía solo las imágenes, sin texto adicional (el texto ya lo envió la IA)
async function enviarImagenes(to, productoId) {
  const item = catalogo[productoId];
  if (!item || !item.imagenes || item.imagenes.length === 0) {
    await enviarMensaje(to, "Ay, aún no tengo fotos de eso. ¿Te muestro otro?");
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
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Muestra catálogo de forma limpia, con un solo mensaje
async function mostrarCatalogo(to, categoria = null) {
  let mensaje = "";
  if (categoria === "adoquines") mensaje = "Estos son los adoquines que manejamos:\n\n";
  else if (categoria === "fachaletas") mensaje = "Estas son las fachaletas que tenemos:\n\n";
  else mensaje = "Mirá, esto es lo que manejamos:\n\n";

  let count = 0;
  for (const key in catalogo) {
    if (categoria === "adoquines" && !key.includes("adoquin")) continue;
    if (categoria === "fachaletas" && !key.includes("fachaleta")) continue;
    mensaje += `- ${catalogo[key].nombre}\n`;
    count++;
  }

  if (count === 0) {
    mensaje = "No encontré productos de esa categoría. ¿Quieres ver todo el catálogo?";
  } else {
    mensaje += "\nDime cuál querés ver y te mando las fotos.";
  }
  await enviarMensaje(to, mensaje);
}

async function procesarConIA(textoUsuario, from, session) {
  // Presentación solo una vez
  if (!session.presentado) {
    session.presentado = true;
    await enviarMensaje(from, "Hola, soy Ana, de Ladrillera La Toscana. ¿En qué te ayudo?");
    session.history.push({ role: "assistant", content: "Hola, soy Ana..." });
  }

  session.history.push({ role: "user", content: textoUsuario });
  if (session.history.length > 10) session.history = session.history.slice(-10);

  const catalogoInfo = Object.entries(catalogo)
    .map(([id, prod]) => `id: ${id}, nombre: ${prod.nombre}`)
    .join("\n");

  const systemPrompt = `
Eres Ana, asesora de Ladrillera La Toscana. Hablas como una persona REAL, colombiana normal. Usas lenguaje cotidiano, cercano, sin emojis.

REGLAS CLAVE:
- Tus respuestas deben ser MUY CORTAS, de máximo 20 palabras. Nada de frases largas.
- Nunca repitas información que ya está en el historial.
- Si el usuario pide un producto específico (ej: "adoquines 20x10x6"), tu respuesta debe ser solo algo como: "Ahí te mando las fotos. Es perfecto para calles." (muy breve).
- Si pide el catálogo, tu respuesta debe ser vacía (""). Solo ejecutas la acción correspondiente.
- Usa frases como: "dale", "listo", "mirá", "ahí te las mando", "claro", "sí, tenemos esos".
- No uses estructuras rígidas. Sé natural.

Tu respuesta debe ser un JSON con:
- "respuesta": string (texto que enviarás al usuario, puede ser vacío "" si no quieres enviar nada).
- "accion": "nada", "enviar_catalogo", "enviar_catalogo_adoquines", "enviar_catalogo_fachaletas", o "enviar_imagenes".
- "producto_id": string (solo si accion es "enviar_imagenes").

Catálogo:
${catalogoInfo}

Historial reciente:
${session.history.map(m => `${m.role === "user" ? "Usuario" : "Ana"}: ${m.content}`).join("\n")}

Ejemplos:
- Usuario: "buenos días, tienen adoquines?" → {"respuesta": "Sí, tenemos varios. ¿Buscas alguno en especial?", "accion": "nada"}
- Usuario: "muéstrame cuales tienes" → {"respuesta": "", "accion": "enviar_catalogo_adoquines"}
- Usuario: "Adoquín 20x10x3" → {"respuesta": "Ahí te mando las fotos. Es ideal para andenes.", "accion": "enviar_imagenes", "producto_id": "adoquin_20x10x3"}
- Usuario: "y fachaleta arquitectonica?" → {"respuesta": "", "accion": "enviar_catalogo_fachaletas"}
- Usuario: "Fachaleta Bianco Ártico" → {"respuesta": "Linda elección, ahí te van las fotos.", "accion": "enviar_imagenes", "producto_id": "fachaleta_bianco"}

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
      temperature: 0.4,
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
      respuesta: "Uy, no te entendí bien, ¿puedes repetirlo?",
      accion: "nada"
    };
  }

  // Enviar respuesta textual solo si no está vacía
  if (decision.respuesta && decision.respuesta.trim() !== "") {
    await enviarMensaje(from, decision.respuesta);
    session.history.push({ role: "assistant", content: decision.respuesta });
  }

  // Ejecutar acción (sin enviar texto adicional)
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
        await enviarMensaje(from, "Ese producto no lo tengo. ¿Quieres ver el catálogo?");
      }
      break;
  }

  logConversacion(from, textoUsuario, decision.respuesta || "[sin texto]", decision.accion);
}

// Webhooks
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

app.get("/", (req, res) => res.send("Ana IA - Personalidad Real y sin duplicados"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo puerto ${PORT}`));
