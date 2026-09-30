import { z } from "zod";
import { formatToolResponse } from "../utils.js";

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
    cuentaId: client.clientId ? client.clientId.slice(0, 3) + "***" : "anonima",
    pais: client.country,
    categoria,
    motivo,
    pregunta: pregunta.trim(),
  };

  discoveryLog.push(entry);
  if (discoveryLog.length > 200) discoveryLog.shift();

  // Registro en stderr para trazabilidad en Vercel / Cloud
  console.error(`[DISCOVERY] ${entry.timestamp} | Categoria: ${categoria} | Motivo: ${motivo} | Pregunta: "${entry.pregunta}"`);

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
