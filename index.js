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

// Estado inicial del pedido
const defaultPedido = {
  productoId: null,
  productoNombre: null,
  tonalidad: null,
  cantidad: null,
  ubicacion: null,
  tonosDisponibles: []
};

// Función para limpiar el texto
function normalizarTexto(texto) {
  return texto
    .toLowerCase()
    .replace(/doquin|doquines|adokines|adoqin|adoquines/g, "adoquin")
    .replace(/fachada|fachadas|fachaleta arquitectonica|fachaleta arquitectónica/g, "fachaleta")
    .trim();
}

// Función para enviar mensajes
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

// Envío de imágenes
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

// ***** FUNCIÓN CORREGIDA: Manejo de imágenes y seguimiento *****
async function enviarImagenesConSeguimiento(to, productoId, session) {
  const item = catalogo[productoId];
  if (!item) {
    await enviarMensaje(to, "Ese no lo conozco, ¿me dices el nombre exacto o quieres ver la lista?");
    return false;
  }

  const ok = await enviarImagenes(to, productoId);
  if (!ok) return false;

  // Guardar datos
  session.pedido.productoId = productoId;
  session.pedido.productoNombre = item.nombre;
  session.pedido.tonosDisponibles = item.tonos || [];

  // 1. Primero Color
  if (session.pedido.tonosDisponibles.length > 0 && !session.pedido.tonalidad) {
    await enviarMensaje(to, `Qué bonito, ¿de qué color lo quieres? Tenemos ${session.pedido.tonosDisponibles.join(", ")}.`);
    return true;
  }
  // 2. Luego Cantidad (¡Esto faltaba en el log!)
  if (!session.pedido.cantidad) {
    await enviarMensaje(to, "Dime cuántas unidades necesitas así te ayudo con el precio. (Ej: 10.000)");
    return true;
  }
  // 3. Finalmente Ubicación
  if (!session.pedido.ubicacion) {
    await preguntarUbicacion(to, session);
    return true;
  }
  // Si ya tiene todo
  await enviarMensaje(to, `Listo, ya tengo tu pedido: ${session.pedido.productoNombre}, ${session.pedido.tonalidad || "color a definir"}, ${session.pedido.cantidad} unidades, envío a ${session.pedido.ubicacion}. ¿Quieres que te prepare la cotización?`);
  session.cotizacionOfrecida = true;
  return true;
}

// ***** FUNCIÓN CORREGIDA: Preguntar Ubicación *****
async function preguntarUbicacion(to, session) {
  if (session.pedido.ubicacion) return;

  const ubicacionActual = session.pedido.ubicacion;
  
  if (!ubicacionActual) {
    await enviarMensaje(to, "¿Dónde te lo mandamos? Si es en Némocon, puedes pasar a recoger o te lo enviamos. Dame la dirección completa.");
  } else {
    // Si ya se había registrado una ubicación, evitamos preguntar de nuevo
    await enviarMensaje(to, `Quedó registrado: ${ubicacionActual}.`);
  }
}

// ***** FUNCIÓN CORREGIDA: Mostrar Catálogo de forma humana *****
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

// Detección de cantidades
function detectarCantidad(texto) {
  const match = texto.match(/(\d{1,3}(?:[.,]\d{3})*(?:\.\d+)?)/);
  if (match) {
    let numStr = match[1].replace(/\./g, '').replace(',', '');
    const numero = parseInt(numStr, 10);
    if (!isNaN(numero) && numero > 0) return numero;
  }
  return null;
}

