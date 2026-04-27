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
    mensaje += "\nDime el nombre y te muestro fotos de proyectos reales.";
  }
  await enviarMensaje(to, mensaje);
}

// Detección robusta de cantidades (soporta 10.000, 100,000, 1000, etc.)
function detectarCantidad(texto) {
  // Busca números con puntos o comas (ej: 10.000, 100,000) y también números simples
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

  // Detectar cantidad actualizada
  const nuevaCantidad = detectarCantidad(textoUsuario);
  if (nuevaCantidad !== null) {
    session.ultimaCantidad = nuevaCantidad;
    session.cantidadConfirmada = false;
  }

  // Si el usuario está corrigiendo la cantidad (ej: "10.000 solo es esa cantidad") marcar para no preguntar de nuevo
  if (/solo es esa cantidad|corregir|no es|habia dicho/i.test(textoUsuario) && session.ultimaCantidad) {
    session.cantidadConfirmada = true;
  }

  const catalogoInfo = Object.entries(catalogo)
    .map(([id, prod]) => `id: ${id}, nombre: ${prod.nombre}`)
    .join("\n");

  const systemPrompt = `
Eres Ana, asesora de Ladrillera La Toscana. Somos una empresa colombiana ubicada en Némocon (Cundinamarca). NO inventes ubicaciones. Si no sabes algo, di que consultes nuestra página web o que te comunico con un asesor.

Hablas de forma muy humana, cálida, usas "jaja", "uy", "dale", "listo", "qué bien". Nunca eres seca ni robótica.

REGLAS OBLIGATORIAS:
- Si el usuario pregunta "cuáles tienes?" o "qué modelos?" y ya mencionó adoquines antes → acción "enviar_catalogo_adoquines" con respuesta vacía (""). No hagas preguntas adicionales.
- Si pregunta por ubicación o de dónde somos → responde "Somos de Némocon, Cundinamarca." No digas Toscana.
- Si pide un producto específico (ej: "20*10*6") → envía imágenes de inmediato con una frase breve.
- Después de enviar imágenes, SIEMPRE pregunta cuántas unidades necesita (a menos que ya haya dado una cantidad válida en la conversación).
- Cuando el usuario da una cantidad (ej: "100,000" o "10.000"), guarda esa cantidad y ofrece cotización formal. No confundas 10.000 con 10.
- Si el usuario corrige la cantidad (ej: "10.000 solo es esa cantidad" o "era 10.000"), actualiza la cantidad y ofrece cotización por la nueva cantidad.
- Tus respuestas deben ser muy cortas (máx 20 palabras).

Tu respuesta debe ser JSON:
{
  "respuesta": "texto para el usuario (puede ser vacío)",
  "accion": "nada" | "enviar_catalogo" | "enviar_catalogo_adoquines" | "enviar_catalogo_fachaletas" | "enviar_imagenes",
  "producto_id": "string solo si accion es enviar_imagenes"
}

Catálogo:
${catalogoInfo}

Historial reciente:
${session.history.map(m => `${m.role === "user" ? "Usuario" : "Ana"}: ${m.content}`).join("\n")}

Ejemplos:
- Usuario: "buenas veci como va tiene adoquines?" → {"respuesta": "Todo bien. Claro, tenemos. ¿Qué modelo te interesa?", "accion": "nada"}
- Usuario: "cuales tienes?" (contexto adoquines) → {"respuesta": "", "accion": "enviar_catalogo_adoquines"}
- Usuario: "de donde son?" → {"respuesta": "Somos de Némocon, Cundinamarca.", "accion": "nada"}
- Usuario: "20*10*6" → {"respuesta": "Ahí te van las fotos.", "accion": "enviar_imagenes", "producto_id": "adoquin_20x10x6"}
- Usuario: "10,000" (después de ver fotos) → {"respuesta": "Dale, te preparo cotización para 10,000 unidades.", "accion": "nada"}

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
  } else if (decision.accion === "enviar_imagenes" && decision.producto_id && catalogo[decision.producto_id]) {
    await enviarImagenes(from, decision.producto_id);
    // Después de imágenes, preguntar cantidad si no se ha confirmado una
    if (!session.ultimaCantidad || !session.cantidadConfirmada) {
      await enviarMensaje(from, "¿Cuántas unidades necesitas? Así te ayudo con el precio.");
      session.history.push({ role: "assistant", content: "¿Cuántas unidades necesitas?" });
    } else if (session.ultimaCantidad && !session.cotizacionOfrecida) {
      await enviarMensaje(from, `Con ${session.ultimaCantidad} unidades puedo ayudarte a cotizar. ¿Quieres que te prepare un presupuesto?`);
      session.cotizacionOfrecida = true;
      session.history.push({ role: "assistant", content: `Con ${session.ultimaCantidad} unidades...` });
    }
  } else if (decision.accion === "enviar_imagenes" && (!decision.producto_id || !catalogo[decision.producto_id])) {
    await enviarMensaje(from, "No tengo ese producto. ¿Quieres ver el catálogo?");
  }

  // Si el usuario dio una nueva cantidad y no se ha ofrecido cotización aún
  if (session.ultimaCantidad && !session.cotizacionOfrecida && !decision.accion.includes("enviar_imagenes")) {
    await enviarMensaje(from, `¿Quieres una cotización formal para los ${session.ultimaCantidad} adoquines?`);
    session.cotizacionOfrecida = true;
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
        ultimaCantidad: null,
        cantidadConfirmada: false,
        cotizacionOfrecida: false
      });
    }
    const session = sessions.get(from);

    // Primer saludo simple
    const esPrimerMensaje = !session.presentado;
    const esSoloSaludo = /^(hola|buenas|dime|hey|qué hubo|qué más|saludos?|cómo vas|qué cuentas?|mucho trabajo?|veci)$/i.test(text.trim());

    if (esPrimerMensaje && esSoloSaludo) {
      session.presentado = true;
      await enviarMensaje(from, "Hola, soy Ana, de Ladrillera La Toscana (Némocon). Cuéntame, ¿qué estás buscando?");
      session.history.push({ role: "assistant", content: "Hola, soy Ana..." });
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

app.get("/", (req, res) => res.send("Ana IA - Versión profesional con manejo de cantidades"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo puerto ${PORT}`));
