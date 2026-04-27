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

// Estado inicial del pedido para cada usuario
const defaultPedido = {
  productoId: null,
  productoNombre: null,
  tonalidad: null,
  cantidad: null,
  ubicacion: null,
  tonosDisponibles: [],
  ultimoProductoMostrado: null
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
    .trim();
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

async function enviarImagenesConSeguimiento(to, productoId, session) {
  const item = catalogo[productoId];
  if (!item) {
    await enviarMensaje(to, "No conozco ese producto. ¿Quieres ver el catálogo?");
    return false;
  }

  // Enviar imágenes
  const ok = await enviarImagenes(to, productoId);
  if (!ok) return false;

  // Actualizar sesión
  session.pedido.productoId = productoId;
  session.pedido.productoNombre = item.nombre;
  session.pedido.tonosDisponibles = item.tonos || [];

  // Preguntar siguiente dato faltante (prioridad: tonalidad -> cantidad -> ubicación)
  if (session.pedido.tonosDisponibles.length > 0 && !session.pedido.tonalidad) {
    await enviarMensaje(to, `✅ Genial. Ese producto viene en estos tonos: ${session.pedido.tonosDisponibles.join(", ")}. ¿Cuál te gusta?`);
    return true;
  }
  if (!session.pedido.cantidad) {
    await enviarMensaje(to, "¿Cuántas unidades necesitas? (Ej: 10.000)");
    return true;
  }
  if (!session.pedido.ubicacion) {
    await preguntarUbicacion(to, session);
    return true;
  }
  // Si ya tiene todos los datos
  await enviarMensaje(to, `Perfecto. Tengo tu pedido: ${session.pedido.productoNombre}, ${session.pedido.tonalidad || "tono no especificado"}, ${session.pedido.cantidad} unidades, envío a ${session.pedido.ubicacion}. ¿Quieres una cotización formal?`);
  session.cotizacionOfrecida = true;
  return true;
}

async function preguntarUbicacion(to, session) {
  await enviarMensaje(to, "📍 ¿Dónde necesitas la entrega? Puedes escribir la dirección completa o, si estás en Némocon, comparte tu ubicación de Google Maps.");
}

async function mostrarCatalogoEnTexto(to, categoria = null) {
  let productos = [];
  let mensaje = "";

  if (categoria === "adoquines") {
    productos = Object.entries(catalogo).filter(([id]) => id.startsWith("adoquin"));
    mensaje = "🏗️ *ADOQUINES disponibles:*\n\n";
  } else if (categoria === "fachaletas") {
    productos = Object.entries(catalogo).filter(([id]) => id.startsWith("fachaleta"));
    mensaje = "🧱 *FACHALETAS (Thinbrick) disponibles:*\n\n";
  } else {
    productos = Object.entries(catalogo);
    mensaje = "📦 *Catálogo completo Ladrillera La Toscana:*\n\n";
  }

  let idx = 1;
  for (const [id, prod] of productos) {
    mensaje += `${idx}. *${prod.nombre}*`;
    if (prod.tonos && prod.tonos.length) mensaje += ` (Tonos: ${prod.tonos.join(", ")})`;
    mensaje += "\n";
    idx++;
  }
  mensaje += "\n✍️ Responde con el *nombre* o el *número* del producto que te interesa.";
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

  // Detectar cantidad y actualizar pedido automáticamente
  const nuevaCantidad = detectarCantidad(textoUsuario);
  if (nuevaCantidad !== null) {
    session.pedido.cantidad = nuevaCantidad;
  }

  // Construir estado del pedido para el prompt
  const estadoPedido = `
ESTADO ACTUAL DEL PEDIDO:
- Producto: ${session.pedido.productoNombre || "no definido"} (id: ${session.pedido.productoId || "ninguno"})
- Tonalidad: ${session.pedido.tonalidad || "no definida"}
- Cantidad: ${session.pedido.cantidad || "no definida"}
- Ubicación: ${session.pedido.ubicacion || "no definida"}

DATOS QUE FALTAN POR PREGUNTAR (prioriza en este orden):
${!session.pedido.productoNombre ? "- Producto" : ""}
${(!session.pedido.tonalidad && session.pedido.tonosDisponibles.length > 0) ? "- Tonalidad (opciones: " + session.pedido.tonosDisponibles.join(", ") + ")" : ""}
${!session.pedido.cantidad ? "- Cantidad (en unidades)" : ""}
${!session.pedido.ubicacion ? "- Ubicación de entrega" : ""}
`;

  const catalogoInfo = Object.entries(catalogo)
    .map(([id, prod]) => `id: ${id}, nombre: ${prod.nombre}`)
    .join("\n");

  const systemPrompt = `
Eres Ana, asesora de Ladrillera La Toscana. Somos una empresa colombiana ubicada en Némocon (Cundinamarca). NO inventes ubicaciones. Hablas de forma muy humana, cálida, usas "jaja", "uy", "dale", "listo", "qué bien". Nunca eres seca ni robótica.

${estadoPedido}

REGLAS OBLIGATORIAS:
- Si el usuario NO ha elegido producto y pregunta "qué tienes?" o "cuáles tienes?" o "muéstrame", RESPONDE con accion "mostrar_catalogo_texto" (sin especificar categoría) o "mostrar_adoquines_texto" si mencionó adoquines.
- Si el usuario da el NOMBRE exacto o aproximado de un producto (ej: "20x10x6", "adoquín ecológico", "cappuccino"), asigna accion "enviar_imagenes" con el producto_id correspondiente.
- Si el usuario dice un número de la lista (ej: "el 3"), busca el producto por índice y envía imágenes.
- Si ya se mostraron imágenes y faltan datos, NO repitas preguntas. Usa el estado para saber qué falta.
- Si el producto tiene varios tonos y el usuario menciona un tono válido, actualiza tonalidad con accion "actualizar_tonalidad".
- Si el usuario da una cantidad (números grandes como 10.000 o 1000), actualiza cantidad con accion "actualizar_cantidad".
- Si el usuario da una dirección (calle, carrera, etc.) o dice "Némocon" o "acá en Némocon", actualiza ubicación con accion "actualizar_ubicacion".
- Tus respuestas deben ser muy cortas (máx 25 palabras) y amables.

Tu respuesta debe ser JSON exacto:
{
  "respuesta": "texto para el usuario (puede ser vacío si solo ejecutas acción)",
  "accion": "nada" | "mostrar_catalogo_texto" | "mostrar_adoquines_texto" | "mostrar_fachaletas_texto" | "enviar_imagenes" | "actualizar_tonalidad" | "actualizar_cantidad" | "actualizar_ubicacion",
  "producto_id": "solo para enviar_imagenes",
  "tonalidad_valor": "solo para actualizar_tonalidad",
  "cantidad_valor": 0,
  "ubicacion_valor": "string"
}

Catálogo:
${catalogoInfo}

Historial reciente:
${session.history.map(m => `${m.role === "user" ? "Usuario" : "Ana"}: ${m.content}`).join("\n")}
`;

  let decision;
  try {
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
    decision = JSON.parse(contenido);
  } catch (e) {
    console.error("Error llamando a IA o parseando:", e);
    decision = {
      respuesta: "Uy, no te entendí bien. ¿Puedes repetirlo?",
      accion: "nada"
    };
  }

  // Enviar respuesta textual si existe
  if (decision.respuesta && decision.respuesta.trim() !== "") {
    await enviarMensaje(from, decision.respuesta);
    session.history.push({ role: "assistant", content: decision.respuesta });
  }

  // Ejecutar acciones
  switch (decision.accion) {
    case "mostrar_catalogo_texto":
      await mostrarCatalogoEnTexto(from);
      break;
    case "mostrar_adoquines_texto":
      await mostrarCatalogoEnTexto(from, "adoquines");
      break;
    case "mostrar_fachaletas_texto":
      await mostrarCatalogoEnTexto(from, "fachaletas");
      break;
    case "enviar_imagenes":
      if (decision.producto_id && catalogo[decision.producto_id]) {
        await enviarImagenesConSeguimiento(from, decision.producto_id, session);
      } else {
        await enviarMensaje(from, "No encontré ese producto. ¿Quieres ver el catálogo completo?");
      }
      break;
    case "actualizar_tonalidad":
      if (decision.tonalidad_valor) {
        session.pedido.tonalidad = decision.tonalidad_valor;
        await enviarMensaje(from, `✅ Tono ${decision.tonalidad_valor} anotado.`);
        // Continuar con lo que falta
        if (!session.pedido.cantidad) {
          await enviarMensaje(from, "¿Cuántas unidades necesitas?");
        } else if (!session.pedido.ubicacion) {
          await preguntarUbicacion(from, session);
        } else {
          await enviarMensaje(from, `Listo. Tengo todo. ¿Quieres una cotización formal?`);
          session.cotizacionOfrecida = true;
        }
      }
      break;
    case "actualizar_cantidad":
      if (decision.cantidad_valor && decision.cantidad_valor > 0) {
        session.pedido.cantidad = decision.cantidad_valor;
        await enviarMensaje(from, `✅ Cantidad: ${decision.cantidad_valor} unidades.`);
        if (!session.pedido.ubicacion) {
          await preguntarUbicacion(from, session);
        } else {
          await enviarMensaje(from, `Genial. ¿Te preparo una cotización formal?`);
          session.cotizacionOfrecida = true;
        }
      }
      break;
    case "actualizar_ubicacion":
      if (decision.ubicacion_valor) {
        session.pedido.ubicacion = decision.ubicacion_valor;
        await enviarMensaje(from, `✅ Dirección registrada: ${decision.ubicacion_valor}.`);
        if (session.pedido.productoNombre && session.pedido.cantidad) {
          await enviarMensaje(from, `Perfecto, ya tengo todos los datos. ¿Quieres que te prepare una cotización formal?`);
          session.cotizacionOfrecida = true;
        } else {
          await enviarMensaje(from, "Con eso ya vamos avanzando. ¿Algo más que necesites?");
        }
      }
      break;
    default:
      // Si no hay acción específica pero faltan datos, la IA ya debería haber preguntado
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
      sessions.set(from, {
        history: [],
        presentado: false,
        pedido: JSON.parse(JSON.stringify(defaultPedido)),
        cotizacionOfrecida: false
      });
    }
    const session = sessions.get(from);

    // Primer saludo con iniciativa: mostrar catálogo completo al inicio
    const esPrimerMensaje = !session.presentado;
    const esSoloSaludo = /^(hola|buenas|dime|hey|qué hubo|qué más|saludos?|cómo vas|qué cuentas?|mucho trabajo?|veci)$/i.test(text.trim());

    if (esPrimerMensaje && esSoloSaludo) {
      session.presentado = true;
      await enviarMensaje(from, "¡Hola! Soy Ana, de Ladrillera La Toscana (Némocon). Para ayudarte mejor, te muestro nuestros productos:");
      await mostrarCatalogoEnTexto(from); // Iniciativa proactiva
      session.history.push({ role: "assistant", content: "Hola, soy Ana. (mostró catálogo)" });
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

app.get("/", (req, res) => res.send("Ana IA - Versión proactiva con recolección de producto, tono, cantidad y ubicación"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo puerto ${PORT}`));
