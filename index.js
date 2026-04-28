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

// Estado inicial del pedido - NINGÚN VALOR POR DEFECTO
const defaultPedido = {
  referencia: null,      // id del producto
  nombreProducto: null,
  tonalidad: null,
  cantidad: null,        // IMPORTANTE: null = no preguntado aún
  ubicacion: null,       // null = no definida, "recoger" o dirección
  tonosDisponibles: []
};

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
    await enviarMensaje(to, "Ay, todavía no tengo fotos de ese producto. ¿Te interesa otro?");
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

// ==================== NUEVA LÓGICA DE PREGUNTAS ====================

async function preguntarProximoDato(to, session) {
  // 1. Si no hay referencia, mostrar catálogo (pero solo si el usuario lo pide)
  if (!session.pedido.referencia) {
    // Esto no debería ocurrir porque la referencia se pide explícitamente
    await mostrarCatalogoHumano(to);
    return;
  }
  // 2. Si hay referencia pero no tonalidad y el producto tiene tonos
  if (session.pedido.tonosDisponibles.length > 0 && !session.pedido.tonalidad) {
    await enviarMensaje(to, `¿De qué color lo quieres? Tenemos ${session.pedido.tonosDisponibles.join(", ")}.`);
    return;
  }
  // 3. Si falta cantidad
  if (session.pedido.cantidad === null) {
    await enviarMensaje(to, "¿Cuántas unidades necesitas? Así te ayudo con el precio.");
    return;
  }
  // 4. Si falta ubicación
  if (!session.pedido.ubicacion) {
    await enviarMensaje(to, "¿Dónde te lo mandamos? Si es en Némocon, puedes pasar a recoger. Dame la dirección completa o dime si pasas a recoger.");
    return;
  }
  // 5. Ya tenemos todos los datos: mostrar resumen y ofrecer cotización
  await mostrarResumenYOferta(to, session);
}

async function mostrarResumenYOferta(to, session) {
  const { nombreProducto, tonalidad, cantidad, ubicacion } = session.pedido;
  let beneficios = "";
  if (nombreProducto.includes("20x10x6")) {
    beneficios = " Este adoquín es ideal para entradas de carros y zonas de alto tránsito, súper resistente. Además, su color dura mucho tiempo sin decolorarse.";
  } else if (nombreProducto.includes("fachaleta")) {
    beneficios = " Es perfecta para fachadas elegantes, fácil de instalar y con acabado premium.";
  } else {
    beneficios = " Es un producto de excelente calidad, fabricado con materiales seleccionados.";
  }
  const ubicacionTexto = ubicacion === "recoger" ? "lo recoges en la fábrica (Némocon)" : `envío a ${ubicacion}`;
  await enviarMensaje(to, `Listo, tengo tu pedido: ${nombreProducto}, color ${tonalidad}, ${cantidad} unidades, ${ubicacionTexto}.${beneficios} ¿Quieres que te prepare una cotización formal?`);
  session.cotizacionOfrecida = true;
}

// Función para detectar si el usuario pide la ubicación de la fábrica
function esPreguntaUbicacionFabrica(texto) {
  const lower = texto.toLowerCase();
  return /dónde queda|en qué parte|ubicación de la fábrica|dirección de la planta|dónde lo puedo recoger|pasar a recoger|en que parte lo puedo recoger|dirección para recoger/i.test(lower);
}

