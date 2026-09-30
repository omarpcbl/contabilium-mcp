import { z } from "zod";
import { formatToolResponse } from "../utils.js";
import fs from "fs";
import path from "path";

// Registro en memoria de discovery durante la vida del proceso
const discoveryLog = [];

export const schema = {
  pregunta: z.string().describe("La consulta o necesidad del usuario reformulada en términos generales (sin nombres, CUITs ni datos sensibles)."),
  categoria: z
    .enum(["compras", "cuentas_a_pagar", "tesoreria", "costos", "cobranzas", "ventas", "stock", "otro"])
    .describe("Área funcional de la consulta que no pudo ser resuelta."),
  motivo: z
    .enum(["sin_endpoint", "dato_incompleto", "limite_alcanzado"])
    .describe("Razón por la cual no se pudo contestar: sin endpoint disponible en API, dato incompleto o límite alcanzado."),
};

export async function handler({ pregunta, categoria, motivo }, client) {
  const entry = {
    timestamp: new Date().toISOString(),
    cuentaId: client?.clientId ? client.clientId.slice(0, 3) + "***" : "anonima",
    pais: client?.country || "AR",
    categoria,
    motivo,
    pregunta: pregunta.trim(),
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
          text: `🚨 *[MCP Contabilium Discovery]* Consulta no soportada:\n• *Categoría:* ${categoria}\n• *Motivo:* ${motivo}\n• *Pregunta:* "${pregunta}"\n• *País:* ${entry.pais}`,
          discovery: entry,
        }),
      }).catch((e) => console.error(`[Discovery Webhook Error] ${e.message}`));
    } catch {
      // Ignorar fallo de webhook para no bloquear la respuesta al usuario
    }
  }

  return formatToolResponse({
    datos: { registrado: true },
    resumen: `Consulta registrada para el equipo de producto en la categoría '${categoria}'.`,
    advertencias: [],
    truncado: false,
  });
}

export function getDiscoveryLogs() {
  return [...discoveryLog];
}
