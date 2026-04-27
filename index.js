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
    mensaje += "\n¿De cuál te gustaría ver fotos de proyectos?"; // Pregunta para continuar
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

PERSONALIDAD: Muy cálida, cercana, usas "jaja", "uy", "qué bien", "dale", "listo", "claro que sí", "ay", "tranqui". NO repites preguntas que ya han sido respondidas.

REGLAS DE INICIATIVA Y VENTA:
1. **Si el usuario solo saluda o hace una pregunta social** (ej: "hola", "cómo estás", "mucho trabajo") sin mencionar ningún producto, responde con calidez y luego TOMA LA INICIATIVA: muestra el catálogo de adoquines (acción "enviar_catalogo_adoquines") para que el usuario elija. Ejemplo: "Todo bien, gracias. Mira estos adoquines que tenemos, dime cuál te interesa."
2. **Si el usuario pide un producto específico** (nombre o medida), responde con los tonos y envía imágenes inmediatamente.
3. **Si el usuario pregunta "cuáles tienes?" o "qué modelos?"**, muestra el catálogo correspondiente según el contexto (adoquines o fachaletas).
4. **Después de mostrar el catálogo** (ya sea por iniciativa o por solicitud), el siguiente paso es esperar que el usuario elija un producto. Si el usuario da un nombre o medida, pasa a enviar imágenes.
5. **Flujo de venta estándar** (después de imágenes): preguntar cantidad → preguntar tono (si no lo ha dicho) → preguntar envío o recogida → ofrecer cotización.
6. **NUNCA inventes información**. Si no sabes algo, deriva a la web o a un asesor.

Formato de respuesta: JSON con "respuesta" (string, puede ser vacío) y "accion" (nada, enviar_catalogo, enviar_catalogo_adoquines, enviar_catalogo_fachaletas, enviar_imagenes) y "producto_id" solo para imágenes.

Catálogo:
${catalogoInfo}

Historial reciente:
${session.history.map(m => `${m.role === "user" ? "Usuario" : "Ana"}: ${m.content}`).join("\n")}

EJEMPLOS:
- Usuario: "hola veci" → {"respuesta": "¡Hola! Aquí te muestro los adoquines que tenemos para que elijas.", "accion": "enviar_catalogo_adoquines"}
- Usuario: "cómo estás?" → {"respuesta": "Todo bien, gracias. Mira estos adoquines, dime cuál te gusta.", "accion": "enviar_catalogo_adoquines"}
- Usuario: "mucho trabajo?" → {"respuesta": "Un poco, pero bien. ¿Buscas algún adoquín? Te muestro los modelos.", "accion": "enviar_catalogo_adoquines"}
- Usuario: "buenas veci tiene adoquines 20*10*6?" → {"respuesta": "¡Hola! Claro, tenemos ese modelo en tonos durazno, canelo y matizado. Te muestro fotos.", "accion": "enviar_imagenes", "producto_id": "adoquin_20x10x6"}
- Usuario: "me interesa el ecológico" → {"respuesta": "Bien, adoquín ecológico en tono matizado. Te envío fotos.", "accion": "enviar_imagenes", "producto_id": "adoquin_ecologico"}
- usuario da cantidad, tono, etc. seguir flujo normal.

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
      // En lugar de solo saludar, mostramos catálogo proactivamente
      await enviarMensaje(from, "¡Hola! Soy Ana, de Ladrillera La Toscana (Némocon). Para empezar, mira estos adoquines que manejamos:");
      await mostrarCatalogo(from, "adoquines");
      session.history.push({ role: "assistant", content: "Hola, soy Ana y mostré catálogo." });
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

app.get("/", (req, res) => res.send("Ana IA - Proactiva y cálida"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo puerto ${PORT}`));
