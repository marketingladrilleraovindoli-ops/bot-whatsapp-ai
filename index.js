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

// Función para detectar cantidades en el mensaje
function detectarCantidad(texto) {
  const match = texto.match(/\b(\d+)\s*(?:cientos|mil|unidades|adoquines|piezas)?\b/i);
  if (match) return parseInt(match[1]);
  return null;
}

async function procesarConIA(textoUsuario, from, session) {
  session.history.push({ role: "user", content: textoUsuario });
  if (session.history.length > 12) session.history = session.history.slice(-12);

  // Detectar cantidad para usarla después
  const cantidadDetectada = detectarCantidad(textoUsuario);
  if (cantidadDetectada) {
    session.ultimaCantidad = cantidadDetectada;
  }

  const catalogoInfo = Object.entries(catalogo)
    .map(([id, prod]) => `id: ${id}, nombre: ${prod.nombre}`)
    .join("\n");

  const systemPrompt = `
Eres Ana, asesora experta y amable de Ladrillera La Toscana. Hablas como una persona real, cálida, colombiana neutra. Usas "jaja", "uy", "qué bien", "dale", "listo". Nunca eres seca ni robótica.

REGLAS OBLIGATORIAS:
- Siempre responde preguntas personales (ej: "mucho trabajo?", "cómo vas?") con calidez y luego redirige suavemente a los productos.
- Si el usuario pide UN PRODUCTO ESPECÍFICO (ej: "adoquín 20x10x6", "quiero ver ese de 20x10x3"), tu acción debe ser "enviar_imagenes" con el producto_id correspondiente. No preguntes "¿Te gustaría saber más?" ni nada. Directo: una frase breve + acción.
- Si el usuario dice "solo el que te pedí" o "solo ese", también debes enviar imágenes de inmediato.
- Si el usuario pregunta "cuáles tienes?" o "qué modelos tienes?" y ya hay contexto de adoquines, envía catálogo de adoquines con respuesta vacía ("").
- Si después de enviar imágenes el usuario no ha dicho cantidad, pregúntale cuántas unidades o metros cuadrados necesita para darle un presupuesto.
- Si el usuario ya mencionó una cantidad (ej: "1000 adoquines"), después de mostrar imágenes pregúntale si quiere una cotización formal.
- Nunca repitas la lista de productos si ya la enviaste antes en la conversación.
- Tus respuestas deben ser cortas (máx 25 palabras) y muy naturales.

Tu respuesta debe ser JSON:
{
  "respuesta": "texto para el usuario (puede ser vacío si solo quieres acción)",
  "accion": "nada" | "enviar_catalogo" | "enviar_catalogo_adoquines" | "enviar_catalogo_fachaletas" | "enviar_imagenes",
  "producto_id": "string solo si accion es enviar_imagenes"
}

Catálogo:
${catalogoInfo}

Historial reciente:
${session.history.map(m => `${m.role === "user" ? "Usuario" : "Ana"}: ${m.content}`).join("\n")}

Ejemplos:
- Usuario: "hola tu como va todo mucho trabajo?" → {"respuesta": "Uf, sí, pero bien. ¿Y tú? ¿Qué andas buscando?", "accion": "nada"}
- Usuario: "bien gracias aqui a molestarte con adoquines 20x10x6" → {"respuesta": "Jaja no molestas. Te muestro fotos de ese modelo.", "accion": "enviar_imagenes", "producto_id": "adoquin_20x10x6"}
- Usuario: "solo el que te pedi" (después de haber pedido un producto) → {"respuesta": "Ahí te van las fotos.", "accion": "enviar_imagenes", "producto_id": "adoquin_20x10x6"}
- Usuario: "cuales tienes?" (con contexto de adoquines) → {"respuesta": "", "accion": "enviar_catalogo_adoquines"}
- Usuario: "quiero ver ese de 20*10*3" → {"respuesta": "Dale, te comparto fotos del 20x10x3.", "accion": "enviar_imagenes", "producto_id": "adoquin_20x10x3"}

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
      temperature: 0.6,
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
  let accionRealizada = false;
  if (decision.accion === "enviar_catalogo") {
    await mostrarCatalogo(from);
    accionRealizada = true;
  } else if (decision.accion === "enviar_catalogo_adoquines") {
    await mostrarCatalogo(from, "adoquines");
    accionRealizada = true;
  } else if (decision.accion === "enviar_catalogo_fachaletas") {
    await mostrarCatalogo(from, "fachaletas");
    accionRealizada = true;
  } else if (decision.accion === "enviar_imagenes" && decision.producto_id && catalogo[decision.producto_id]) {
    await enviarImagenes(from, decision.producto_id);
    accionRealizada = true;
    // Después de enviar imágenes, si el usuario ya mencionó cantidad, preguntar por cotización
    if (session.ultimaCantidad) {
      await enviarMensaje(from, `Con ${session.ultimaCantidad} unidades te puedo ayudar a cotizar. ¿Quieres que te prepare un presupuesto?`);
      session.history.push({ role: "assistant", content: `Con ${session.ultimaCantidad} unidades...` });
    } else if (!session.preguntadoCantidad) {
      session.preguntadoCantidad = true;
      await enviarMensaje(from, "¿Cuántas unidades o metros cuadrados necesitas? Así te ayudo con el precio.");
      session.history.push({ role: "assistant", content: "¿Cuántas unidades o metros cuadrados necesitas?" });
    }
  } else if (decision.accion === "enviar_imagenes" && (!decision.producto_id || !catalogo[decision.producto_id])) {
    await enviarMensaje(from, "No tengo ese producto. ¿Quieres ver el catálogo?");
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
      sessions.set(from, { history: [], presentado: false, ultimaCantidad: null, preguntadoCantidad: false });
    }
    const session = sessions.get(from);

    // Primer saludo sin pedir producto: solo presentación y fin
    const esPrimerMensaje = !session.presentado;
    const esSoloSaludo = /^(hola|buenas|dime|hey|qué hubo|qué más|saludos?|cómo vas|qué cuentas?|mucho trabajo?)$/i.test(text.trim());

    if (esPrimerMensaje && esSoloSaludo) {
      session.presentado = true;
      await enviarMensaje(from, "Hola, soy Ana, de Ladrillera La Toscana. Cuéntame, ¿qué estás buscando?");
      session.history.push({ role: "assistant", content: "Hola, soy Ana..." });
      return res.sendStatus(200);
    }

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

app.get("/", (req, res) => res.send("Ana IA - Cálida, sin dobles, con cotizaciones"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo puerto ${PORT}`));
