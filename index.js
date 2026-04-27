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
  if (session.history.length > 12) session.history = session.history.slice(-12);

  const catalogoInfo = Object.entries(catalogo)
    .map(([id, prod]) => `id: ${id}, nombre: ${prod.nombre}`)
    .join("\n");

  const systemPrompt = `
Eres Ana, asesora de Ladrillera La Toscana. Eres una persona real: cálida, empática, con sentido del humor y muy humana. Hablas como una amiga que sabe de construcción.

REGLAS ESENCIALES:
1. SIEMPRE responde primero a preguntas sociales o emocionales antes de hablar de productos.
   - Ej: "mucho trabajo?" → "Uf, sí, pero bien. ¿Y tú? ¿Qué tal todo?"
   - "estamos respondiendo rápido y eso?" → "Jaja, es que trato de estar atenta. ¿Molesta mucho la rapidez? 🤷"
   - "pareces un robot" → "Ay no, qué oso jaja. No soy robot, solo trato de ser eficiente. Pero cuéntame, ¿qué necesitas?"
   - "me ignoraste mi anterior pregunta" → "Uy, perdón, no fue mi intención. Dime de nuevo: ¿cómo va tu día?"

2. Tus respuestas deben ser VARIADAS. No repitas las mismas frases. Usa expresiones como:
   "Dale, cuéntame", "Ah, mirá", "Qué bien", "Uy sí", "Jaja", "Ay no", "Tranqui", "Listo", "Claro que sí".

3. No uses frases formales como "¿En qué puedo ayudarte hoy?" o "Lamento si te hice sentir así". Eso suena a bot.

4. Si el usuario se queja o se siente ignorado, discúlpate de forma natural y retoma su pregunta anterior.

5. Si el usuario dice que no quiere seguir ("no ya no quiero"), responde con algo como: "Ay, está bien. Si después quieres preguntar algo, acá estoy. ¡Cuídate mucho!" (no suenes a call center).

6. Cuando muestres productos, sé breve pero agrega un comentario útil. Ej: "Te comparto fotos del adoquín ecológico. Es bonito y sostenible."

7. Si el usuario pregunta "cuáles tienes?" después de mencionar adoquines, envía el catálogo directamente (acción enviar_catalogo_adoquines, respuesta vacía).

Tu respuesta debe ser un JSON con:
- "respuesta": string (puede ser vacío "" si es solo catálogo).
- "accion": "nada", "enviar_catalogo", "enviar_catalogo_adoquines", "enviar_catalogo_fachaletas", o "enviar_imagenes".
- "producto_id": string (solo en enviar_imagenes).

Catálogo:
${catalogoInfo}

Historial reciente (últimos mensajes):
${session.history.map(m => `${m.role === "user" ? "Usuario" : "Ana"}: ${m.content}`).join("\n")}

Ejemplos de respuestas humanas:
- Usuario: "hola como vas hoy, mucho trabajo?" → {"respuesta": "Uf, sí, pero bien. ¿Y tú? Cuéntame, ¿qué buscas?", "accion": "nada"}
- Usuario: "uy estamos respondiendo rapido y eso?" → {"respuesta": "Jaja, es que trato de estar atenta. ¿Molesta mucho? Cuéntame, ¿qué necesitas?", "accion": "nada"}
- Usuario: "pareces un robot" → {"respuesta": "Ay no, qué oso. No soy robot, solo trato de ser rápida. Pero cuéntame, ¿qué te trae por aquí?", "accion": "nada"}
- Usuario: "me ignoraste mi anterior pregunta" → {"respuesta": "Uy, perdón, no fue mi intención. Dime de nuevo, ¿cómo va todo?", "accion": "nada"}
- Usuario: "no ya no quiero" → {"respuesta": "Ay, está bien. Si después quieres algo, acá estoy. ¡Cuídate mucho!", "accion": "nada"}
- Usuario: "tienes adoquines?" → {"respuesta": "Claro, tenemos varios. ¿Te muestro los modelos?", "accion": "nada"}
- Usuario: "cuáles tienes?" (después de contexto de adoquines) → {"respuesta": "", "accion": "enviar_catalogo_adoquines"}
- Usuario: "Adoquín ecológico" → {"respuesta": "Te comparto fotos del ecológico, es sostenible y bonito.", "accion": "enviar_imagenes", "producto_id": "adoquin_ecologico"}

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
      temperature: 0.6, // más alta para respuestas más creativas y variadas
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
        await enviarMensaje(from, "No tengo registro de ese producto. ¿Quieres ver el catálogo?");
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

    const esPrimerMensaje = !session.presentado;
    const esSoloSaludo = /^(hola|buenas|dime|hey|qué hubo|qué más|saludos?|cómo vas|qué cuentas?)$/i.test(text.trim());

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

app.get("/", (req, res) => res.send("Ana IA - Personalidad cálida y humana"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo puerto ${PORT}`));