// ***** PROCESADOR IA CORREGIDO *****
async function procesarConIA(textoUsuario, from, session) {
  session.history.push({ role: "user", content: textoUsuario });
  if (session.history.length > 12) session.history = session.history.slice(-12);

  // Detectar cantidad automáticamente
  const nuevaCantidad = detectarCantidad(textoUsuario);
  if (nuevaCantidad !== null && !session.pedido.cantidad) {
    session.pedido.cantidad = nuevaCantidad;
  }

  // Estado del pedido para la IA
  const estadoPedido = `
ESTADO DEL PEDIDO:
- Producto: ${session.pedido.productoNombre || "ninguno"}
- Tonalidad: ${session.pedido.tonalidad || "ninguna"}
- Cantidad: ${session.pedido.cantidad || "ninguna"}
- Ubicación: ${session.pedido.ubicacion || "ninguna"}

FALTAN (en orden):
${!session.pedido.productoNombre ? "- elegir producto" : ""}
${(!session.pedido.tonalidad && session.pedido.tonosDisponibles.length > 0) ? "- elegir color (" + session.pedido.tonosDisponibles.join(", ") + ")" : ""}
${!session.pedido.cantidad ? "- cantidad" : ""}
${!session.pedido.ubicacion ? "- dirección de envío o recogida" : ""}
`;

  const catalogoInfo = Object.entries(catalogo)
    .map(([id, prod]) => `id: ${id}, nombre: ${prod.nombre}`)
    .join("\n");

  const systemPrompt = `
Eres Ana, una asesora de ventas de Ladrillera La Toscana (Némocon, Colombia). Hablas como una persona normal, cálida, usas "jaja", "uy", "dale", "listo", "epa", "qué más", "veci". Tus respuestas son cortas y evitas palabras robóticas como "anotado", "procesar", "formal". Simplemente confirmas con "ok", "listo", "perfecto" o un emoji.

${estadoPedido}

REGLAS ESTRICTAS:
- Si el usuario saluda, responde breve y pregunta qué busca (adoquines, fachaletas).
- Si el usuario dice "muéstrame" o "cuáles tienes" → acción "mostrar_adoquines" o "mostrar_fachaletas".
- Si el usuario da el nombre de un producto → acción "enviar_imagenes".
- Después de imágenes, sigue el orden: color → cantidad → ubicación.
- Cuando el usuario da una cantidad, actualiza con "actualizar_cantidad" y pasa a preguntar ubicación.
- Cuando el usuario da ubicación (ciudad, dirección, "Némocon"), actualiza con "actualizar_ubicacion".
- **SI EL USUARIO PIDIÓ LA UBICACIÓN POR MAPS**, DEBES PROPORCIONAR EL ENLACE CORRECTO: "https://maps.app.goo.gl/m2nUV7zG5GbjLV8q6"
- NUNCA repitas la misma pregunta y no envíes múltiples mensajes seguidos innecesariamente.

Responde SOLO con JSON:
{
  "respuesta": "texto para usuario (puede ser vacío)",
  "accion": "nada" | "mostrar_adoquines" | "mostrar_fachaletas" | "enviar_imagenes" | "actualizar_tonalidad" | "actualizar_cantidad" | "actualizar_ubicacion",
  "producto_id": "",
  "tonalidad_valor": "",
  "cantidad_valor": 0,
  "ubicacion_valor": ""
}

Catálogo: ${catalogoInfo}
Historial: ${session.history.map(m => `${m.role === "user" ? "Cliente" : "Ana"}: ${m.content}`).join("\n")}
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
        temperature: 0.7,
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

  // Enviar respuesta textual
  if (decision.respuesta && decision.respuesta.trim() !== "") {
    await enviarMensaje(from, decision.respuesta);
    session.history.push({ role: "assistant", content: decision.respuesta });
  }

  // Procesar acciones
  switch (decision.accion) {
    case "mostrar_adoquines":
      await mostrarCatalogoHumano(from, "adoquines");
      break;
    case "mostrar_fachaletas":
      await mostrarCatalogoHumano(from, "fachaletas");
      break;
    case "enviar_imagenes":
      if (decision.producto_id && catalogo[decision.producto_id]) {
        await enviarImagenesConSeguimiento(from, decision.producto_id, session);
      } else {
        await enviarMensaje(from, "Ese no aparece, ¿seguro que está en la lista?");
      }
      break;
    case "actualizar_tonalidad":
      if (decision.tonalidad_valor) {
        session.pedido.tonalidad = decision.tonalidad_valor;
        await enviarMensaje(from, `Listo, ${decision.tonalidad_valor}.`);
        if (!session.pedido.cantidad) {
          await enviarMensaje(from, "¿Cuántas unidades quieres?");
        } else if (!session.pedido.ubicacion) {
          await preguntarUbicacion(from, session);
        } else {
          await enviarMensaje(from, "¿Quieres que te prepare la cotización?");
        }
      }
      break;
    case "actualizar_cantidad":
      if (decision.cantidad_valor && !session.pedido.cantidad) {
        session.pedido.cantidad = decision.cantidad_valor;
        await enviarMensaje(from, `Ok, ${decision.cantidad_valor} unidades.`);
        if (!session.pedido.ubicacion) {
          await preguntarUbicacion(from, session);
        } else {
          await enviarMensaje(from, "¿Te mando el presupuesto?");
        }
      }
      break;
    case "actualizar_ubicacion":
      if (decision.ubicacion_valor && !session.pedido.ubicacion) {
        session.pedido.ubicacion = decision.ubicacion_valor;
        await enviarMensaje(from, `Quedó registrado: ${decision.ubicacion_valor}.`);
        
        // Si la ubicación es Némocon, ofrecer el Maps REAL
        if (decision.ubicacion_valor.toLowerCase().includes("némocon") || decision.ubicacion_valor.toLowerCase() === "nemocon") {
          await enviarMensaje(from, "Perfecto, aquí está la ubicación exacta para que pases a recoger o coordines el envío:");
          await enviarMensaje(from, "https://maps.app.goo.gl/m2nUV7zG5GbjLV8q6"); // Enlace REAL
        }
        
        // Verificar si ya tenemos todos los datos para cotizar
        if (session.pedido.productoNombre && session.pedido.cantidad) {
          await enviarMensaje(from, "Listo, ya tengo todo. ¿Quieres la cotización?");
        }
      }
      break;
    default:
      break;
  }
}

// WEBHOOKS de WhatsApp
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
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
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
    console.log(`[Mensaje de ${from}]: ${text}`);

    if (!sessions.has(from)) {
      sessions.set(from, {
        history: [],
        presentado: false,
        pedido: JSON.parse(JSON.stringify(defaultPedido)),
        cotizacionOfrecida: false
      });
    }
    const session = sessions.get(from);

    const esPrimerMensaje = !session.presentado;
    const esSoloSaludo = /^(hola|buenas|dime|hey|qué hubo|qué más|saludos|qué tal|veci|jaja|epa)$/i.test(text.trim());

    if (esPrimerMensaje && esSoloSaludo) {
      session.presentado = true;
      await enviarMensaje(from, "¡Hola! ¿Cómo vas? Cuéntame qué estás buscando, si adoquines, fachaletas o algún otro producto, con gusto te ayudo.");
      session.history.push({ role: "assistant", content: "¡Hola! ¿Cómo vas? Cuéntame..." });
      return res.sendStatus(200);
    }

    if (!session.presentado) session.presentado = true;

    await procesarConIA(text, from, session);

    res.sendStatus(200);
  } catch (error) {
    console.error("Error en webhook:", error);
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor Ana escuchando en el puerto ${PORT}`);
});
