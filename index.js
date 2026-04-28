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

function normalizarTextoColor(texto) {
  return texto
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z]/g, "");
}

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

// ==================== FUNCIÓN DE UBICACIÓN ====================
async function procesarUbicacion(texto, to, session) {
  const lower = texto.toLowerCase().trim();
  
  const preguntaFabricaPatterns = [
    /dónde\s+(?:queda|est[aá]n|estan|encuentro|est[aá]\s+ubicad[oa]s?)/i,
    /ubicación\s+(?:de\s+la\s+fábrica|de\s+la\s+planta)/i,
    /dónde\s+están\s+ubicados/i,
    /dónde\s+queda\s+la\s+fábrica/i,
    /dirección\s+de\s+la\s+fábrica/i,
    /ustedes\s+dónde\s+están/i,
    /en\s+qué\s+parte\s+están/i,
    /donde\s+estan\s+ubicados/i,
    /donde\s+queda\s+la\s+fabrica/i
  ];
  const esPreguntaFabrica = preguntaFabricaPatterns.some(pattern => pattern.test(lower));
  
  const recogerPatterns = [
    /recoger|pasar|retirar|lo\s+recojo|paso\s+a\s+recoger|voy\s+a\s+recoger|lo\s+retiro|recogida/i
  ];
  const quiereRecoger = recogerPatterns.some(pattern => pattern.test(lower));
  
  const envioPatterns = [
    /env[ií]o|enviar|mandar|me\s+lo\s+env[ií]an|a\s+domicilio|env[ií]en|env[ií]o\s+a\s+domicilio|que\s+me\s+lo\s+env[ií]en/i
  ];
  const quiereEnvio = envioPatterns.some(pattern => pattern.test(lower));
  
  const direccionPatterns = /(calle|carrera|avenida|av\.|cra\.|cl\.|diagonal|transversal|kilómetro|km)\s+[\d#\s\-\.]+/i;
  const esDireccionCompleta = direccionPatterns.test(lower);
  
  const ciudades = [
    "chía", "chia", "bogotá", "bogota", "zipaquirá", "zipaquira", 
    "tocancipá", "tocancipa", "sopó", "sopo", "cajicá", "cajica", 
    "némocon", "nemocon", "madrid", "funza", "mosquera", "facatativá", "facatativa", "cogua"
  ];
  
  let ciudadEncontrada = null;
  for (const ciudad of ciudades) {
    if (lower.includes(ciudad)) {
      ciudadEncontrada = ciudad;
      break;
    }
  }
  
  if (esPreguntaFabrica && !quiereRecoger && !quiereEnvio) {
    await enviarMensaje(to, "Nuestra fábrica está en Némocon. Aquí te mando la ubicación:");
    await enviarMensaje(to, "https://maps.app.goo.gl/m2nUV7zG5GbjLV8q6");
    await enviarMensaje(to, "¿Prefieres recoger en la fábrica o que te lo enviemos?");
    return false;
  }
  
  if (quiereRecoger) {
    session.pedido.ubicacion = "Recogida en fábrica (Némocon)";
    await enviarMensaje(to, "Perfecto, entonces lo recoges en nuestra fábrica en Némocon.");
    return true;
  }
  
  if (quiereEnvio) {
    if (ciudadEncontrada) {
      session.pedido.ubicacion = ciudadEncontrada;
      await enviarMensaje(to, `Entendido, envío a ${ciudadEncontrada}. ¿Me das la dirección completa?`);
      return false;
    } else if (esDireccionCompleta) {
      session.pedido.ubicacion = texto;
      await enviarMensaje(to, `Dirección guardada: ${texto}`);
      return true;
    } else {
      await enviarMensaje(to, "Dime la dirección completa para el envío (ej: Calle 10 # 20-30, Chía) o la ciudad si aún no la tienes.");
      return false;
    }
  }
  
  if (ciudadEncontrada) {
    if (ciudadEncontrada === "némocon" || ciudadEncontrada === "nemocon") {
      session.pedido.ubicacion = "Recogida en fábrica (Némocon)";
      await enviarMensaje(to, "Perfecto, puedes recoger en nuestra fábrica en Némocon. Aquí te mando la ubicación:");
      await enviarMensaje(to, "https://maps.app.goo.gl/m2nUV7zG5GbjLV8q6");
      return true;
    } else {
      session.pedido.ubicacion = ciudadEncontrada;
      await enviarMensaje(to, `Entendido, envío a ${ciudadEncontrada}. ¿Me das la dirección completa?`);
      return false;
    }
  }
  
  if (esDireccionCompleta) {
    session.pedido.ubicacion = texto;
    await enviarMensaje(to, `Dirección guardada: ${texto}`);
    return true;
  }
  
  await enviarMensaje(to, "No entendí bien. ¿Quieres recoger en nuestra fábrica (Némocon) o prefieres que te lo enviemos? Si es envío, dame la dirección completa.");
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

  // ========== NUEVO: DETECCIÓN DE CORRECCIONES (cantidad, ubicación, color) ==========
  const lower = textoUsuario.toLowerCase();
  const esCorreccion = /me equivoqu[eé]|correcci[oó]n|era\s+|no\s+es|cambio\s+la\s+cantidad|cambi[oó]\s+el\s+color|rectifico|me\s+equivoqu[eé]\s+de\s+(cantidad|color|producto|ubicación|dirección)|perd[oó]n|no era|no es ahi|es a|corrijo/i.test(lower);
  
  if (esCorreccion && session.cotizacionOfrecida) {
    let cambioRealizado = false;
    
    // 1. Corrección de cantidad (número)
    const nuevaCantMatch = lower.match(/(\d{1,3}(?:[.,]\d{3})*|\d+)/);
    if (nuevaCantMatch && session.pedido.cantidad !== null) {
      let nuevaCantStr = nuevaCantMatch[1].replace(/\./g, '').replace(',', '');
      let nuevaCant = parseInt(nuevaCantStr, 10);
      if (!isNaN(nuevaCant) && nuevaCant > 0 && nuevaCant !== session.pedido.cantidad) {
        session.pedido.cantidad = nuevaCant;
        await enviarMensaje(from, `Ah ok, corrijo la cantidad: ${nuevaCant} unidades.`);
        cambioRealizado = true;
      }
    }
    
    // 2. Corrección de ubicación (ciudad o dirección)
    // Patrones: "no era barranquilla era cogua", "es a cogua", "cambio a cogua", "la dirección es calle 5"
    let nuevaUbicacion = null;
    // Detectar ciudad nueva después de "era", "es a", "cambio a"
    const ubicacionMatch = lower.match(/(?:era|es a|cambio a|corrijo a|la dirección es|el envio es a)\s+([a-záéíóúñ\s]+)(?:\.|$)/i);
    if (ubicacionMatch && ubicacionMatch[1]) {
      nuevaUbicacion = ubicacionMatch[1].trim();
    }
    // También detectar "no era X era Y"
    const noEraMatch = lower.match(/no era\s+([a-záéíóúñ\s]+)\s+era\s+([a-záéíóúñ\s]+)/i);
    if (noEraMatch && noEraMatch[2]) {
      nuevaUbicacion = noEraMatch[2].trim();
    }
    if (nuevaUbicacion && session.pedido.ubicacion !== nuevaUbicacion) {
      session.pedido.ubicacion = nuevaUbicacion;
      await enviarMensaje(from, `Corrijo la ubicación: ${nuevaUbicacion}.`);
      cambioRealizado = true;
    }
    
    // 3. Corrección de color (tonalidad)
    if (session.pedido.tonosDisponibles && session.pedido.tonosDisponibles.length > 0) {
      let nuevoColor = null;
      for (const color of session.pedido.tonosDisponibles) {
        if (lower.includes(color.toLowerCase())) {
          nuevoColor = color;
          break;
        }
      }
      if (!nuevoColor) {
        // Buscar por similitud
        const colorSimilar = encontrarColorSimilar(textoUsuario, session.pedido.tonosDisponibles);
        if (colorSimilar) nuevoColor = colorSimilar;
      }
      if (nuevoColor && session.pedido.tonalidad !== nuevoColor) {
        session.pedido.tonalidad = nuevoColor;
        await enviarMensaje(from, `Corrijo el color: ${nuevoColor}.`);
        cambioRealizado = true;
      }
    }
    
    if (cambioRealizado) {
      session.cotizacionOfrecida = false;
      // No retornamos aún; dejamos que el flujo normal muestre el nuevo resumen
    }
  }
  // =====================================================

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
      await enviarMensaje(from, `Ok, ${cantidad} unidades. Nuestra fábrica está en Némocon, aquí te mando la ubicación:`);
      await enviarMensaje(from, "https://maps.app.goo.gl/m2nUV7zG5GbjLV8q6");
      await enviarMensaje(from, "¿Prefieres recoger en la fábrica o que te lo enviemos?");
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
      if (session.pedido.productoNombre && session.pedido.tonalidad && session.pedido.cantidad !== null && session.pedido.ubicacion && !session.cotizacionOfrecida) {
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

app.get("/", (req, res) => res.send("Ana IA - Con corrección de cantidad, ubicación y color"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo puerto ${PORT}`));