// Mostrar catálogo solo cuando el usuario lo pida
async function mostrarCatalogoHumano(to, categoria = null) {
  let productos = [];
  if (categoria === "adoquines") {
    productos = Object.entries(catalogo).filter(([id]) => id.startsWith("adoquin"));
    await enviarMensaje(to, "Estos son los adoquines que manejamos:");
  } else if (categoria === "fachaletas") {
    productos = Object.entries(catalogo).filter(([id]) => id.startsWith("fachaleta"));
    await enviarMensaje(to, "Te muestro las fachaletas que tenemos:");
  } else {
    productos = Object.entries(catalogo);
    await enviarMensaje(to, "Mira, te cuento los productos que tenemos:");
  }

  let mensaje = "";
  for (const [id, prod] of productos) {
    mensaje += `- ${prod.nombre}`;
    if (prod.tonos && prod.tonos.length) mensaje += ` (colores: ${prod.tonos.join(", ")})`;
    mensaje += "\n";
  }
  mensaje += "\n¿Cuál te gusta? Me dices el nombre y te mando fotos.";
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

// Detectar si el usuario dice que va a recoger (sin pedir dirección)
function esRecoger(texto) {
  const lower = texto.toLowerCase();
  return /paso a recoger|voy a recoger|recojo|recogeré|lo recojo|yo lo recojo|pasaré a recoger/i.test(lower);
}

async function procesarConIA(textoUsuario, from, session) {
  session.history.push({ role: "user", content: textoUsuario });
  if (session.history.length > 12) session.history = session.history.slice(-12);

  // 1. DETECCIÓN PRIORITARIA: Si pregunta por la ubicación de la fábrica, responder y salir (sin continuar flujo)
  if (esPreguntaUbicacionFabrica(textoUsuario)) {
    await enviarMensaje(from, "Claro, la fábrica queda en Némocon. Aquí te mando la ubicación exacta para que pases a recoger:");
    await enviarMensaje(from, "https://maps.app.goo.gl/m2nUV7zG5GbjLV8q6");
    // Si el usuario aún no tiene definida la ubicación, la marcamos como "recoger" para no preguntar después
    if (!session.pedido.ubicacion && session.pedido.referencia && session.pedido.tonalidad && session.pedido.cantidad !== null) {
      session.pedido.ubicacion = "recoger";
      await preguntarProximoDato(from, session); // Esto mostrará resumen si todo está completo
    }
    return;
  }

  // 2. Detectar si dice que va a recoger (sin preguntar dirección)
  if (esRecoger(textoUsuario) && !session.pedido.ubicacion) {
    session.pedido.ubicacion = "recoger";
    await enviarMensaje(from, "Perfecto, entonces pasas a recoger a la fábrica. ¿Necesitas la ubicación?");
    await preguntarProximoDato(from, session);
    return;
  }

  // 3. Detectar cantidad explícita (SOLO si el usuario escribe un número)
  const cantidadDetectada = detectarCantidad(textoUsuario);
  if (cantidadDetectada !== null && session.pedido.cantidad === null) {
    session.pedido.cantidad = cantidadDetectada;
    await enviarMensaje(from, `Ok, ${cantidadDetectada} unidades.`);
    await preguntarProximoDato(from, session);
    return;
  }

  // 4. Si la cantidad ya está definida y el usuario da una nueva, actualizamos
  if (cantidadDetectada !== null && session.pedido.cantidad !== null && session.pedido.cantidad !== cantidadDetectada) {
    session.pedido.cantidad = cantidadDetectada;
    await enviarMensaje(from, `Actualizado: ${cantidadDetectada} unidades.`);
    await preguntarProximoDato(from, session);
    return;
  }

  // 5. Detectar ubicación (dirección o ciudad) - solo si no es recoger y no está definida
  const lower = textoUsuario.toLowerCase();
  // Evitar que palabras como "recoger" activen dirección
  if (!esRecoger(textoUsuario) && !session.pedido.ubicacion && !esPreguntaUbicacionFabrica(textoUsuario)) {
    // Si parece una dirección (tiene calle, carrera, número o ciudad)
    if (lower.match(/(calle|cra|carrera|diagonal|transversal|#|no\.|número|chía|bogotá|soacha|zipaquirá|tocancipá|némocon)/i)) {
      session.pedido.ubicacion = textoUsuario; // guardamos lo que escribió
      await enviarMensaje(from, `Dirección guardada: ${textoUsuario}`);
      await preguntarProximoDato(from, session);
      return;
    }
  }

  // 6. Si no hay referencia, usar IA para entender qué producto quiere o mostrar catálogo
  // Pero aquí usaremos la IA para interpretar comandos del usuario.
  
  // Estado actual para la IA
  const estadoPedido = `
DATOS ACTUALES:
- Referencia: ${session.pedido.nombreProducto || "ninguna"}
- Tonalidad: ${session.pedido.tonalidad || "ninguna"}
- Cantidad: ${session.pedido.cantidad === null ? "ninguna" : session.pedido.cantidad}
- Ubicación: ${session.pedido.ubicacion === "recoger" ? "recoger en fábrica" : (session.pedido.ubicacion || "ninguna")}

FALTAN (en orden):
${!session.pedido.referencia ? "- producto" : ""}
${(!session.pedido.tonalidad && session.pedido.tonosDisponibles.length > 0) ? "- color (" + session.pedido.tonosDisponibles.join(", ") + ")" : ""}
${session.pedido.cantidad === null ? "- cantidad" : ""}
${!session.pedido.ubicacion ? "- ubicación (recoger o dirección)" : ""}
`;

  const catalogoInfo = Object.entries(catalogo)
    .map(([id, prod]) => `id: ${id}, nombre: ${prod.nombre}${prod.tonos ? ` (tonos: ${prod.tonos.join(",")})` : ""}`)
    .join("\n");

  const systemPrompt = `
Eres Ana, asesora de Ladrillera La Toscana (Némocon, Colombia). Hablas como una persona normal, cálida, usas "jaja", "uy", "dale", "listo", "epa", "qué más". Tus respuestas son cortas y humanas. EVITA palabras robóticas como "anotado", "procesar", "formal", "registrado", "actualizado". Nunca asumas cantidades.

${estadoPedido}

REGLAS:
- Si el usuario pide un producto específico (ej: "20x10x6", "adoquín 20x10x6"), acción "enviar_imagenes" con el producto_id.
- Si el usuario pide "catálogo" o "qué tienes", acción "mostrar_catalogo".
- Si el usuario da un color (ej: "durazno"), acción "actualizar_tonalidad".
- NO generes acciones para cantidad o ubicación porque ya se detectan automáticamente.
- Responde con una frase amable y la acción correspondiente.

Responde SOLO con JSON:
{
  "respuesta": "texto corto para el usuario",
  "accion": "nada | mostrar_catalogo | enviar_imagenes | actualizar_tonalidad",
  "producto_id": "",
  "tonalidad_valor": ""
}

Catálogo: ${catalogoInfo}
Historial reciente:
${session.history.slice(-6).map(m => `${m.role === "user" ? "Cliente" : "Ana"}: ${m.content}`).join("\n")}
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
    decision = JSON.parse(respuestaIA.data.choices[0].message.content);
  } catch (e) {
    console.error("Error IA:", e);
    decision = {
      respuesta: "Ay no te entendí, ¿me lo dices otra vez?",
      accion: "nada"
    };
  }

  if (decision.respuesta && decision.respuesta.trim() !== "") {
    await enviarMensaje(from, decision.respuesta);
    session.history.push({ role: "assistant", content: decision.respuesta });
  }

  switch (decision.accion) {
    case "mostrar_catalogo":
      await mostrarCatalogoHumano(from);
      break;
    case "enviar_imagenes":
      if (decision.producto_id && catalogo[decision.producto_id]) {
        const item = catalogo[decision.producto_id];
        await enviarImagenes(from, decision.producto_id);
        session.pedido.referencia = decision.producto_id;
        session.pedido.nombreProducto = item.nombre;
        session.pedido.tonosDisponibles = item.tonos || [];
        await preguntarProximoDato(from, session);
      } else {
        await enviarMensaje(from, "Ese no aparece, ¿seguro que está en la lista?");
      }
      break;
    case "actualizar_tonalidad":
      if (decision.tonalidad_valor) {
        session.pedido.tonalidad = decision.tonalidad_valor;
        await enviarMensaje(from, `Perfecto, ${decision.tonalidad_valor}.`);
        await preguntarProximoDato(from, session);
      }
      break;
    default:
      // Si no hay acción pero faltan datos, preguntar
      if (!session.pedido.referencia) {
        await mostrarCatalogoHumano(from);
      } else {
        await preguntarProximoDato(from, session);
      }
      break;
  }
}

// ==============================
// WEBHOOKS
// ==============================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
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
    console.log(`Mensaje de ${from}: ${text}`);

    if (!sessions.has(from)) {
      sessions.set(from, {
        history: [],
        presentado: false,
        pedido: JSON.parse(JSON.stringify(defaultPedido)),
        cotizacionOfrecida: false
      });
    }
    const session = sessions.get(from);

    // Comandos de prueba
    if (text === "#reset" || text === "reset" || text === "reiniciar") {
      session.pedido = JSON.parse(JSON.stringify(defaultPedido));
      session.cotizacionOfrecida = false;
      session.history = [];
      session.presentado = false;
      await enviarMensaje(from, "🔄 Sesión reiniciada. Todo limpio.");
      return res.sendStatus(200);
    }
    if (text === "#estado") {
      const estado = `Producto: ${session.pedido.nombreProducto || "❌"}\nColor: ${session.pedido.tonalidad || "❌"}\nCantidad: ${session.pedido.cantidad ?? "❌"}\nUbicación: ${session.pedido.ubicacion || "❌"}`;
      await enviarMensaje(from, estado);
      return res.sendStatus(200);
    }

    const esPrimerMensaje = !session.presentado;
    const esSaludo = /^(hola|buenos días|buenas tardes|buenas noches|qué hubo|qué más|saludos|hey|epa|veci)$/i.test(text.trim());

    if (esPrimerMensaje && esSaludo) {
      session.presentado = true;
      await enviarMensaje(from, "¡Hola! ¿Cómo vas? Cuéntame qué estás buscando, si adoquines o fachaletas, con gusto te ayudo.");
      session.history.push({ role: "assistant", content: "¡Hola! ¿Cómo vas?..." });
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

app.get("/", (req, res) => res.send("Ana IA - Versión reestructurada"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo puerto ${PORT}`));
