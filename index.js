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

// Muestra el catálogo completo o por categoría
async function mostrarCatalogoCompleto(to, soloAdoquines = false, soloFachaletas = false) {
  let productos = [];
  if (soloAdoquines) {
    productos = Object.entries(catalogo).filter(([id]) => id.startsWith("adoquin"));
    await enviarMensaje(to, "📦 *Adoquines disponibles:*");
  } else if (soloFachaletas) {
    productos = Object.entries(catalogo).filter(([id]) => id.startsWith("fachaleta"));
    await enviarMensaje(to, "📦 *Fachaletas disponibles:*");
  } else {
    productos = Object.entries(catalogo);
    await enviarMensaje(to, "📦 *Catálogo completo:*");
  }

  let mensaje = "";
  for (const [id, prod] of productos) {
    mensaje += `- ${prod.nombre}`;
    if (prod.tonos && prod.tonos.length) mensaje += ` (colores: ${prod.tonos.join(", ")})`;
    mensaje += "\n";
  }
  mensaje += "\nEscribe el nombre o la medida que te interesa (ej: 20x10x6) y te muestro fotos.";
  await enviarMensaje(to, mensaje);
}

// Buscar producto por nombre o medida
function buscarProducto(texto) {
  const lower = texto.toLowerCase();
  for (const [id, prod] of Object.entries(catalogo)) {
    const nombreLower = prod.nombre.toLowerCase();
    // Buscar coincidencia exacta o parcial
    if (nombreLower === lower || nombreLower.includes(lower) || lower.includes(nombreLower)) {
      return { id, nombre: prod.nombre, tonos: prod.tonos || [] };
    }
    // Buscar por medida (ej: 20x10x6)
    const medidaMatch = lower.match(/(\d+)\s*[x*]\s*(\d+)\s*[x*]\s*(\d+)/);
    if (medidaMatch) {
      const medida = `${medidaMatch[1]}x${medidaMatch[2]}x${medidaMatch[3]}`;
      if (nombreLower.includes(medida)) {
        return { id, nombre: prod.nombre, tonos: prod.tonos || [] };
      }
    }
  }
  return null;
}

// Detectar cantidad (solo números, ignorando los que son parte de una medida)
function detectarCantidad(texto) {
  // Eliminar posibles medidas del texto para no confundir
  let cleanText = texto.replace(/\d+\s*[x*]\s*\d+\s*[x*]\s*\d+/g, '');
  // Buscar números aislados o con separadores de miles
  const match = cleanText.match(/(\d{1,3}(?:[.,]\d{3})*(?:\.\d+)?)/);
  if (match) {
    let numStr = match[1].replace(/\./g, '').replace(',', '');
    const numero = parseInt(numStr, 10);
    if (!isNaN(numero) && numero > 0 && numero < 10000000) return numero;
  }
  return null;
}

