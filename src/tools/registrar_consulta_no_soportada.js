import { z } from "zod";
import { formatToolResponse } from "../utils.js";
import fs from "fs";
import path from "path";

// Registro en memoria de discovery durante la vida del proceso
const discoveryLog = [];

const ALTERNATIVAS_POR_CATEGORIA = {
  cuentas_a_pagar: "El MCP no tiene acceso a deudas con proveedores ni cuentas a pagar en este MVP de solo lectura. Podés usar 'buscar_proveedores' para datos de contacto de compras o 'cuentas_por_cobrar' para ver la deuda de tus clientes.",
  compras: "No contamos con endpoint de órdenes de compra ni facturas de compra en este MVP. Podés consultar 'buscar_proveedores' para ver tus proveedores registrados y 'buscar_productos' para consultar los costos internos de reposición asignados.",
  tesoreria: "No disponemos de saldos de cuentas bancarias ni cajas en este MVP. Podés usar 'cuentas_por_cobrar' para proyectar tus próximos ingresos de cobranzas.",
  costos: "Podés consultar el campo 'costo_interno' en 'buscar_productos', que representa el costo habitual de reposición registrado en Contabilium.",
  facturacion: "La emisión y anulación de comprobantes electrónicos no está habilitada en esta integración de dashboards de solo lectura. Para facturar, ingresá a contabilium.com > Ventas > Comprobantes.",
  ventas: "Si la consulta abarca más de 92 días, recordá que podés acotar las fechas o consultar mes por mes con 'resumen_ventas'.",
  stock: "Para movimientos históricos de stock, ingresá al módulo de inventarios en la web de Contabilium. Podés ver existencias actuales y reservadas con 'stock_por_deposito'.",
  otro: "Esta consulta excede el alcance del MVP actual (ventas, stock por depósito y cuentas por cobrar). El requerimiento fue registrado para priorizarlo en futuras versiones del MCP.",
};

export const schema = {
  pregunta: z.string().describe("La consulta o necesidad del usuario reformulada en términos generales (sin nombres, CUITs ni datos sensibles)."),
  categoria: z
    .enum(["compras", "cuentas_a_pagar", "tesoreria", "costos", "cobranzas", "ventas", "stock", "facturacion", "otro"])
    .describe("Área funcional de la consulta que no pudo ser resuelta."),
  motivo: z
    .enum(["sin_endpoint", "dato_incompleto", "limite_alcanzado", "solo_lectura"])
    .describe("Razón por la cual no se pudo contestar: sin endpoint disponible en API, dato incompleto, límite alcanzado o solo lectura."),
};

export async function handler({ pregunta, categoria, motivo }, client) {
  const sugerencia = ALTERNATIVAS_POR_CATEGORIA[categoria] || ALTERNATIVAS_POR_CATEGORIA.otro;

  const entry = {
    timestamp: new Date().toISOString(),
    cuentaId: client?.clientId ? client.clientId.slice(0, 3) + "***" : "anonima",
    pais: client?.country || "AR",
    categoria,
    motivo,
    pregunta: pregunta.trim(),
    sugerenciaRetornada: sugerencia,
  };

  discoveryLog.push(entry);
  if (discoveryLog.length > 200) discoveryLog.shift();

  // 1. Registro estructurado en stderr (Visible en Vercel Logs / Docker / Cloudwatch)
  console.error(`[DISCOVERY] ${JSON.stringify(entry)}`);

  // 2. Persistencia en disco local (si el entorno permite escritura de archivos)
  try {
    const logFilePath = path.join(process.cwd(), "discovery.jsonl");
    fs.appendFileSync(logFilePath, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Entornos serverless de solo lectura (como Vercel /tmp-only) ignoran silenciosamente
  }

  // 3. Webhook opcional hacia Slack / Discord / Zapier / Google Sheets
  const webhookUrl = process.env.DISCOVERY_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `🚨 *[MCP Contabilium Discovery]* Consulta no soportada:\n• *Categoría:* ${categoria}\n• *Motivo:* ${motivo}\n• *Pregunta:* "${pregunta}"\n• *Alternativa:* "${sugerencia}"\n• *País:* ${entry.pais}`,
          discovery: entry,
        }),
      }).catch((e) => console.error(`[Discovery Webhook Error] ${e.message}`));
    } catch {
      // Ignorar fallo de webhook para no bloquear la respuesta al usuario
    }
  }

  return formatToolResponse({
    datos: {
      registrado: true,
      categoria,
      sugerencia_alternativa: sugerencia,
    },
    resumen: `Consulta registrada para el equipo de producto. Alternativa sugerida: ${sugerencia}`,
    advertencias: [],
    truncado: false,
  });
}

export function getDiscoveryLogs() {
  return [...discoveryLog];
}
