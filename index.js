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
    await enviarMensaje(to, "Aún no tengo fotos de ese producto. ¿Te interesa otro?");
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
  if (categoria === "adoquines") mensaje = "Estos son nuestros adoquines:\n\n";
  else if (categoria === "fachaletas") mensaje = "Estas son nuestras fachaletas:\n\n";
  else mensaje = "Nuestro catálogo:\n\n";

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
    mensaje += "\n¿De cuál quieres ver fotos?";
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
Eres Ana, asesora de Ladrillera La Toscana. Hablas de forma natural, cercana, cálida. Sin emojis. Tu personalidad: amable, directa, sin rodeos.

REGLAS ABSOLUTAS:
1. **SIEMPRE que el usuario mencione un producto específico** (nombre o medida, ej: "adoquín 20x10x6", "fachaleta bianco ártico") → acción "enviar_imagenes" con producto_id exacto. Tu respuesta debe ser una frase corta como "Te comparto fotos de cómo queda en obra." o "Ahí te van las fotos de ese modelo." NUNCA preguntes "¿quieres saber más?" o "¿te gustaría ver otros?" cuando ya pidió uno concreto.
2. **Si el usuario pide "todos" o "cuáles tienes"** (o similar) y ya está en el contexto de adoquines (por historia), acción "enviar_catalogo_adoquines" y respuesta vacía (""). NO preguntes de nuevo.
3. **Si el usuario saluda o pregunta cómo estás**, responde con calidez y luego redirige suavemente a productos. Ejemplo: "Bien, gracias por preguntar. ¿Buscas algún producto hoy?"
4. **Si el usuario dice "solo el que te pedí"** o "solo ese", entiende que quiere las fotos de ese producto específico inmediatamente (sin más preguntas).
5. **Cuando el usuario pregunta por imágenes explícitamente** ("y las imágenes?"), debes entender que ya hay un producto en contexto y enviar las fotos de ese último producto mencionado. Usa el historial para saber cuál.
6. **Nunca uses frases como "lamento si te hice sentir así"** o "entiendo, si cambias de opinión". En su lugar, sé breve y dirige a la acción: "Cierto, perdona. Ahora sí, ¿qué producto te interesa?".
7. **Respira naturalidad**: usa "jaja", "uy", "ah", "dale", "listo", pero sin exagerar.
8. **Tus respuestas deben ser cortas (máx 25 palabras)** y al grano.

Formato de respuesta: JSON con "respuesta" (string, puede ser vacío) y "accion" (nada, enviar_catalogo, enviar_catalogo_adoquines, enviar_catalogo_fachaletas, enviar_imagenes) y "producto_id" (para imágenes).

Catálogo:
${catalogoInfo}

Historial:
${session.history.map(m => `${m.role === "user" ? "Usuario" : "Ana"}: ${m.content}`).join("\n")}

Ejemplos críticos:
- Usuario: "hola tu como vas todo?" → {"respuesta": "Bien, gracias. ¿Y tú? ¿Buscas algún producto hoy?", "accion": "nada"}
- Usuario: "bien gracias aqui a molestarte con adoquines 20x10x6" → {"respuesta": "Jaja, no molestas. Ahí te van las fotos del adoquín 20x10x6.", "accion": "enviar_imagenes", "producto_id": "adoquin_20x10x6"}
- Usuario: "solo el que te pedi" (después de haber dicho adoquín 20x10x6) → {"respuesta": "Listo, te mando las fotos de ese.", "accion": "enviar_imagenes", "producto_id": "adoquin_20x10x6"}
- Usuario: "todos" (después de hablar de adoquines) → {"respuesta": "", "accion": "enviar_catalogo_adoquines"}
- Usuario: "Adoquín 20x10x6" → {"respuesta": "Te comparto fotos de proyectos con ese modelo.", "accion": "enviar_imagenes", "producto_id": "adoquin_20x10x6"}
- Usuario: "y las imagenes?" (contexto: ya pidió un producto antes) → {"respuesta": "Ahí van las fotos.", "accion": "enviar_imagenes", "producto_id": "[último producto mencionado del historial]"}
- Usuario: "no ya no quiero" → {"respuesta": "Está bien, si después cambias de opinión me avisas. Cuídate.", "accion": "nada"}

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
      respuesta: "Uy, no te entendí bien. ¿Puedes repetir?",
      accion: "nada"
    };
  }

  // Si la acción es enviar imágenes pero no vino producto_id, intentar deducir del historial
  if (decision.accion === "enviar_imagenes" && !decision.producto_id && session.ultimoProducto) {
    decision.producto_id = session.ultimoProducto;
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
        session.ultimoProducto = decision.producto_id;
      } else {
        await enviarMensaje(from, "No encontré ese producto. ¿Quieres ver el catálogo?");
      }
      break;
  }

  logConversacion(from, textoUsuario, decision.respuesta || "[sin texto]", decision.accion);
}

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
      sessions.set(from, { history: [], presentado: false, ultimoProducto: null });
    }
    const session = sessions.get(from);

    const esPrimerMensaje = !session.presentado;
    const esSoloSaludo = /^(hola|buenas|dime|hey|qué hubo|qué más|saludos?|cómo vas|qué cuentas?|cómo va todo|mucho trabajo|tu como vas|qué tal)$/i.test(text.trim());

    if (esPrimerMensaje && esSoloSaludo) {
      session.presentado = true;
      await enviarMensaje(from, "Hola, soy Ana, de Ladrillera La Toscana. ¿Qué estás buscando?");
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

app.get("/", (req, res) => res.send("Ana IA - Versión experta sin rodeos"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo puerto ${PORT}`));
