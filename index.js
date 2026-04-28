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

// Estado inicial del pedido - NADA se asume, todo empieza en null
const defaultPedido = {
  productoId: null,
  productoNombre: null,
  tonalidad: null,
  cantidad: null,
  ubicacion: null,
  tonosDisponibles: [],
  modoRecoge: false,  // true si el usuario quiere recoger en fábrica
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

// Mostrar catálogo SOLO cuando el usuario no especifica producto
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

// Extraer producto del mensaje (prioriza referencias como "20x10x6" o nombres del catálogo)
function extraerProducto(texto) {
  const lower = texto.toLowerCase();
  // Buscar patrones de medidas: 20x10x6, 20*10*6, 20x10x8, etc.
  const medidaMatch = lower.match(/(\d+)\s*[x*]\s*(\d+)\s*[x*]\s*(\d+)/);
  if (medidaMatch) {
    const medida = `${medidaMatch[1]}x${medidaMatch[2]}x${medidaMatch[3]}`;
    // Buscar en catálogo
    for (const [id, prod] of Object.entries(catalogo)) {
      if (id.includes(medida) || prod.nombre.includes(medida)) {
        return { id, nombre: prod.nombre, tonos: prod.tonos || [] };
      }
    }
  }
  // Buscar por nombre exacto o parcial
  for (const [id, prod] of Object.entries(catalogo)) {
    if (lower.includes(prod.nombre.toLowerCase())) {
      return { id, nombre: prod.nombre, tonos: prod.tonos || [] };
    }
  }
  return null;
}

// Extraer cantidad explícita (solo números sueltos, no los que están dentro de una medida)
function extraerCantidad(texto, productoExtraido) {
  // Si el texto contiene una medida como 20x10x6, eliminar esa parte para no confundir
  let textoLimpio = texto;
  if (productoExtraido && productoExtraido.nombre) {
    const medidaPattern = productoExtraido.nombre.match(/\d+x\d+x\d+/);
    if (medidaPattern) {
      textoLimpio = texto.replace(medidaPattern[0], "");
    }
  }
  // También eliminar patrones de medidas sueltas
  textoLimpio = textoLimpio.replace(/\d+[x*]\d+[x*]\d+/g, "");
  
  // Buscar números
  const match = textoLimpio.match(/\b(\d{1,3}(?:[.,]\d{3})*)\b/);
  if (match) {
    let numStr = match[1].replace(/\./g, '').replace(',', '');
    const numero = parseInt(numStr, 10);
    if (!isNaN(numero) && numero > 0 && numero < 1000000) return numero;
  }
  return null;
}

// Detectar si pregunta por ubicación de fábrica o quiere recoger
function detectarIntencionUbicacion(texto) {
  const lower = texto.toLowerCase();
  if (/dónde queda|en qué parte|ubicación de la fábrica|dirección de la planta|dónde lo puedo recoger|pasar a recoger|en que parte lo puedo recoger|recogerlo|lo recojo|pasaré a recoger|paso a recoger/i.test(lower)) {
    return "recoger";
  }
  if (/env(?:í|i)o|mandar|llevar|domicilio|entregar/i.test(lower)) {
    return "envio";
  }
  return null;
}

// Función principal que maneja el flujo paso a paso
async function manejarConversacion(textoUsuario, from, session) {
  const pedido = session.pedido;
  
  // Guardar historial
  session.history.push({ role: "user", content: textoUsuario });
  if (session.history.length > 12) session.history = session.history.slice(-12);

  // ========== PASO 1: Detectar o preguntar PRODUCTO ==========
  if (!pedido.productoId) {
    const producto = extraerProducto(textoUsuario);
    if (producto) {
      pedido.productoId = producto.id;
      pedido.productoNombre = producto.nombre;
      pedido.tonosDisponibles = producto.tonos;
      await enviarImagenes(from, producto.id);
      // Preguntar color si tiene tonos
      if (pedido.tonosDisponibles.length > 0) {
        await enviarMensaje(from, `¿De qué color lo quieres? Tenemos ${pedido.tonosDisponibles.join(", ")}.`);
      } else {
        // Si no tiene tonos, pasar a cantidad
        await enviarMensaje(from, "¿Cuántas unidades necesitas?");
      }
      return;
    } else {
      // No se detectó producto, mostrar catálogo
      await mostrarCatalogoHumano(from);
      return;
    }
  }

  // ========== PASO 2: Detectar o preguntar COLOR (si aplica) ==========
  if (pedido.tonosDisponibles.length > 0 && !pedido.tonalidad) {
    const lower = textoUsuario.toLowerCase();
    let tonoEncontrado = null;
    for (const tono of pedido.tonosDisponibles) {
      if (lower.includes(tono.toLowerCase())) {
        tonoEncontrado = tono;
        break;
      }
    }
    if (tonoEncontrado) {
      pedido.tonalidad = tonoEncontrado;
      await enviarMensaje(from, `Perfecto, ${tonoEncontrado}. ¿Cuántas unidades necesitas?`);
      return;
    } else {
      await enviarMensaje(from, `No entendí el color. Tenemos ${pedido.tonosDisponibles.join(", ")}. ¿Cuál prefieres?`);
      return;
    }
  }

  // ========== PASO 3: Detectar o preguntar CANTIDAD ==========
  if (pedido.cantidad === null) {
    const cantidad = extraerCantidad(textoUsuario, { nombre: pedido.productoNombre });
    if (cantidad !== null) {
      pedido.cantidad = cantidad;
      await enviarMensaje(from, `Ok, ${cantidad} unidades. Ahora, ¿dónde te lo mandamos? (Si es en Némocon puedes pasar a recoger, dime si prefieres envío o recogida)`);
      return;
    } else {
      await enviarMensaje(from, "¿Cuántas unidades necesitas?");
      return;
    }
  }

  // ========== PASO 4: Detectar o preguntar UBICACIÓN ==========
  if (!pedido.ubicacion) {
    const intencion = detectarIntencionUbicacion(textoUsuario);
    
    if (intencion === "recoger") {
      pedido.modoRecoge = true;
      pedido.ubicacion = "Recoge en fábrica - Némocon";
      await enviarMensaje(from, "Perfecto, aquí tienes la ubicación de la fábrica para que pases a recoger:");
      await enviarMensaje(from, "https://maps.app.goo.gl/m2nUV7zG5GbjLV8q6");
      // Ya tenemos todos los datos
      await finalizarPedido(from, session);
      return;
    }
    
    if (intencion === "envio") {
      await enviarMensaje(from, "Dame la dirección completa para el envío (calle, carrera, número, ciudad).");
      return;
    }
    
    // Si el usuario escribió una dirección (contiene calle, carrera, etc.)
    const lower = textoUsuario.toLowerCase();
    if (lower.match(/calle|carrera|diagonal|transversal|avenida|#|n[0-9]/)) {
      pedido.ubicacion = textoUsuario;
      await enviarMensaje(from, `Dirección guardada: ${textoUsuario}.`);
      await finalizarPedido(from, session);
      return;
    }
    
    // Si solo dijo una ciudad (Chía, Bogotá, etc.)
    const ciudadMatch = lower.match(/\b(chía|bogotá|medellín|cali|nemocon|sopo|cajicá|zipaquirá)\b/i);
    if (ciudadMatch) {
      pedido.ubicacion = ciudadMatch[0];
      await enviarMensaje(from, `¿Me das la dirección completa en ${ciudadMatch[0]}?`);
      return;
    }
    
    // Si no entendió, preguntar de nuevo
    await enviarMensaje(from, "¿Dónde te lo mandamos? Si es en Némocon puedes pasar a recoger, o dime la dirección para envío.");
    return;
  }

  // Si ya tenemos todos los datos, finalizar
  if (pedido.productoId && pedido.tonalidad && pedido.cantidad !== null && pedido.ubicacion) {
    await finalizarPedido(from, session);
    return;
  }
}

async function finalizarPedido(from, session) {
  const pedido = session.pedido;
  const producto = pedido.productoNombre;
  const color = pedido.tonalidad || "sin color específico";
  const cantidad = pedido.cantidad;
  const ubicacion = pedido.ubicacion;
  
  let beneficios = "";
  if (producto.includes("20x10x6")) {
    beneficios = " Este adoquín es ideal para entradas de carros y zonas de alto tránsito, súper resistente. Además, su color dura mucho tiempo sin decolorarse.";
  } else if (producto.includes("fachaleta")) {
    beneficios = " Es perfecta para fachadas elegantes, fácil de instalar y con acabado premium.";
  } else {
    beneficios = " Es un producto de excelente calidad, fabricado con materiales seleccionados.";
  }
  
  await enviarMensaje(from, `Listo, tengo tu pedido: ${producto}, color ${color}, ${cantidad} unidades, ${pedido.modoRecoge ? "lo recoges en fábrica" : `envío a ${ubicacion}`}.${beneficios} ¿Quieres que te prepare una cotización formal?`);
  
  // No resetear la sesión, solo marcar que ya se ofreció cotización
  session.cotizacionOfrecida = true;
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
    console.log(`[${from}]: ${text}`);

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
      await enviarMensaje(from, "🔄 Sesión reiniciada.");
      return res.sendStatus(200);
    }

    if (text === "#estado") {
      const p = session.pedido;
      await enviarMensaje(from, `Producto: ${p.productoNombre || "❌"}\nColor: ${p.tonalidad || "❌"}\nCantidad: ${p.cantidad ?? "❌"}\nUbicación: ${p.ubicacion || "❌"}`);
      return res.sendStatus(200);
    }

    // Saludo inicial
    const esPrimerMensaje = !session.presentado;
    const esSaludo = /^(hola|buenos días|buenas tardes|qué hubo|qué más|saludos|veci)$/i.test(text.trim());

    if (esPrimerMensaje && esSaludo) {
      session.presentado = true;
      await enviarMensaje(from, "¡Hola! Buenos días, ¿cómo vas? Cuéntame qué estás buscando (adoquines o fachaletas) y con gusto te ayudo.");
      return res.sendStatus(200);
    }

    if (!session.presentado) session.presentado = true;

    await manejarConversacion(text, from, session);

    res.sendStatus(200);
  } catch (error) {
    console.error("ERROR:", error.response?.data || error.message);
    res.sendStatus(200);
  }
});

app.get("/", (req, res) => res.send("Ana IA - Versión reestructurada"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));
