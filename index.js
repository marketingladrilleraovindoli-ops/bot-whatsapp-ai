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

const defaultPedido = {
  productoId: null,
  productoNombre: null,
  tonalidad: null,
  cantidad: null,
  ubicacion: null,
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

// Función para preguntar el siguiente dato faltante (orden: color -> cantidad -> ubicación)
async function preguntarSiguienteDato(to, session) {
  if (!session.pedido.productoNombre) {
    await mostrarCatalogoHumano(to);
    return;
  }
  if (session.pedido.tonosDisponibles.length > 0 && !session.pedido.tonalidad) {
    await enviarMensaje(to, `¿De qué color lo quieres? Tenemos ${session.pedido.tonosDisponibles.join(", ")}.`);
    return;
  }
  if (!session.pedido.cantidad) {
    await enviarMensaje(to, "¿Cuántas unidades necesitas? (Ej: 10.000) Así te ayudo con el precio.");
    return;
  }
  if (!session.pedido.ubicacion) {
    await enviarMensaje(to, "¿Dónde te lo mandamos? Si es en Némocon, puedes pasar a recoger o te enviamos. Dame la dirección completa.");
    return;
  }
  // Si ya tiene todo
  await enviarMensaje(to, `Listo, ya tengo tu pedido: ${session.pedido.productoNombre}, ${session.pedido.tonalidad || "color a definir"}, ${session.pedido.cantidad} unidades, envío a ${session.pedido.ubicacion}. ¿Quieres que te prepare la cotización?`);
  session.cotizacionOfrecida = true;
}

async function enviarImagenesYContinuar(to, productoId, session) {
  const item = catalogo[productoId];
  if (!item) {
    await enviarMensaje(to, "Ese no lo conozco, ¿me dices el nombre exacto?");
    return;
  }
  await enviarImagenes(to, productoId);
  session.pedido.productoId = productoId;
  session.pedido.productoNombre = item.nombre;
  session.pedido.tonosDisponibles = item.tonos || [];
  
  await preguntarSiguienteDato(to, session);
}

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

function detectarCambioUbicacion(texto, session) {
  const lower = texto.toLowerCase();
  // Si el usuario dice "mejor envíamelo a X", "cambio a X", "prefiero en X"
  if (lower.includes("mejor") || lower.includes("cambio") || lower.includes("prefiero") || lower.includes("en lugar de")) {
    // Extraer posible ubicación (palabras después de "a", "en", "para")
    const match = lower.match(/\b(?:a|en|para)\s+([a-záéíóúñ\s]+)$/i);
    if (match && match[1].trim().length > 0) {
      return match[1].trim();
    }
  }
  return null;
}

async function procesarConIA(textoUsuario, from, session) {
  session.history.push({ role: "user", content: textoUsuario });
  if (session.history.length > 12) session.history = session.history.slice(-12);

  // Detectar correcciones de ubicación
  const nuevaUbicacion = detectarCambioUbicacion(textoUsuario, session);
  if (nuevaUbicacion && session.pedido.ubicacion) {
    // El usuario quiere cambiar la ubicación
    session.pedido.ubicacion = nuevaUbicacion;
    await enviarMensaje(from, `Ah ok, entonces lo enviamos a ${nuevaUbicacion}. ¿Me das la dirección completa?`);
    // No llamamos a preguntarSiguienteDato aquí porque ya tenemos la ubicación pero no la dirección completa? Mejor esperar siguiente mensaje
    session.history.push({ role: "assistant", content: `Ah ok, entonces lo enviamos a ${nuevaUbicacion}. ¿Me das la dirección completa?` });
    return;
  }

  // Detectar cantidad en el mensaje
  const nuevaCantidad = detectarCantidad(textoUsuario);
  if (nuevaCantidad !== null && !session.pedido.cantidad) {
    session.pedido.cantidad = nuevaCantidad;
  }

  // Estado actual para la IA
  const estadoPedido = `
DATOS ACTUALES:
- Producto: ${session.pedido.productoNombre || "ninguno"}
- Color: ${session.pedido.tonalidad || "ninguno"}
- Cantidad: ${session.pedido.cantidad || "ninguna"}
- Ubicación: ${session.pedido.ubicacion || "ninguna"}

FALTAN (en orden):
${!session.pedido.productoNombre ? "- producto" : ""}
${(!session.pedido.tonalidad && session.pedido.tonosDisponibles.length > 0) ? "- color (" + session.pedido.tonosDisponibles.join(", ") + ")" : ""}
${!session.pedido.cantidad ? "- cantidad" : ""}
${!session.pedido.ubicacion ? "- dirección de envío" : ""}
`;

  const catalogoInfo = Object.entries(catalogo)
    .map(([id, prod]) => `id: ${id}, nombre: ${prod.nombre}`)
    .join("\n");

  const systemPrompt = `
Eres Ana, una asesora de ventas de Ladrillera La Toscana (Némocon, Colombia). Hablas como una persona normal, cálida, usas "jaja", "uy", "dale", "listo", "epa", "qué más", "veci". Tus respuestas son cortas, con emojis ocasionales pero no en exceso. Evitas palabras robóticas como "anotado", "procesar", "formal", "registrado". En lugar de "Listo, durazno" dices "Durazno, buena elección" o "Ok perfecto". En lugar de "Quedó registrado: Némocon" dices "Perfecto, Némocon".

${estadoPedido}

INSTRUCCIONES ESTRICTAS:
- SIEMPRE saluda si el usuario dice "hola", "buenos días", etc. Responde con un saludo y luego pregunta qué busca.
- Si el usuario pide "adoquines" o "fachaletas", usa acción "mostrar_adoquines" o "mostrar_fachaletas".
- Si da el nombre de un producto (ej: "20x10x6"), usa "enviar_imagenes".
- Si da un color (ej: "durazno"), usa "actualizar_tonalidad".
- Si da una cantidad (ej: "100", "10.000"), usa "actualizar_cantidad".
- Si da una dirección o dice "Némocon" o una ciudad, usa "actualizar_ubicacion".
- Si el usuario intenta corregir o cambiar algo (ej: "mejor en Chía"), debes detectarlo y actualizar el campo correspondiente.
- NUNCA asumas una cantidad si no la ha dado.
- Después de actualizar un dato, NO preguntes el siguiente por tu cuenta; la función preguntarSiguienteDato se encargará. Tú solo confirma con una frase humana.
- Tus respuestas deben ser muy humanas: "Durazno, me encanta", "Ok, te lo envío a Chía", "¿Cuántas unidades quieres?".

Responde SOLO con JSON:
{
  "respuesta": "texto corto y humano (puede ser vacío)",
  "accion": "nada" | "mostrar_adoquines" | "mostrar_fachaletas" | "enviar_imagenes" | "actualizar_tonalidad" | "actualizar_cantidad" | "actualizar_ubicacion",
  "producto_id": "",
  "tonalidad_valor": "",
  "cantidad_valor": 0,
  "ubicacion_valor": ""
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

  // Enviar respuesta si existe
  if (decision.respuesta && decision.respuesta.trim() !== "") {
    await enviarMensaje(from, decision.respuesta);
    session.history.push({ role: "assistant", content: decision.respuesta });
  }

  // Ejecutar acción
  switch (decision.accion) {
    case "mostrar_adoquines":
      await mostrarCatalogoHumano(from, "adoquines");
      break;
    case "mostrar_fachaletas":
      await mostrarCatalogoHumano(from, "fachaletas");
      break;
    case "enviar_imagenes":
      if (decision.producto_id && catalogo[decision.producto_id]) {
        await enviarImagenesYContinuar(from, decision.producto_id, session);
      } else {
        await enviarMensaje(from, "Ese no aparece, ¿seguro que está en la lista?");
      }
      break;
    case "actualizar_tonalidad":
      if (decision.tonalidad_valor) {
        session.pedido.tonalidad = decision.tonalidad_valor;
        await enviarMensaje(from, `¡Perfecto! ${decision.tonalidad_valor}.`); // más humano
        await preguntarSiguienteDato(from, session);
      }
      break;
    case "actualizar_cantidad":
      if (decision.cantidad_valor && !session.pedido.cantidad) {
        session.pedido.cantidad = decision.cantidad_valor;
        await enviarMensaje(from, `Ok, ${decision.cantidad_valor} unidades.`);
        await preguntarSiguienteDato(from, session);
      }
      break;
    case "actualizar_ubicacion":
      if (decision.ubicacion_valor && !session.pedido.ubicacion) {
        session.pedido.ubicacion = decision.ubicacion_valor;
        await enviarMensaje(from, `Entendido, ${decision.ubicacion_valor}.`);
        if (decision.ubicacion_valor.toLowerCase().includes("némocon") || decision.ubicacion_valor.toLowerCase() === "nemocon") {
          await enviarMensaje(from, "Aquí tienes la ubicación de la fábrica para que pases a recoger:");
          await enviarMensaje(from, "https://maps.app.goo.gl/m2nUV7zG5GbjLV8q6");
        }
        await preguntarSiguienteDato(from, session);
      }
      break;
    default:
      if (!session.pedido.productoNombre || !session.pedido.cantidad || !session.pedido.ubicacion) {
        await preguntarSiguienteDato(from, session);
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

    const esPrimerMensaje = !session.presentado;
    const esSaludo = /^(hola|buenos días|buenas tardes|buenas noches|qué hubo|qué más|saludos|hey|epa|veci)$/i.test(text.trim());

    if (esPrimerMensaje && esSaludo) {
      session.presentado = true;
      await enviarMensaje(from, "¡Hola! Buenos días, ¿cómo vas? Cuéntame qué estás buscando, si adoquines, fachaletas o algún otro producto, con gusto te ayudo.");
      session.history.push({ role: "assistant", content: "¡Hola! Buenos días..." });
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

app.get("/", (req, res) => res.send("Ana IA - Versión humana final"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo puerto ${PORT}`));
