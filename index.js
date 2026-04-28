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
  modoEntrega: null, // "recoger" o "envio"
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
    await enviarMensaje(to, "Ay, todavía no tengo fotos de ese producto. ¿Te interesa otro similar?");
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

// Detectar referencia de producto (formato como 20x10x6, 20*10*6, 24x12x6, etc.)
function detectarReferencia(texto) {
  // Busca patrones como 20x10x6, 20*10*6, 20*10*3, 24x12x6, etc.
  const match = texto.match(/(\d{1,2})\s*[x*]\s*(\d{1,2})\s*[x*]\s*(\d{1,2})/i);
  if (match) {
    const medida = `${match[1]}x${match[2]}x${match[3]}`;
    // Buscar en catálogo
    for (const [id, prod] of Object.entries(catalogo)) {
      if (id.includes(medida) || prod.nombre.includes(medida)) {
        return { productoId: id, productoNombre: prod.nombre, medida };
      }
    }
    return null; // No encontrado
  }
  // También puede ser nombre como "adoquín corbatín"
  for (const [id, prod] of Object.entries(catalogo)) {
    if (texto.includes(prod.nombre.toLowerCase())) {
      return { productoId: id, productoNombre: prod.nombre, medida: null };
    }
  }
  return null;
}

// Detectar cantidad (números sueltos, 1000, 10.000, etc.) pero NO si forma parte de una referencia
function detectarCantidad(texto, referenciaDetectada) {
  // Si la cantidad ya fue detectada antes, no volver
  // Primero, eliminar la referencia del texto para no confundir
  let textoLimpio = texto;
  if (referenciaDetectada && referenciaDetectada.medida) {
    const refRegex = new RegExp(referenciaDetectada.medida.replace(/x/g, '[x*]'), 'i');
    textoLimpio = textoLimpio.replace(refRegex, '');
  }
  // Buscar números: 1000, 10.000, 100,000, 1000, etc.
  const match = textoLimpio.match(/(\d{1,3}(?:[.,]\d{3})*|\d+)/);
  if (match) {
    let numStr = match[1].replace(/\./g, '').replace(',', '');
    const numero = parseInt(numStr, 10);
    if (!isNaN(numero) && numero > 0 && numero < 1000000) return numero;
  }
  return null;
}

// Detectar modo de entrega
function detectarModoEntrega(texto) {
  const lower = texto.toLowerCase();
  if (/(paso a recoger|lo recojo|voy a recoger|recogeré|recojo en fábrica|recojo en planta|pasaré a recoger)/i.test(lower)) {
    return "recoger";
  }
  if (/(envío|envíen|mandar|enviar a domicilio|llevar a|entregar en)/i.test(lower)) {
    return "envio";
  }
  return null;
}

