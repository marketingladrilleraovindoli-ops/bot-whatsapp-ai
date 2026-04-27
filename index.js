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

// Datos fijos de la empresa
const UBICACION = {
  direccion: "Cra 4 #9-12, Barrio El Centro, Némocon, Cundinamarca",
  mapsLink: "https://maps.app.goo.gl/anyRAWvMrwqM2jnH7",
  web: "https://ladrilleralatoscana.com/"
};

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
    .replace(/\*/g, "x");
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
    await enviarMensaje(to, "Ay, aún no tengo fotos de ese producto. ¿Te muestro otros similares?");
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
    mensaje = "No encontré productos de esa categoría. ¿Quieres ver todo el catálogo?";
  } else {
    mensaje += "\nDime el nombre y te muestro fotos de proyectos reales.";
  }
  await enviarMensaje(to, mensaje);
}

function detectarCantidad(texto) {
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

  // Detectar cantidad
  const nuevaCantidad = detectarCantidad(textoUsuario);
  if (nuevaCantidad !== null && nuevaCantidad !== session.ultimaCantidad) {
    session.ultimaCantidad = nuevaCantidad;
  }

  // Detectar tono
  const tonosPosibles = ["durazno", "canelo", "matizado", "cappuccino", "nero", "toscano", "bianco", "natural"];
  const tonoEncontrado = tonosPosibles.find(t => textoUsuario.includes(t));
  if (tonoEncontrado) {
    session.ultimoTono = tonoEncontrado;
  }

  // Detectar ciudad para envío
  const ciudades = ["chia", "bogotá", "bogota", "nemocon", "tocancipá", "zipaquirá", "sopo", "cajicá", "cogua"];
  const ciudadMatch = ciudades.find(c => textoUsuario.includes(c));
  if (ciudadMatch && !session.lugarEnvio) {
    session.lugarEnvio = ciudadMatch;
  }

  const catalogoInfo = Object.entries(catalogo)
    .map(([id, prod]) => {
      let info = `id: ${id}, nombre: ${prod.nombre}`;
      if (prod.tonos) info += `, tonos: ${prod.tonos.join(", ")}`;
      return info;
    })
    .join("\n");

  const systemPrompt = `
Eres Ana, asesora de Ladrillera La Toscana (Némocon, Cundinamarca). Dirección: ${UBICACION.direccion}. Maps: ${UBICACION.mapsLink}. Web: ${UBICACION.web}.

PERSONALIDAD: Muy cálida, cercana, usas "jaja", "uy", "qué bien", "dale", "listo", "claro que sí", "ay", "tranqui". NO repites preguntas que ya han sido respondidas en la conversación (revisa el historial).

REGLAS DE CONVERSACIÓN PRIORITARIAS:

1. **Preguntas sociales** (ej: "cómo estás?", "cómo va todo?", "mucho trabajo?", "estás brava?"):
   - Responde de forma natural y empática.
   - Luego, redirige suavemente hacia la venta con una frase como: "¿Buscas algún producto en particular?" o "¿Te puedo ayudar con algún material hoy?"
   - NO fuerces la venta de forma brusca, pero sí orienta.

2. **Si el usuario pide un producto específico** (ej: "adoquines 20x10x6") o menciona un material:
   - Responde con saludo breve + lista de tonos disponibles según el catálogo (si los tiene).
   - Ejecuta acción "enviar_imagenes" para ese producto. No preguntes si quiere fotos.

3. **Después de enviar imágenes**, pregunta cantidad: "¿Cuántas unidades necesitas?"

4. **Cuando el usuario da la cantidad**, confirma y luego pregunta el tono SOLO si el producto tiene más de un tono Y todavía no lo ha mencionado. Si ya lo dijo, no preguntes.

5. **Después de tener cantidad y tono (si aplica), pregunta OBLIGATORIAMENTE:** "¿Necesitas que te lo enviemos o prefieres recoger en Némocon?".
   - Si responde "recoger" o "recojo": envía dirección exacta y link de Maps.
   - Si responde "envío": pregunta la ciudad ("¿A qué ciudad necesitas el envío?").

6. **Una vez que tengas confirmados: producto, cantidad, tono (si aplica) y lugar (dirección de recogida o ciudad de envío), entonces ofrece cotización:** "Listo, con [producto], [cantidad] unidades, tono [tono] y [lugar]. ¿Quieres que te prepare una cotización formal?"

7. **NUNCA inventes información**. Si no sabes algo, responde: "No estoy segura, mejor consulta nuestra web o te conecto con un asesor."

8. **Mantén respuestas cortas pero completas (máx 35 palabras).**

Tu respuesta debe ser un JSON con:
{
  "respuesta": "string (puede ser vacío si solo acción)",
  "accion": "nada | enviar_catalogo | enviar_catalogo_adoquines | enviar_catalogo_fachaletas | enviar_imagenes",
  "producto_id": "string solo para enviar_imagenes"
}

Catálogo:
${catalogoInfo}

Historial reciente:
${session.history.map(m => `${m.role === "user" ? "Usuario" : "Ana"}: ${m.content}`).join("\n")}

EJEMPLOS (IMPORTANTE para respuestas sociales y redirección):
- Usuario: "hola veci como estás?" → {"respuesta": "¡Hola! Todo bien, gracias. ¿Y tú? ¿Buscas algún producto en particular?", "accion": "nada"}
- Usuario: "mucho trabajo?" → {"respuesta": "Uy, un poco, pero bien. ¿Tú también andas ocupado? ¿Necesitas algo de construcción?", "accion": "nada"}
- Usuario: "estás brava?" → {"respuesta": "Jaja no, para nada. Tranqui, aquí estoy para ayudarte. ¿Qué necesitas?", "accion": "nada"}
- Usuario: "buenas veci tiene adoquines 20*10*6?" → {"respuesta": "¡Hola! Claro que sí, tenemos ese modelo en tonos durazno, canelo y matizado. Te muestro fotos.", "accion": "enviar_imagenes", "producto_id": "adoquin_20x10x6"}
- Usuario: "quiero tono durazno para chia" (después de fotos) → {"respuesta": "Perfecto. Ya sé que quieres tono durazno y envío a Chía. ¿Cuántas unidades necesitas?", "accion": "nada"}
- Usuario: "10" → {"respuesta": "Con 10 unidades. ¿Necesitas envío a Chía o prefieres recoger en Némocon?", "accion": "nada"}
- Usuario: "envío" → {"respuesta": "Dale, envío a Chía. ¿Confirmas el tono durazno y 10 unidades? ¿Quieres cotización formal?", "accion": "nada"}

SOLO RESPONDE CON JSON.
`;

  const respuestaIA = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: textoUsuario }
      ],
      temperature: 0.65,
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

  if (decision.accion === "enviar_catalogo") {
    await mostrarCatalogo(from);
  } else if (decision.accion === "enviar_catalogo_adoquines") {
    await mostrarCatalogo(from, "adoquines");
  } else if (decision.accion === "enviar_catalogo_fachaletas") {
    await mostrarCatalogo(from, "fachaletas");
  } else if (decision.accion === "enviar_imagenes" && decision.producto_id && catalogo[decision.producto_id]) {
    await enviarImagenes(from, decision.producto_id);
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
      sessions.set(from, {
        history: [],
        presentado: false,
        ultimaCantidad: null,
        ultimoTono: null,
        lugarEnvio: null,
        productoActual: null
      });
    }
    const session = sessions.get(from);

    const esPrimerMensaje = !session.presentado;
    const esSoloSaludo = /^(hola|buenas|dime|hey|qué hubo|qué más|saludos?|cómo vas|qué cuentas?|mucho trabajo?|veci|vecino|vecina)$/i.test(text.trim());

    if (esPrimerMensaje && esSoloSaludo) {
      session.presentado = true;
      await enviarMensaje(from, "¡Hola! Soy Ana, de Ladrillera La Toscana (Némocon). Cuéntame, ¿qué estás buscando?");
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

app.get("/", (req, res) => res.send("Ana IA - Asesora cálida y completa"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo puerto ${PORT}`));
