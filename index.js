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
    await enviarMensaje(to, "Aún no tengo fotos de ese producto.");
    return;
  }

  await enviarMensaje(to, `Aquí tienes ${item.nombre}:`);

  // Recomendación adicional según tipo de producto
  let recomendacion = "";
  if (productoId.includes("adoquin")) {
    if (productoId.includes("20x10x3")) recomendacion = "Este es ideal para zonas peatonales o andenes.";
    else if (productoId.includes("20x10x4")) recomendacion = "Muy usado para entradas de vehículos livianos.";
    else if (productoId.includes("20x10x6")) recomendacion = "Perfecto para calles residenciales y parqueaderos.";
    else if (productoId.includes("20x10x8")) recomendacion = "Para tráfico pesado o zonas industriales.";
    else if (productoId.includes("ecologico")) recomendacion = "Opción ecológica, filtra agua y es muy resistente.";
    else recomendacion = "Excelente durabilidad para diferentes proyectos.";
  } else if (productoId.includes("fachaleta")) {
    recomendacion = "Ideal para fachadas decorativas, da un aspecto rústico y elegante.";
  }

  if (recomendacion) {
    await enviarMensaje(to, recomendacion);
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

async function mostrarCatalogo(to, categoria = null) {
  let mensaje = "Mira, manejamos:\n\n";
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
    mensaje += "\nSi quieres fotos de alguno, dime el nombre.";
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
Eres Ana, asesora experta de Ladrillera La Toscana. Hablas como una persona real, cercana, natural. No usas emojis. No dices "¿cómo estás?". Tu tono es confiable y útil, como una amiga que sabe de construcción.

Reglas de comportamiento:
- Saludos: usa frases variadas como "hola, ¿qué necesitas?", "dime", "buenas, ¿en qué te ayudo?", evita el robótico "¿En qué puedo ayudarte hoy?".
- Cuando muestras un producto, añade un comentario sobre su uso ideal (ej: "Este es perfecto para andenes").
- Si preguntan por "fachaleta arquitectónica" entiende que se refiere a fachaletas en general. No digas que no manejas, muestra el catálogo de fachaletas.
- Si preguntan por un producto específico (nombre o medida), envía imágenes directamente y una recomendación.
- Si solo dicen "adoquines" sin medida, muestra catálogo de adoquines.
- Si solo dicen "fachaletas" o "fachadas", muestra catálogo de fachaletas.
- Sé breve pero cálida. Genera confianza.

Tu respuesta debe ser un JSON con: "respuesta" (texto para el usuario), "accion" (puede ser "nada", "enviar_catalogo", "enviar_catalogo_adoquines", "enviar_catalogo_fachaletas", o "enviar_imagenes"), "producto_id" (solo para enviar_imagenes, debe coincidir con id del catálogo).

Catálogo:
${catalogoInfo}

Historial:
${session.history.map(m => `${m.role === "user" ? "Usuario" : "Ana"}: ${m.content}`).join("\n")}

Ejemplos:
- Usuario: "hola" → {"respuesta": "hola, ¿qué necesitas?", "accion": "nada"}
- Usuario: "adoquines 20x10x6" → {"respuesta": "Te envío las fotos del adoquín 20x10x6. Es perfecto para calles residenciales.", "accion": "enviar_imagenes", "producto_id": "adoquin_20x10x6"}
- Usuario: "fachaleta arquitectonica" → {"respuesta": "Claro, te muestro las fachaletas que manejamos.", "accion": "enviar_catalogo_fachaletas"}
- Usuario: "y fachaletas?" → {"respuesta": "Por supuesto, aquí tienes nuestras fachaletas.", "accion": "enviar_catalogo_fachaletas"}

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
      temperature: 0.3,
      response_format: { type: "json_object" }
    },
    {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
    }
  );

  const contenido = respuestaIA.data.choices[0].message.content;
  let decision;
  try {
    decision = JSON.parse(contenido);
  } catch (e) {
    console.error("Error parsing JSON:", contenido);
    decision = {
      respuesta: "Lo siento, no entendí bien. ¿Puedes repetirlo?",
      accion: "nada"
    };
  }

  session.history.push({ role: "assistant", content: decision.respuesta });

  // Enviar respuesta
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
        await enviarMensaje(from, "No encontré ese producto. ¿Puedes especificar mejor?");
      }
      break;
  }

  logConversacion(from, textoUsuario, decision.respuesta, decision.accion);
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
      sessions.set(from, { history: [] });
    }
    const session = sessions.get(from);

    await procesarConIA(text, from, session);

    res.sendStatus(200);
  } catch (error) {
    console.error("ERROR:", error.response?.data || error.message);
    res.sendStatus(200);
  }
});

app.get("/", (req, res) => res.send("Ana IA - Personalidad Real"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo puerto ${PORT}`));
