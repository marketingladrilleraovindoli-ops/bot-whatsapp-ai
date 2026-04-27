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
    .replace(/fachada|fachadas|fachaleta arquitectonica|fachaleta arquitectónica/g, "fachaleta")
    .replace(/vuenas|buenas/g, "buenas")
    .replace(/komo estas|como estas/g, "como estas");
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
    return false;
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
  return true;
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
    mensaje += "\nDime el nombre y te muestro fotos de proyectos reales.";
  }
  await enviarMensaje(to, mensaje);
}

function detectarCantidad(texto) {
  // Maneja números como 100, 1000, 10.000, 100,000
  const match = texto.match(/(\d{1,3}(?:[.,]\d{3})*(?:\.\d+)?)/);
  if (match) {
    let numStr = match[1].replace(/\./g, '').replace(',', '');
    const numero = parseInt(numStr, 10);
    if (!isNaN(numero) && numero > 0) return numero;
  }
  return null;
}

async function procesarConIA(textoUsuario, from, session) {
  session.history.push({ role: "user", content: textoUsuario });
  if (session.history.length > 12) session.history = session.history.slice(-12);

  const nuevaCantidad = detectarCantidad(textoUsuario);
  if (nuevaCantidad !== null) {
    session.ultimaCantidad = nuevaCantidad;
  }

  const catalogoInfo = Object.entries(catalogo)
    .map(([id, prod]) => `id: ${id}, nombre: ${prod.nombre}`)
    .join("\n");

  const systemPrompt = `
Eres Ana, asesora de Ladrillera La Toscana. Somos de Némocon, Cundinamarca (Colombia). No inventes información.

Hablas de forma muy humana, cálida, usas "jaja", "uy", "dale", "listo", "qué bien". Tus respuestas son MUY CORTAS (máximo 15 palabras). Nunca envías más de un mensaje por turno.

REGLAS OBLIGATORIAS:
- Si el usuario pide un producto ESPECÍFICO (ej: "adoquines ecológicos", "20x10x6", "fachaleta cappuccino") → acción "enviar_imagenes" inmediatamente, sin preguntar nada más.
- Si pregunta "cuáles tienes?" o "qué modelos?" y ya hay contexto de adoquines → acción "enviar_catalogo_adoquines" con respuesta vacía.
- Si pregunta sobre ubicación → responde "Somos de Némocon, Cundinamarca."
- Después de enviar imágenes, pregunta: "¿Cuántas unidades necesitas?"
- Cuando el usuario da una cantidad, responde con un solo mensaje ofreciendo cotización: "Listo, te preparo cotización para X unidades. ¿Quieres que te la envíe?"
- SIEMPRE un solo mensaje por interacción. No dividas la respuesta en varios mensajes.
- Si el usuario dice "si" a la cotización, responde: "En un momento te la envío."

Tu respuesta debe ser JSON:
{
  "respuesta": "texto (puede ser vacío si solo quieres acción)",
  "accion": "nada" | "enviar_catalogo" | "enviar_catalogo_adoquines" | "enviar_catalogo_fachaletas" | "enviar_imagenes",
  "producto_id": "string solo si accion es enviar_imagenes"
}

Catálogo:
${catalogoInfo}

Historial:
${session.history.map(m => `${m.role === "user" ? "Usuario" : "Ana"}: ${m.content}`).join("\n")}

Ejemplos:
- Usuario: "venden adoquines ecologicos para barranquilla?" → {"respuesta": "Sí, te comparto fotos.", "accion": "enviar_imagenes", "producto_id": "adoquin_ecologico"}
- Usuario: "quiero 100" → {"respuesta": "Listo, te preparo cotización para 100 unidades. ¿Quieres que te la envíe?", "accion": "nada"}
- Usuario: "si" (cuando se le ofrece cotización) → {"respuesta": "En un momento te la envío.", "accion": "nada"}

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
      respuesta: "Uy, no te entendí bien. ¿Puedes repetirlo?",
      accion: "nada"
    };
  }

  if (decision.respuesta && decision.respuesta.trim() !== "") {
    await enviarMensaje(from, decision.respuesta);
    session.history.push({ role: "assistant", content: decision.respuesta });
  }

  // Ejecutar acción
  if (decision.accion === "enviar_catalogo") {
    await mostrarCatalogo(from);
  } else if (decision.accion === "enviar_catalogo_adoquines") {
    await mostrarCatalogo(from, "adoquines");
  } else if (decision.accion === "enviar_catalogo_fachaletas") {
    await mostrarCatalogo(from, "fachaletas");
  } else if (decision.accion === "enviar_imagenes") {
    if (decision.producto_id && catalogo[decision.producto_id]) {
      await enviarImagenes(from, decision.producto_id);
      // Preguntar cantidad después de enviar imágenes (solo si no se acaba de dar una cantidad)
      if (!session.ultimaCantidad) {
        await enviarMensaje(from, "¿Cuántas unidades necesitas?");
        session.history.push({ role: "assistant", content: "¿Cuántas unidades necesitas?" });
      }
    } else {
      await enviarMensaje(from, "No reconozco ese producto. ¿Quieres ver el catálogo?");
    }
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
      sessions.set(from, {
        history: [],
        presentado: false,
        ultimaCantidad: null
      });
    }
    const session = sessions.get(from);

    const esPrimerMensaje = !session.presentado;
    const esSoloSaludo = /^(hola|buenas|vuenas|dime|hey|qué hubo|qué más|saludos?|cómo vas|qué cuentas?|mucho trabajo?|veci|komo estas)$/i.test(text.trim());

    if (esPrimerMensaje && esSoloSaludo) {
      session.presentado = true;
      await enviarMensaje(from, "¡Hola! Soy Ana, de Ladrillera La Toscana (Némocon). ¿Qué estás buscando?");
      session.history.push({ role: "assistant", content: "¡Hola! Soy Ana..." });
      return res.sendStatus(200);
    }

    if (!session.presentado) session.presentado = true;

    await procesarConIA(text, from, session);

    res.sendStatus(200);
  } catch (error) {
    console.error("ERROR:", error.response?.data || error.message);
    res.sendStatus(200);
  }
});

app.get("/", (req, res) => res.send("Ana IA - Versión limpia sin duplicados"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo puerto ${PORT}`));
