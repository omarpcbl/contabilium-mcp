import { z } from "zod";
import { classifyFiscalInvoice, diffDays, formatCurrency, formatToolResponse, getTodayString, parseAmount, subDays } from "../utils.js";

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

function clasificarTramo(esVencida, diasVencido) {
  if (!esVencida || diasVencido <= 0) return "no_vencida";
  if (diasVencido <= 30) return "vencida_1_30";
  if (diasVencido <= 60) return "vencida_31_60";
  if (diasVencido <= 90) return "vencida_61_90";
  return "vencida_mas_90";
}

export async function handler({ fecha_desde, fecha_hasta, cliente_id, solo_vencidas, agrupar_por }, client) {
  // Fecha local según el país de la cuenta para evitar desfasaje UTC (BUG-14)
  const hoyStr = getTodayString(client?.country);
  const finalHasta = fecha_hasta || hoyStr;
  const finalDesde = fecha_desde || subDays(finalHasta, 365); // 12 meses atrás por defecto
  const usoRangoDefault = !fecha_desde;

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
  let cotizacionesExcluidas = 0;

  const antiguedadGeneral = {
    no_vencida: 0,
    vencida_1_30: 0,
    vencida_31_60: 0,
    vencida_61_90: 0,
    vencida_mas_90: 0,
  };

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
      const tipoRaw = c.TipoFc || c.tipoFc || "";
      const fiscal = classifyFiscalInvoice(tipoRaw);

      // Excluir cotizaciones y tipos no fiscales de la deuda (BUG-11)
      if (!fiscal.esFiscal) {
        cotizacionesExcluidas += 1;
        continue;
      }

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

        // Sanitización de cliente (BUG-13)
        let clienteRaw = String(c.RazonSocial || c.razonSocial || "").trim();
        let clienteIdentificador = clienteRaw.length > 0 && clienteRaw !== "0" && clienteRaw !== "-1" ? clienteRaw : "Consumidor Final";

        const tramoVenc = clasificarTramo(esVencida, diasVencido);
        antiguedadGeneral[tramoVenc] += saldo;

        comprobantesConSaldo.push({
          id: c.Id ?? c.id,
          cliente_id: c.IdCliente ?? c.idCliente,
          cliente: clienteIdentificador,
          numero: c.Numero || c.numero || "Sin número",
          tipo: fiscal.tipoNormalizado,
          fecha_emision: (c.FechaEmision || c.fechaEmision || "").slice(0, 10),
          fecha_vencimiento: fVto,
          saldo,
          esVencida,
          diasVencido,
          tramo_vencimiento: tramoVenc,
        });
      }
    }
  }

  let datos;
  let saldoTotalGeneral = 0;
  let saldoVencidoGeneral = 0;

  if (agrupar_por === "comprobante") {
    datos = comprobantesConSaldo
      .map((c) => {
        saldoTotalGeneral += c.saldo;
        if (c.esVencida) saldoVencidoGeneral += c.saldo;
        return {
          numero: c.numero,
          cliente: c.cliente,
          tipo: c.tipo,
          fecha_emision: c.fecha_emision,
          fecha_vencimiento: c.fecha_vencimiento,
          saldo: c.saldo,
          dias_vencido: c.diasVencido,
          tramo_vencimiento: c.tramo_vencimiento,
        };
      })
      .sort((a, b) => b.saldo - a.saldo);
  } else {
    // Agrupar por cliente
    const clientesMap = new Map();

    for (const c of comprobantesConSaldo) {
      saldoTotalGeneral += c.saldo;
      if (c.esVencida) saldoVencidoGeneral += c.saldo;

      const key = c.cliente;
      const entry = clientesMap.get(key) || {
        cliente: key,
        saldo_total: 0,
        saldo_vencido: 0,
        comprobantes_pendientes: 0,
        vencimiento_mas_antiguo: c.fecha_vencimiento,
        antiguedad: {
          no_vencida: 0,
          vencida_1_30: 0,
          vencida_31_60: 0,
          vencida_61_90: 0,
          vencida_mas_90: 0,
        },
      };

      entry.saldo_total += c.saldo;
      if (c.esVencida) entry.saldo_vencido += c.saldo;
      entry.comprobantes_pendientes += 1;
      entry.antiguedad[c.tramo_vencimiento] += c.saldo;

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
        antiguedad_deuda: {
          no_vencida: Math.round(e.antiguedad.no_vencida * 100) / 100,
          vencida_1_30: Math.round(e.antiguedad.vencida_1_30 * 100) / 100,
          vencida_31_60: Math.round(e.antiguedad.vencida_31_60 * 100) / 100,
          vencida_61_90: Math.round(e.antiguedad.vencida_61_90 * 100) / 100,
          vencida_mas_90: Math.round(e.antiguedad.vencida_mas_90 * 100) / 100,
        },
      }))
      .sort((a, b) => b.saldo_total - a.saldo_total);
  }

  const saldoNoVencidoGeneral = Math.max(0, saldoTotalGeneral - saldoVencidoGeneral);

  const advertencias = [
    // Siempre responder que se excluyen cotizaciones (Requerimiento explícito del usuario)
    "Se excluyen cotizaciones y comprobantes no fiscales del cálculo de saldo deudor.",
    "Saldo calculado desde comprobantes con saldo pendiente. No incluye pagos a cuenta ni ajustes de cuenta corriente, puede diferir del reporte Saldo de clientes.",
  ];

  if (cotizacionesExcluidas > 0) {
    advertencias.push(`Se detectaron y omitieron ${cotizacionesExcluidas} cotizaciones o comprobantes no fiscales con saldo pendiente.`);
  }

  if (usoRangoDefault) {
    advertencias.push(
      `Se utilizó el rango por defecto de los últimos 12 meses (${finalDesde} al ${finalHasta}). Deuda anterior a 12 meses no está incluida; para consultarla especifique 'fecha_desde'.`
    );
  }

  if (truncado) {
    advertencias.push(
      "Búsqueda limitada por tope de 20 páginas de la API: la deuda más antigua (mayor a 90 días) podría no haber sido leída en su totalidad debido al corte de paginación."
    );
  }

  let prefijoTruncado = "";
  if (truncado) {
    prefijoTruncado = "[DATOS PARCIALES / TRUNCADOS] Búsqueda cortada por límite de 20 páginas. ";
  }

  const resumen = `${prefijoTruncado}Deuda total encontrada: ${formatCurrency(saldoTotalGeneral)} (Vencida: ${formatCurrency(
    saldoVencidoGeneral
  )}, A vencer: ${formatCurrency(saldoNoVencidoGeneral)}) en ${comprobantesConSaldo.length} comprobante(s) pendiente(s) (período analizado: ${finalDesde} al ${finalHasta}).`;

  return formatToolResponse({
    datos: {
      totales: {
        saldo_total: Math.round(saldoTotalGeneral * 100) / 100,
        saldo_vencido: Math.round(saldoVencidoGeneral * 100) / 100,
        saldo_no_vencido: Math.round(saldoNoVencidoGeneral * 100) / 100,
        comprobantes_pendientes: comprobantesConSaldo.length,
        periodo_analizado: {
          desde: finalDesde,
          hasta: finalHasta,
          es_rango_por_defecto: usoRangoDefault,
        },
        antiguedad_deuda_incompleta: truncado, // Alerta explícita para dashboards (BUG-12)
        antiguedad_deuda_general: {
          no_vencida: Math.round(antiguedadGeneral.no_vencida * 100) / 100,
          vencida_1_30: Math.round(antiguedadGeneral.vencida_1_30 * 100) / 100,
          vencida_31_60: Math.round(antiguedadGeneral.vencida_31_60 * 100) / 100,
          vencida_61_90: Math.round(antiguedadGeneral.vencida_61_90 * 100) / 100,
          vencida_mas_90: Math.round(antiguedadGeneral.vencida_mas_90 * 100) / 100,
        },
      },
      filas: datos,
    },
    resumen,
    advertencias,
    truncado,
  });
}
