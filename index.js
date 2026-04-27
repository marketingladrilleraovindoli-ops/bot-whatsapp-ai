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
    await enviarMensaje(to, "Ay, aún no tengo fotos de eso 😅. Pero te puedo mostrar otras opciones.");
    return;
  }

  // Frases naturales al enviar fotos (variadas)
  const frasesEnvio = [
    `Ahí te mando las fotos de ${item.nombre}:`,
    `Mirá, así se ve ${item.nombre}:`,
    `Toma, ${item.nombre}:`,
    `Justo ahora te muestro ${item.nombre}:`
  ];
  const frase = frasesEnvio[Math.floor(Math.random() * frasesEnvio.length)];
  await enviarMensaje(to, frase);

  // Recomendación humana (opcional, a veces va aparte, a veces no)
  let recomendacion = "";
  if (productoId.includes("adoquin")) {
    if (productoId.includes("20x10x3")) recomendacion = "Este es ideales para andenes o zonas peatonales.";
    else if (productoId.includes("20x10x4")) recomendacion = "Muy usado para entradas de carros livianos, aguanta bien.";
    else if (productoId.includes("20x10x6")) recomendacion = "Perfecto para calles residenciales o parqueaderos, es el más pedido.";
    else if (productoId.includes("20x10x8")) recomendacion = "Ese es pa' tráfico pesado o zonas industriales, re resistente.";
    else if (productoId.includes("ecologico")) recomendacion = "El ecológico filtra agua y es bien resistente, buena opción.";
    else recomendacion = "Ese tiene buena durabilidad, te va a servir.";
  } else if (productoId.includes("fachaleta")) {
    recomendacion = "Quedan muy bonitas en fachadas, dan un toque rústico y elegante.";
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
  let mensaje = "Mirá, esto es lo que manejamos:\n\n";
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
  // Primera interacción: presentación natural
  if (!session.presentado) {
    session.presentado = true;
    await enviarMensaje(from, "Hola, soy Ana, de Ladrillera La Toscana. ¿En qué te ayudo?");
    // No procesamos el mensaje actual como IA, solo lo guardamos como historial para contexto
    session.history.push({ role: "assistant", content: "Hola, soy Ana, de Ladrillera La Toscana. ¿En qué te ayudo?" });
  }

  session.history.push({ role: "user", content: textoUsuario });
  if (session.history.length > 10) session.history = session.history.slice(-10);

  const catalogoInfo = Object.entries(catalogo)
    .map(([id, prod]) => `id: ${id}, nombre: ${prod.nombre}`)
    .join("\n");

  const systemPrompt = `
Eres Ana, asesora de Ladrillera La Toscana. Hablas como una persona REAL, colombiana (pero no marcada). Usas lenguaje natural, cotidiano, cercano.

REGLAS DE PERSONALIDAD (obligatorias):
- Usa contracciones: "pa'", "pal", "mira", "dale", "listo", "ah", "bueno", "claro", "cómo vas", "sabes qué".
- Evita estructuras repetitivas como "Te envío las fotos de..." → mejor "Ahí te mando...", "Mirá...", "Toma...".
- Las recomendaciones deben ir en la misma frase o en un mensaje aparte pero muy corto.
- Saluda variado: "Hola", "Buenas", "Dime", "¿Qué tal?".
- Si te preguntan por algo que no tienes, ofrece alternativas de forma amable (no digas "lo siento no manejamos").
- Cuando muestres fotos, añade algo como "Ahí te las mando...", "Son estas...".
- No uses nunca: "¿En qué puedo ayudarte hoy?" (suena a bot).
- Sé breve pero cálida. Si el usuario solo saluda, responde "Hola, ¿qué necesitas?".
- Aprovecha el historial para no repetir preguntas.

Tu respuesta debe ser un JSON con: "respuesta" (texto para el usuario), "accion" (puede ser "nada", "enviar_catalogo", "enviar_catalogo_adoquines", "enviar_catalogo_fachaletas", o "enviar_imagenes"), "producto_id" (solo para enviar_imagenes, debe coincidir con id del catálogo).

Catálogo:
${catalogoInfo}

Historial reciente:
${session.history.map(m => `${m.role === "user" ? "Usuario" : "Ana"}: ${m.content}`).join("\n")}

Ejemplos (respira naturalidad):
- Usuario: "hola" → {"respuesta": "Hola, dime qué necesitas.", "accion": "nada"}
- Usuario: "adoquines 20x10x6" → {"respuesta": "Ahí te mando las fotos del adoquín 20x10x6, es perfecto para calles residenciales.", "accion": "enviar_imagenes", "producto_id": "adoquin_20x10x6"}
- Usuario: "fachaleta arquitectonica" → {"respuesta": "Claro, mira las fachaletas que tenemos.", "accion": "enviar_catalogo_fachaletas"}
- Usuario: "y precios?" → {"respuesta": "Déjame revisar los precios y te confirmo en un momento. ¿Cuántos metros cuadrados necesitas?", "accion": "nada"}

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

  session.history.push({ role: "assistant", content: decision.respuesta });

  await enviarMensaje(from, decision.respuesta);

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
        await enviarMensaje(from, "Ese producto no lo tengo en mi lista. ¿Quieres ver el catálogo?");
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

app.get("/", (req, res) => res.send("Ana IA - Personalidad Real"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo puerto ${PORT}`));
