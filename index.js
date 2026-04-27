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
  mapsLink: "https://maps.app.goo.gl/anyRAWvMrwqM2jnH7"
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
    .replace(/\*/g, "x");  // convierte 20*10*6 a 20x10x6
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
  // soporta 14.000 , 10000 , 10.000 , 100,000
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
  if (nuevaCantidad !== null && nuevaCantidad !== session.ultimaCantidad) {
    session.ultimaCantidad = nuevaCantidad;
    session.cantidadConfirmada = false;
  }

  const catalogoInfo = Object.entries(catalogo)
    .map(([id, prod]) => {
      let info = `id: ${id}, nombre: ${prod.nombre}`;
      if (prod.tonos) info += `, tonos: ${prod.tonos.join(", ")}`;
      return info;
    })
    .join("\n");

  const systemPrompt = `
Eres Ana, asesora de Ladrillera La Toscana. Ubicados en Némocon, Cundinamarca (dirección exacta: ${UBICACION.direccion}, Maps: ${UBICACION.mapsLink}). Hablas como una persona real, muy cálida, alegre y servicial. Usas "jaja", "uy", "qué bien", "dale", "listo", "claro que sí". NUNCA respondas de forma seca. Tus respuestas deben ser naturales y breves (máx 30 palabras) pero completas.

REGLAS ESTRICTAS:
1. Si el usuario saluda y además pide un producto específico (ej: "buenas veci tiene adoquines 20x10x6?"), responde con saludo breve + entusiasmo + lista de tonos si existen + acción "enviar_imagenes". NO preguntes si quiere fotos, solo envía.
   Ejemplo: "¡Hola! Claro que sí, tenemos ese modelo en tonos durazno, canelo y matizado. Te muestro fotos."

2. Después de enviar imágenes, la IA debe preguntar cantidad: "¿Cuántas unidades necesitas?"

3. Cuando el usuario da una cantidad, confirma y pregunta el tono (si existe más de un tono): "Perfecto, con [cantidad] unidades. ¿Qué tono prefieres? Tenemos [lista tonos]."

4. Después del tono, pregunta si es envío o recogida: "¿Necesitas envío a alguna ciudad o prefieres recoger en Némocon?"

5. Si el usuario dice "recoger" o "recojo", responde con la dirección exacta y el link de Maps: "Genial, puedes recoger en ${UBICACION.direccion}. Aquí está el link de Maps: ${UBICACION.mapsLink}"

6. Si el usuario dice "envío", pregúntale la ciudad: "¿A qué ciudad necesitas el envío?"

7. Una vez que tengas: producto, cantidad, tono y lugar (ciudad de envío o confirmación de recogida), ofrece cotización: "Listo, con [producto], [cantidad] unidades, tono [tono] y [lugar]. ¿Quieres que te prepare una cotización formal?"

8. Si el usuario corrige algún dato (cantidad, tono, lugar), actualiza la sesión y confirma sin repetir toda la lista.

9. NUNCA inventes información. Si no sabes algo, di: "No estoy segura, mejor consulta nuestra web https://ladrilleralatoscana.com/ o te conecto con un asesor."

10. No envíes mensajes duplicados. La acción "enviar_imagenes" solo envía imágenes, sin texto adicional. El texto de presentación ya lo generó la IA.

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

Ejemplos de JSON correcto (fijate en la naturalidad):
- Usuario: "buenas veci tiene adoquines 20*10*6?" → {"respuesta": "¡Hola! Claro que sí, tenemos ese modelo en tonos durazno, canelo y matizado. Te muestro fotos.", "accion": "enviar_imagenes", "producto_id": "adoquin_20x10x6"}
- Usuario: "necesito 74 para chia" (después de fotos) → {"respuesta": "Perfecto, con 74 unidades. ¿Qué tono prefieres? Tenemos durazno, canelo y matizado.", "accion": "nada"}
- Usuario: "canelo" → {"respuesta": "Dale, canelo es muy bonito. ¿Necesitas envío a Chía o prefieres recoger en Némocon?", "accion": "nada"}
- Usuario: "recoger en nemocon" → {"respuesta": "Genial, puedes recoger en Cra 4 #9-12, Barrio El Centro, Némocon. Aquí el link de Maps: https://maps.app.goo.gl/anyRAWvMrwqM2jnH7. ¿Quieres cotización formal?", "accion": "nada"}

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
        cantidadConfirmada: false,
        ultimoTono: null,
        lugarEnvio: null
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

app.get("/", (req, res) => res.send("Ana IA - Versión Definitiva con Tonos, Ubicación y Cotización"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo puerto ${PORT}`));
