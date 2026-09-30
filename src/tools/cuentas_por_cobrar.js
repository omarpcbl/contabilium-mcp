import { z } from "zod";
import { diffDays, formatCurrency, formatToolResponse, parseAmount, subDays } from "../utils.js";

export const schema = {
  fecha_desde: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD")
    .optional()
    .describe("Fecha inicial de búsqueda (por defecto: 12 meses atrás)."),
  fecha_hasta: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD")
    .optional()
    .describe("Fecha final de búsqueda (por defecto: hoy)."),
  cliente_id: z.number().int().optional().describe("ID del cliente a consultar (opcional)."),
  solo_vencidas: z.boolean().default(false).describe("Si es true, solo incluye deuda vencida a la fecha actual."),
  agrupar_por: z.enum(["cliente", "comprobante"]).default("cliente").describe("Nivel de detalle: por cliente o por comprobante individual."),
};

export async function handler({ fecha_desde, fecha_hasta, cliente_id, solo_vencidas, agrupar_por }, client) {
  const hoyStr = new Date().toISOString().split("T")[0];
  const finalHasta = fecha_hasta || hoyStr;
  const finalDesde = fecha_desde || subDays(finalHasta, 365); // 12 meses atrás por defecto

  // División del rango en tramos de 90 días para respetar el límite de 92 días de la API
  const tramos = [];
  let currHasta = finalHasta;
  while (currHasta > finalDesde) {
    let currDesde = subDays(currHasta, 89);
    if (currDesde < finalDesde) currDesde = finalDesde;
    tramos.push({ desde: currDesde, hasta: currHasta });
    currHasta = subDays(currDesde, 1);
  }

  const comprobantesConSaldo = [];
  let paginasRestantes = 20; // Tope compartido de 20 páginas
  let truncado = false;

  for (const tramo of tramos) {
    if (paginasRestantes <= 0) {
      truncado = true;
      break;
    }

    const baseParams = {
      fechaDesde: tramo.desde,
      fechaHasta: tramo.hasta,
    };
    if (cliente_id) baseParams.idCliente = cliente_id;

    const res = await client.paginatedGet("/comprobantes/search", baseParams, paginasRestantes, 300);
    paginasRestantes -= res.paginasLeidas;
    if (res.truncado) truncado = true;

    for (const c of res.items) {
      const saldo = parseAmount(c.Saldo ?? c.saldo ?? 0);
      if (saldo > 0) {
        const fVto = c.FechaVencimiento ? c.FechaVencimiento.slice(0, 10) : c.FechaEmision?.slice(0, 10) || null;
        let esVencida = false;
        let diasVencido = 0;

        if (fVto) {
          const vtoDate = new Date(fVto + "T00:00:00Z");
          const hoyDate = new Date(hoyStr + "T00:00:00Z");
          if (vtoDate < hoyDate) {
            esVencida = true;
            diasVencido = Math.ceil((hoyDate.getTime() - vtoDate.getTime()) / (1000 * 60 * 60 * 24));
          }
        }

        if (solo_vencidas && !esVencida) {
          continue;
        }

        comprobantesConSaldo.push({
          id: c.Id ?? c.id,
          cliente_id: c.IdCliente ?? c.idCliente,
          cliente: c.RazonSocial || c.razonSocial || "Consumidor Final",
          numero: c.Numero || c.numero || "Sin número",
          fecha_emision: (c.FechaEmision || c.fechaEmision || "").slice(0, 10),
          fecha_vencimiento: fVto,
          saldo,
          esVencida,
          diasVencido,
        });
      }
    }
  }

  let datos;
  let saldoTotalGeneral = 0;

  if (agrupar_por === "comprobante") {
    datos = comprobantesConSaldo
      .map((c) => {
        saldoTotalGeneral += c.saldo;
        return {
          numero: c.numero,
          cliente: c.cliente,
          fecha_emision: c.fecha_emision,
          fecha_vencimiento: c.fecha_vencimiento,
          saldo: c.saldo,
          dias_vencido: c.diasVencido,
        };
      })
      .sort((a, b) => b.saldo - a.saldo);
  } else {
    // Agrupar por cliente
    const clientesMap = new Map();

    for (const c of comprobantesConSaldo) {
      saldoTotalGeneral += c.saldo;
      const key = c.cliente;
      const entry = clientesMap.get(key) || {
        cliente: key,
        saldo_total: 0,
        saldo_vencido: 0,
        comprobantes_pendientes: 0,
        vencimiento_mas_antiguo: c.fecha_vencimiento,
      };

      entry.saldo_total += c.saldo;
      if (c.esVencida) entry.saldo_vencido += c.saldo;
      entry.comprobantes_pendientes += 1;

      if (c.fecha_vencimiento && (!entry.vencimiento_mas_antiguo || c.fecha_vencimiento < entry.vencimiento_mas_antiguo)) {
        entry.vencimiento_mas_antiguo = c.fecha_vencimiento;
      }

      clientesMap.set(key, entry);
    }

    datos = Array.from(clientesMap.values())
      .map((e) => ({
        cliente: e.cliente,
        saldo_total: Math.round(e.saldo_total * 100) / 100,
        saldo_vencido: Math.round(e.saldo_vencido * 100) / 100,
        comprobantes_pendientes: e.comprobantes_pendientes,
        vencimiento_mas_antiguo: e.vencimiento_mas_antiguo,
      }))
      .sort((a, b) => b.saldo_total - a.saldo_total);
  }

  const advertencias = [
    "Saldo calculado desde comprobantes con saldo pendiente. No incluye pagos a cuenta ni ajustes de cuenta corriente, puede diferir del reporte Saldo de clientes.",
  ];
  if (truncado) {
    advertencias.push("Búsqueda limitada por tope de 20 páginas entre tramos. Se sugiere acotar el rango de fechas para mayor exactitud.");
  }

  const resumen = `Deuda total encontrada: ${formatCurrency(saldoTotalGeneral)} en ${comprobantesConSaldo.length} comprobante(s) pendiente(s).`;

  return formatToolResponse({
    datos,
    resumen,
    advertencias,
    truncado,
  });
}
