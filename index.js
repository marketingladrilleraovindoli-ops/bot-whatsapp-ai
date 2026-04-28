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

// Estado del pedido - todo comienza como null
const createEmptyPedido = () => ({
  productoId: null,
  productoNombre: null,
  tonalidad: null,
  cantidad: null,      // null = no preguntado aún
  ubicacion: null,
  tonosDisponibles: [],
  pasoActual: "producto" // producto -> color -> cantidad -> ubicacion -> listo
});

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

async function mostrarCatalogo(to, categoria) {
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

function encontrarProductoPorNombre(nombre) {
  const nombreLower = nombre.toLowerCase();
  for (const [id, prod] of Object.entries(catalogo)) {
    if (prod.nombre.toLowerCase().includes(nombreLower) || 
        nombreLower.includes(prod.nombre.toLowerCase()) ||
        nombreLower.includes(id.toLowerCase())) {
      return { id, ...prod };
    }
  }
  return null;
}

function detectarCantidad(texto) {
  const match = texto.match(/\b(\d{1,3}(?:[.,]\d{3})*|\d+)\b/);
  if (match) {
    let numStr = match[1].replace(/\./g, '').replace(',', '');
    const numero = parseInt(numStr, 10);
    if (!isNaN(numero) && numero > 0) return numero;
  }
  return null;
}

function detectarColor(texto, tonosDisponibles) {
  if (!tonosDisponibles || tonosDisponibles.length === 0) return null;
  const lower = texto.toLowerCase();
  for (const tono of tonosDisponibles) {
    if (lower.includes(tono.toLowerCase())) {
      return tono;
    }
  }
  return null;
}

async function enviarResumenCotizacion(to, pedido) {
  let beneficios = "";
  if (pedido.productoNombre?.includes("20x10x6")) {
    beneficios = " Este adoquín es ideal para entradas de carros y zonas de alto tránsito, súper resistente. El color dura mucho tiempo sin decolorarse.";
  } else if (pedido.productoNombre?.includes("fachaleta")) {
    beneficios = " Es perfecta para fachadas elegantes, fácil de instalar y con acabado premium.";
  }
  
  await enviarMensaje(to, `Listo, tengo tu pedido: ${pedido.productoNombre}, color ${pedido.tonalidad}, ${pedido.cantidad} unidades, ${pedido.ubicacion === "recoger" ? "lo recoges en la fábrica" : `envío a ${pedido.ubicacion}`}.${beneficios} ¿Quieres que te prepare una cotización formal?`);
}

// PROCESADOR PRINCIPAL - SIN IA para evitar comportamientos erráticos
async function procesarMensaje(texto, from, session) {
  const pedido = session.pedido;
  const lower = texto.toLowerCase();
  
  // Comandos de prueba
  if (texto === "#reset" || texto === "reset" || texto === "reiniciar") {
    session.pedido = createEmptyPedido();
    session.presentado = false;
    await enviarMensaje(from, "🔄 Sesión reiniciada. Ya puedes empezar de cero.");
    return;
  }
  
  if (texto === "#estado") {
    await enviarMensaje(from, `📊 Estado:
- Producto: ${pedido.productoNombre || "❌"}
- Color: ${pedido.tonalidad || "❌"}
- Cantidad: ${pedido.cantidad ?? "❌"}
- Ubicación: ${pedido.ubicacion || "❌"}
- Paso: ${pedido.pasoActual}`);
    return;
  }
  
  // ========== FLUJO PRINCIPAL ==========
  
  // PASO 0: Saludo inicial
  if (!session.presentado && /^(hola|buenos días|buenas|qué hubo|epa|veci)/i.test(lower)) {
    session.presentado = true;
    await enviarMensaje(from, "¡Hola! Buenos días, ¿cómo vas? Cuéntame qué estás buscando, si adoquines, fachaletas o algún otro producto.");
    return;
  }
  
  // PASO PRODUCTO: Buscar producto mencionado
  if (pedido.pasoActual === "producto" || !pedido.productoNombre) {
    // Ver si mencionó un producto específico
    const producto = encontrarProductoPorNombre(texto);
    if (producto) {
      pedido.productoId = producto.id;
      pedido.productoNombre = producto.nombre;
      pedido.tonosDisponibles = producto.tonos || [];
      await enviarImagenes(from, producto.id);
      
      if (pedido.tonosDisponibles.length > 0) {
        pedido.pasoActual = "color";
        await enviarMensaje(from, `¿De qué color lo quieres? Tenemos ${pedido.tonosDisponibles.join(", ")}.`);
      } else {
        pedido.pasoActual = "cantidad";
        await enviarMensaje(from, "¿Cuántas unidades necesitas?");
      }
      return;
    }
    
    // Si no especificó producto, mostrar catálogo
    if (lower.includes("adoquin") || lower === "adoquines") {
      await mostrarCatalogo(from, "adoquines");
    } else if (lower.includes("fachaleta") || lower === "fachaletas") {
      await mostrarCatalogo(from, "fachaletas");
    } else {
      await enviarMensaje(from, "Cuéntame, ¿buscas adoquines o fachaletas? Así te muestro los modelos.");
    }
    return;
  }
  
  // PASO COLOR
  if (pedido.pasoActual === "color" && !pedido.tonalidad) {
    const color = detectarColor(texto, pedido.tonosDisponibles);
    if (color) {
      pedido.tonalidad = color;
      pedido.pasoActual = "cantidad";
      await enviarMensaje(from, `Perfecto, ${color}. ¿Cuántas unidades necesitas?`);
    } else {
      await enviarMensaje(from, `Ese color no lo tenemos. Los colores disponibles son: ${pedido.tonosDisponibles.join(", ")}. ¿Cuál te gusta?`);
    }
    return;
  }
  
  // PASO CANTIDAD
  if (pedido.pasoActual === "cantidad" && pedido.cantidad === null) {
    const cantidad = detectarCantidad(texto);
    if (cantidad !== null && cantidad > 0) {
      pedido.cantidad = cantidad;
      pedido.pasoActual = "ubicacion";
      await enviarMensaje(from, "¿Dónde te lo mandamos? Si es en Némocon, puedes pasar a recoger. Dame la dirección completa o dime si pasas a recoger.");
    } else {
      await enviarMensaje(from, "Dime cuántas unidades necesitas, así te ayudo con el precio. (Ej: 1000)");
    }
    return;
  }
  
  // PASO UBICACION
  if (pedido.pasoActual === "ubicacion" && !pedido.ubicacion) {
    // Detectar si pregunta por la ubicación de la fábrica
    if (/(dónde queda|ubicación de la fábrica|dónde lo puedo recoger|pasar a recoger|en qué parte)/i.test(lower)) {
      await enviarMensaje(from, "La fábrica está en Némocon. Aquí te mando la ubicación exacta:");
      await enviarMensaje(from, "https://maps.app.goo.gl/m2nUV7zG5GbjLV8q6");
      // No cambiamos el paso aún porque falta confirmar si recoge o envío
      await enviarMensaje(from, "¿Vas a pasar a recoger o prefieres que te lo enviemos a alguna dirección?");
      return;
    }
    
    // Detectar si dice que va a recoger
    if (/(paso a recoger|recoger|voy a recoger|lo recojo|recojo)/i.test(lower)) {
      pedido.ubicacion = "recoger";
      pedido.pasoActual = "listo";
      await enviarMensaje(from, "Perfecto, lo recoges en la fábrica.");
      await enviarResumenCotizacion(from, pedido);
      return;
    }
    
    // Detectar dirección (calle, carrera, Chía, etc.)
    const esDireccion = /(calle|cra|carrera|diagonal|transversal|avenida|chía|bogotá|nemocon|soacha|zipaquirá)/i.test(lower);
    if (esDireccion || lower.length > 5) {
      pedido.ubicacion = texto;
      pedido.pasoActual = "listo";
      await enviarMensaje(from, `Entendido, enviamos a: ${texto}`);
      await enviarResumenCotizacion(from, pedido);
      return;
    }
    
    await enviarMensaje(from, "¿Dónde te lo mandamos? Dame la dirección completa o dime si pasas a recoger a la fábrica.");
    return;
  }
  
  // Si el usuario quiere cambiar algo después de completar
  if (pedido.pasoActual === "listo") {
    if (/(cambiar|cotización|presupuesto)/i.test(lower)) {
      await enviarResumenCotizacion(from, pedido);
    } else {
      await enviarMensaje(from, "¿Quieres cambiar algo o necesitas la cotización?");
    }
    return;
  }
  
  // Fallback
  await enviarMensaje(from, "Cuéntame, ¿en qué puedo ayudarte? ¿Adoquines o fachaletas?");
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
        presentado: false,
        pedido: createEmptyPedido()
      });
    }
    const session = sessions.get(from);

    await procesarMensaje(text, from, session);

    res.sendStatus(200);
  } catch (error) {
    console.error("ERROR:", error.response?.data || error.message);
    res.sendStatus(200);
  }
});

app.get("/", (req, res) => res.send("Ana IA - Versión simplificada sin IA"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo puerto ${PORT}`));