// Procesar ubicación con lógica simple
async function procesarUbicacion(texto, to, session) {
  const lower = texto.toLowerCase();
  // Patrones de recogida en fábrica
  const recogerPatterns = /recoger|pasar|retirar|fábrica|planta|dónde queda|ubicación|dirección\s*de\s*la\s*fábrica|en\s*némocon\s*(?:para\s*recoger|lo\s*recojo|paso\s*a\s*recoger)/i;
  if (recogerPatterns.test(lower) && !lower.match(/calle|carrera|avenida|dirección\s+(\d+)/i)) {
    // Quiere recoger en la fábrica
    await enviarMensaje(to, "¡Perfecto! Puedes recoger en nuestra fábrica en Némocon. Aquí te mando la ubicación exacta:");
    await enviarMensaje(to, "https://maps.app.goo.gl/m2nUV7zG5GbjLV8q6");
    session.pedido.ubicacion = "Recogida en fábrica (Némocon)";
    return true;
  }
  // Si da una dirección con calle/carrera/número
  const direccionPatterns = /(calle|carrera|avenida|av\.|cra\.|cl\.|diagonal|transversal)\s+[\d#\s\-]+/i;
  if (direccionPatterns.test(lower)) {
    session.pedido.ubicacion = texto;
    await enviarMensaje(to, `Dirección guardada: ${texto}`);
    return true;
  }
  // Si solo da una ciudad (sin dirección)
  const ciudadMatch = lower.match(/^(chía|bogotá|zipaquirá|tocancipá|sopo|cajicá|nemocon)$/i);
  if (ciudadMatch) {
    session.pedido.ubicacion = ciudadMatch[0];
    await enviarMensaje(to, `Entendido, ${ciudadMatch[0]}. ¿Me das la dirección completa?`);
    return false; // Aún falta dirección
  }
  // Si no se pudo determinar, preguntar de nuevo
  await enviarMensaje(to, "No entendí bien la ubicación. Dime si quieres recoger en nuestra fábrica (Némocon) o escríbeme la dirección completa para envío.");
  return false;
}

// Mostrar resumen final y ofrecer cotización
async function mostrarResumenYcotizacion(to, session) {
  const { productoNombre, tonalidad, cantidad, ubicacion } = session.pedido;
  let beneficios = "";
  if (productoNombre.includes("20x10x6")) {
    beneficios = " Este adoquín es ideal para entradas de carros y zonas de alto tránsito, súper resistente. Además, su color dura mucho tiempo sin decolorarse.";
  } else if (productoNombre.includes("fachaleta")) {
    beneficios = " Perfecta para fachadas elegantes, fácil instalación y acabado premium.";
  } else if (productoNombre.includes("ecológico")) {
    beneficios = " Amigable con el ambiente y de gran durabilidad.";
  } else {
    beneficios = " Producto de excelente calidad, fabricado con materiales seleccionados.";
  }
  await enviarMensaje(to, `Listo, tengo tu pedido: ${productoNombre}, color ${tonalidad}, ${cantidad} unidades, ${ubicacion}.${beneficios} ¿Quieres que te prepare una cotización formal?`);
  session.cotizacionOfrecida = true;
}

// Función principal que procesa el mensaje con IA (simplificada, pero aún usamos GPT para respuestas naturales)
async function procesarConIA(textoUsuario, from, session) {
  session.history.push({ role: "user", content: textoUsuario });
  if (session.history.length > 12) session.history = session.history.slice(-12);

  // 1. Si no hay producto seleccionado, buscar en el mensaje
  if (!session.pedido.productoId) {
    const producto = buscarProducto(textoUsuario);
    if (producto) {
      session.pedido.productoId = producto.id;
      session.pedido.productoNombre = producto.nombre;
      session.pedido.tonosDisponibles = producto.tonos;
      // Enviar fotos
      await enviarImagenes(from, producto.id);
      // Preguntar tonalidad si tiene colores
      if (producto.tonos && producto.tonos.length > 0) {
        await enviarMensaje(from, `Hermoso, el ${producto.nombre}. ¿De qué color lo quieres? Tenemos ${producto.tonos.join(", ")}.`);
        return;
      } else {
        // No tiene tonos, pasar a preguntar cantidad directamente
        await enviarMensaje(from, `¿Cuántas unidades necesitas?`);
        return;
      }
    } else {
      // No se encontró el producto, mostrar catálogo
      await mostrarCatalogoCompleto(from);
      return;
    }
  }

  // 2. Si ya tiene producto pero no tonalidad y hay tonos disponibles
  if (session.pedido.productoId && !session.pedido.tonalidad && session.pedido.tonosDisponibles.length > 0) {
    const colorValido = session.pedido.tonosDisponibles.find(t => textoUsuario.toLowerCase().includes(t.toLowerCase()));
    if (colorValido) {
      session.pedido.tonalidad = colorValido;
      await enviarMensaje(from, `Perfecto, ${colorValido}. ¿Cuántas unidades necesitas?`);
      return;
    } else {
      await enviarMensaje(from, `No reconozco ese color. Tenemos ${session.pedido.tonosDisponibles.join(", ")}. ¿Cuál prefieres?`);
      return;
    }
  }

  // 3. Si falta la cantidad (es null)
  if (session.pedido.cantidad === null) {
    const cantidad = detectarCantidad(textoUsuario);
    if (cantidad !== null && cantidad > 0) {
      session.pedido.cantidad = cantidad;
      await enviarMensaje(from, `Ok, ${cantidad} unidades. ¿Dónde te lo mandamos? (Si es en Némocon puedes pasar a recoger; dime si prefieres envío o recogida)`);
      return;
    } else {
      await enviarMensaje(from, "Dime cuántas unidades necesitas (ej: 500, 1000, 10.000).");
      return;
    }
  }

  // 4. Si falta la ubicación
  if (!session.pedido.ubicacion) {
    const resultado = await procesarUbicacion(textoUsuario, from, session);
    if (resultado === true) {
      // Ubicación guardada exitosamente, ahora ver si ya tenemos todos los datos
      if (session.pedido.productoNombre && session.pedido.tonalidad && session.pedido.cantidad !== null && session.pedido.ubicacion) {
        await mostrarResumenYcotizacion(from, session);
      } else {
        // Por seguridad, si algo falta, preguntar de nuevo (no debería pasar)
        await enviarMensaje(from, "Listo, ya tengo la ubicación. Ahora necesito los otros datos.");
      }
      return;
    }
    // Si resultado es false, es porque pidió dirección adicional (solo ciudad) y ya se envió el mensaje, no hacemos nada más.
    return;
  }

  // 5. Ya tiene todos los datos, ofrecer cotización si no se ha ofrecido
  if (!session.cotizacionOfrecida) {
    await mostrarResumenYcotizacion(from, session);
  } else {
    // Si el usuario sigue escribiendo después de la cotización, responder amablemente
    await enviarMensaje(from, "¿Necesitas algo más? Con gusto te ayudo.");
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
      await enviarMensaje(from, "¡Hola! Buenos días, ¿cómo vas? Cuéntame qué estás buscando (adoquines o fachaletas) y te ayudo.");
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

app.get("/", (req, res) => res.send("Ana IA - Versión simplificada y robusta"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo puerto ${PORT}`));