// Detectar ubicación específica (dirección o ciudad)
function detectarUbicacion(texto) {
  const lower = texto.toLowerCase();
  // Si es recoger, no necesitamos dirección completa
  if (detectarModoEntrega(texto) === "recoger") return "recoger_en_fabrica";
  // Buscar patrones de dirección: calle, carrera, #, etc.
  if (/(calle|cra|carrera|av|avenida|diagonal|transversal|#|n°)/i.test(lower)) {
    return texto; // devolvemos el texto original como dirección
  }
  // Ciudades conocidas
  const ciudades = ["chía", "nemocon", "bogotá", "cajicá", "zipaquirá", "tocancipá"];
  for (const ciudad of ciudades) {
    if (lower.includes(ciudad)) return ciudad;
  }
  return null;
}

async function procesarMensaje(textoUsuario, from, session) {
  // Guardar historial
  session.history.push({ role: "user", content: textoUsuario });
  if (session.history.length > 12) session.history = session.history.slice(-12);

  // 1. DETECTAR REFERENCIA (producto)
  let referencia = null;
  if (!session.pedido.productoId) {
    referencia = detectarReferencia(textoUsuario);
    if (referencia) {
      session.pedido.productoId = referencia.productoId;
      session.pedido.productoNombre = referencia.productoNombre;
      session.pedido.tonosDisponibles = catalogo[referencia.productoId].tonos || [];
      // Enviar imágenes automáticamente
      await enviarImagenes(from, referencia.productoId);
      await enviarMensaje(from, `Hermoso, el ${referencia.productoNombre}. ¿De qué color lo quieres? Tenemos ${session.pedido.tonosDisponibles.join(", ")}.`);
      return;
    } else {
      // Verificar si el usuario escribió algo que parece una referencia pero no existe
      if (/(\d{1,2}\s*[x*]\s*\d{1,2}\s*[x*]\s*\d{1,2})/i.test(textoUsuario)) {
        await enviarMensaje(from, "Esa medida no la manejamos. ¿Te gustaría ver nuestro catálogo de adoquines y fachaletas?");
        await mostrarCatalogoResumido(from);
        return;
      }
    }
  }

  // 2. DETECTAR TONALIDAD
  if (session.pedido.productoId && !session.pedido.tonalidad) {
    const tonos = session.pedido.tonosDisponibles;
    const lower = textoUsuario.toLowerCase();
    for (const tono of tonos) {
      if (lower.includes(tono)) {
        session.pedido.tonalidad = tono;
        await enviarMensaje(from, `Perfecto, ${tono}. ¿Cuántas unidades necesitas?`);
        return;
      }
    }
    // Si no detectó tono, preguntar de nuevo
    if (tonos.length > 0) {
      await enviarMensaje(from, `No entendí el color. Tenemos ${tonos.join(", ")}. ¿Cuál prefieres?`);
      return;
    }
  }

  // 3. DETECTAR CANTIDAD (solo si no la tiene y ya tiene producto y tonalidad)
  if (session.pedido.productoId && session.pedido.tonalidad && session.pedido.cantidad === null) {
    const cantidad = detectarCantidad(textoUsuario, referencia);
    if (cantidad !== null) {
      session.pedido.cantidad = cantidad;
      await enviarMensaje(from, `Ok, ${cantidad} unidades. ¿Dónde te lo mandamos? (Si es en Némocon puedes pasar a recoger, dime si prefieres envío o recogida)`);
      return;
    } else {
      await enviarMensaje(from, "¿Cuántas unidades necesitas? (Ej: 1000)");
      return;
    }
  }

  // 4. DETECTAR MODO DE ENTREGA Y UBICACIÓN
  if (session.pedido.cantidad !== null && !session.pedido.modoEntrega) {
    const modo = detectarModoEntrega(textoUsuario);
    if (modo === "recoger") {
      session.pedido.modoEntrega = "recoger";
      session.pedido.ubicacion = "recoger_en_fabrica";
      await enviarMensaje(from, "Claro, aquí tienes la ubicación de la fábrica:");
      await enviarMensaje(from, "https://maps.app.goo.gl/m2nUV7zG5GbjLV8q6");
      // Mostrar resumen y cotización
      await mostrarResumenYOferta(from, session);
      return;
    } else if (modo === "envio") {
      session.pedido.modoEntrega = "envio";
      await enviarMensaje(from, "Dame la dirección completa para el envío (calle, carrera, número, ciudad).");
      return;
    } else {
      // Si no detecta modo, preguntar
      await enviarMensaje(from, "¿Prefieres recoger en la fábrica (Némocon) o que te lo enviemos?");
      return;
    }
  }

  // 5. DETECTAR UBICACIÓN PARA ENVÍO
  if (session.pedido.modoEntrega === "envio" && !session.pedido.ubicacion) {
    const ubicacion = detectarUbicacion(textoUsuario);
    if (ubicacion && ubicacion !== "recoger_en_fabrica") {
      session.pedido.ubicacion = ubicacion;
      await mostrarResumenYOferta(from, session);
      return;
    } else {
      await enviarMensaje(from, "Por favor, escribe la dirección completa (calle, carrera, número, ciudad).");
      return;
    }
  }

  // Si llegamos aquí, algo falló o el usuario está saludando
  if (/^(hola|buenos días|buenas tardes|qué hubo|epa|veci)$/i.test(textoUsuario)) {
    if (!session.presentado) {
      session.presentado = true;
      await enviarMensaje(from, "¡Hola! Buenos días, ¿cómo vas? Cuéntame qué producto te interesa de nuestro catálogo (adoquines o fachaletas).");
    } else {
      await enviarMensaje(from, "¿En qué más te puedo ayudar? Cuéntame qué producto buscas.");
    }
    return;
  }

  // Si el usuario pide ver el catálogo
  if (/(catálogo|qué tienes|qué productos|muéstrame)/i.test(textoUsuario)) {
    await mostrarCatalogoResumido(from);
    return;
  }

  // Respuesta por defecto
  await enviarMensaje(from, "No entendí bien. ¿Puedes repetir qué producto buscas?");
}

async function mostrarCatalogoResumido(to) {
  const adoquines = Object.entries(catalogo).filter(([id]) => id.startsWith("adoquin"));
  const fachaletas = Object.entries(catalogo).filter(([id]) => id.startsWith("fachaleta"));
  
  let mensaje = "📦 *Nuestros productos:*\n\n*Adoquines:*\n";
  for (const [id, prod] of adoquines) {
    mensaje += `- ${prod.nombre}\n`;
  }
  mensaje += "\n*Fachaletas:*\n";
  for (const [id, prod] of fachaletas) {
    mensaje += `- ${prod.nombre}\n`;
  }
  mensaje += "\nEscribe el nombre o la medida que te interesa (ej: 20x10x6) y te muestro fotos.";
  await enviarMensaje(to, mensaje);
}

async function mostrarResumenYOferta(to, session) {
  const producto = session.pedido.productoNombre;
  const color = session.pedido.tonalidad;
  const cantidad = session.pedido.cantidad;
  const modo = session.pedido.modoEntrega;
  let ubicacionTexto = "";
  if (modo === "recoger") {
    ubicacionTexto = "recoges en la fábrica (Némocon)";
  } else {
    ubicacionTexto = `envío a ${session.pedido.ubicacion}`;
  }
  
  let beneficios = "";
  if (producto.includes("20x10x6")) {
    beneficios = " Este adoquín es ideal para entradas de carros y zonas de alto tránsito, súper resistente. Además, su color dura mucho tiempo sin decolorarse.";
  } else if (producto.includes("fachaleta")) {
    beneficios = " Es perfecta para fachadas elegantes, fácil de instalar y con acabado premium.";
  } else {
    beneficios = " Es un producto de excelente calidad, fabricado con materiales seleccionados.";
  }
  
  await enviarMensaje(to, `Listo, tengo tu pedido: ${producto}, color ${color}, ${cantidad} unidades, ${ubicacionTexto}.${beneficios} ¿Quieres que te prepare una cotización formal?`);
  session.cotizacionOfrecida = true;
  // Resetear pedido después de cotización? No, dejar para que el usuario pueda responder.
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
    if (text === "#reset") {
      session.pedido = JSON.parse(JSON.stringify(defaultPedido));
      session.cotizacionOfrecida = false;
      session.history = [];
      session.presentado = false;
      await enviarMensaje(from, "🔄 Sesión reiniciada.");
      return res.sendStatus(200);
    }
    if (text === "#estado") {
      const estado = `
Producto: ${session.pedido.productoNombre || "❌"}
Color: ${session.pedido.tonalidad || "❌"}
Cantidad: ${session.pedido.cantidad ?? "❌"}
Ubicación: ${session.pedido.ubicacion || "❌"}
Modo: ${session.pedido.modoEntrega || "❌"}
`;
      await enviarMensaje(from, estado);
      return res.sendStatus(200);
    }

    await procesarMensaje(text, from, session);

    res.sendStatus(200);
  } catch (error) {
    console.error("ERROR:", error.response?.data || error.message);
    res.sendStatus(200);
  }
});

app.get("/", (req, res) => res.send("Ana IA - Versión reestructurada"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo puerto ${PORT}`));
