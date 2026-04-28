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

// Distancia de Levenshtein
function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[b.length][a.length];
}

// Normaliza vocales con tildes y elimina caracteres especiales para mejor comparación
function normalizarTextoColor(texto) {
  return texto
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z]/g, "");
}

// Encuentra el color más parecido dentro de una lista
function encontrarColorSimilar(texto, coloresDisponibles) {
  const textoNormalizado = normalizarTextoColor(texto);
  for (const color of coloresDisponibles) {
    if (normalizarTextoColor(color) === textoNormalizado) {
      return color;
    }
  }
  let mejorMatch = null;
  let menorDistancia = Infinity;
  for (const color of coloresDisponibles) {
    const distancia = levenshteinDistance(textoNormalizado, normalizarTextoColor(color));
    if (distancia < menorDistancia && distancia <= 3) {
      menorDistancia = distancia;
      mejorMatch = color;
    }
  }
  return mejorMatch;
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

async function mostrarCatalogoCompleto(to, soloAdoquines = false, soloFachaletas = false, mensajePersonalizado = null) {
  let productos = [];
  let intro = "";
  if (mensajePersonalizado) {
    await enviarMensaje(to, mensajePersonalizado);
  }
  if (soloAdoquines) {
    productos = Object.entries(catalogo).filter(([id]) => id.startsWith("adoquin"));
    intro = "📦 *Adoquines disponibles:*";
  } else if (soloFachaletas) {
    productos = Object.entries(catalogo).filter(([id]) => id.startsWith("fachaleta"));
    intro = "📦 *Fachaletas disponibles:*";
  } else {
    productos = Object.entries(catalogo);
    intro = "📦 *Catálogo completo:*";
  }
  await enviarMensaje(to, intro);

  let mensaje = "";
  for (const [id, prod] of productos) {
    mensaje += `- ${prod.nombre}`;
    if (prod.tonos && prod.tonos.length) mensaje += ` (colores: ${prod.tonos.join(", ")})`;
    mensaje += "\n";
  }
  mensaje += "\nEscribe el nombre o la medida que te interesa (ej: 20x10x6) y te muestro fotos.";
  await enviarMensaje(to, mensaje);
}

function buscarProducto(texto) {
  const lower = texto.toLowerCase();
  for (const [id, prod] of Object.entries(catalogo)) {
    const nombreLower = prod.nombre.toLowerCase();
    if (nombreLower === lower || nombreLower.includes(lower) || lower.includes(nombreLower)) {
      return { id, nombre: prod.nombre, tonos: prod.tonos || [] };
    }
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

function detectarCantidad(texto) {
  let cleanText = texto.replace(/\d+\s*[x*]\s*\d+\s*[x*]\s*\d+/g, '');
  const match = cleanText.match(/(\d{1,3}(?:[.,]\d{3})*|\d+)(?:\s*unidades?)?/);
  if (match) {
    let numStr = match[1].replace(/\./g, '').replace(',', '');
    const numero = parseInt(numStr, 10);
    if (!isNaN(numero) && numero > 0 && numero < 10000000) return numero;
  }
  return null;
}

// ==================== FUNCIÓN DE UBICACIÓN MEJORADA (VERSIÓN FINAL) ====================
async function procesarUbicacion(texto, to, session) {
  const lower = texto.toLowerCase().trim();
  
  // 1. Patrones para preguntar por la ubicación de la fábrica (recoger)
  // Incluye variaciones sin acentos, con "estan", "ubicados", etc.
  const recogerFabricaPatterns = [
    /recoger|pasar|retirar|fábrica|planta/i,
    /dónde\s+(?:queda|est[aá]n|estan|encuentro|puedo\s+recoger|est[aá]\s+ubicad[oa]s?)/i,
    /ubicación\s+(?:de\s+la\s+fábrica|de\s+la\s+planta)/i,
    /en\s+némocon\s+(?:para\s+recoger|lo\s+recojo|paso\s+a\s+recoger)/i,
    /dónde\s+(?:están|estan|está|esta)\s+ubicados/i,
    /dónde\s+es\s+que\s+están/i,
    /dirección\s+de\s+la\s+(?:fábrica|planta|empresa)/i,
    /dónde\s+queda\s+la\s+(?:fábrica|planta|empresa)/i,
    /ustedes\s+dónde\s+están/i,
    /en\s+qué\s+parte\s+están/i,
    /para\s+recoger\s+dónde\s+es/i,
    /puedo\s+ir\s+a\s+recoger/i,
    /donde\s+estan\s+ubicados/i,
    /donde\s+queda\s+la\s+fabrica/i,
    /donde\s+los\s+puedo\s+recoger/i
  ];
  
  const esPreguntaFabrica = recogerFabricaPatterns.some(pattern => pattern.test(lower));
  if (esPreguntaFabrica) {
    await enviarMensaje(to, "¡Perfecto! Puedes recoger en nuestra fábrica en Némocon. Aquí te mando la ubicación exacta:");
    await enviarMensaje(to, "https://maps.app.goo.gl/m2nUV7zG5GbjLV8q6");
    session.pedido.ubicacion = "Recogida en fábrica (Némocon)";
    return true;
  }
  
  // 2. Dirección completa (calle, carrera, etc.)
  const direccionPatterns = /(calle|carrera|avenida|av\.|cra\.|cl\.|diagonal|transversal|kilómetro|km)\s+[\d#\s\-\.]+/i;
  if (direccionPatterns.test(lower)) {
    session.pedido.ubicacion = texto;
    await enviarMensaje(to, `Dirección guardada: ${texto}`);
    return true;
  }
  
  // 3. Detectar ciudades (incluyendo errores comunes)
  const ciudades = [
    "chía", "chia", "bogotá", "bogota", "zipaquirá", "zipaquira", 
    "tocancipá", "tocancipa", "sopó", "sopo", "cajicá", "cajica", 
    "némocon", "nemocon", "madrid", "funza", "mosquera", "facatativá", "facatativa"
  ];
  
  const palabras = lower.split(/\s+/);
  let ciudadEncontrada = null;
  for (const palabra of palabras) {
    for (const ciudad of ciudades) {
      if (palabra === ciudad || palabra.includes(ciudad)) {
        ciudadEncontrada = ciudad;
        break;
      }
    }
    if (ciudadEncontrada) break;
  }
  
  if (ciudadEncontrada) {
    session.pedido.ubicacion = ciudadEncontrada;
    if (ciudadEncontrada === "némocon" || ciudadEncontrada === "nemocon") {
      await enviarMensaje(to, "Perfecto, puedes recoger en nuestra fábrica en Némocon. Aquí te mando la ubicación:");
      await enviarMensaje(to, "https://maps.app.goo.gl/m2nUV7zG5GbjLV8q6");
      session.pedido.ubicacion = "Recogida en fábrica (Némocon)";
      return true;
    } else {
      await enviarMensaje(to, `Entendido, ${ciudadEncontrada}. ¿Me das la dirección completa para el envío?`);
      return false;
    }
  }
  
  // 4. Si no entendió nada
  await enviarMensaje(to, "No entendí bien la ubicación. Dime si quieres recoger en nuestra fábrica (Némocon) o escríbeme la dirección completa para envío (ej: Calle 10 # 20-30, Chía).");
  return false;
}
// =======================================================================

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

async function procesarConIA(textoUsuario, from, session) {
  session.history.push({ role: "user", content: textoUsuario });
  if (session.history.length > 12) session.history = session.history.slice(-12);

  // 1. Si no hay producto seleccionado
  if (!session.pedido.productoId) {
    const producto = buscarProducto(textoUsuario);
    if (producto) {
      session.pedido.productoId = producto.id;
      session.pedido.productoNombre = producto.nombre;
      session.pedido.tonosDisponibles = producto.tonos;
      await enviarImagenes(from, producto.id);
      if (producto.tonos && producto.tonos.length > 0) {
        await enviarMensaje(from, `Hermoso, el ${producto.nombre}. ¿De qué color lo quieres? Tenemos ${producto.tonos.join(", ")}.`);
        return;
      } else {
        await enviarMensaje(from, `¿Cuántas unidades necesitas?`);
        return;
      }
    } else {
      await mostrarCatalogoCompleto(from, false, false, "Esa medida o referencia no la manejamos. Mira nuestro catálogo a ver si alguna te sirve:");
      return;
    }
  }

  // 2. Si tiene producto pero no tonalidad
  if (session.pedido.productoId && !session.pedido.tonalidad && session.pedido.tonosDisponibles.length > 0) {
    let colorEncontrado = null;
    for (const color of session.pedido.tonosDisponibles) {
      if (normalizarTextoColor(textoUsuario) === normalizarTextoColor(color)) {
        colorEncontrado = color;
        break;
      }
    }
    if (!colorEncontrado) {
      colorEncontrado = encontrarColorSimilar(textoUsuario, session.pedido.tonosDisponibles);
    }
    if (colorEncontrado) {
      session.pedido.tonalidad = colorEncontrado;
      await enviarMensaje(from, `Perfecto, ${colorEncontrado}. ¿Cuántas unidades necesitas?`);
      return;
    } else {
      await enviarMensaje(from, `No reconozco ese color. Tenemos ${session.pedido.tonosDisponibles.join(", ")}. ¿Cuál prefieres?`);
      return;
    }
  }

  // 3. Si falta la cantidad
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
      if (session.pedido.productoNombre && session.pedido.tonalidad && session.pedido.cantidad !== null && session.pedido.ubicacion) {
        await mostrarResumenYcotizacion(from, session);
      }
      return;
    }
    return;
  }

  // 5. Ya tiene todos los datos
  if (!session.cotizacionOfrecida) {
    await mostrarResumenYcotizacion(from, session);
  } else {
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

app.get("/", (req, res) => res.send("Ana IA - Versión final con detección de ubicación robusta"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo puerto ${PORT}`));
