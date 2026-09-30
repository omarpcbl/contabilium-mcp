import { z } from "zod";
import { diffDays, formatCurrency, formatToolResponse, getIsoWeek, getYearMonth, parseAmount, subDays } from "../utils.js";

export const schema = {
  fecha_desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD requerido").describe("Fecha inicial de ventas (YYYY-MM-DD)."),
  fecha_hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD requerido").describe("Fecha final de ventas (YYYY-MM-DD)."),
  agrupar_por: z.enum(["mes", "semana", "cliente", "producto", "rubro", "origen"]).default("mes").describe("Criterio de agrupación de las ventas."),
  top: z.number().int().min(1).max(50).default(10).describe("Cantidad de filas principales a devolver (default 10)."),
  comparar_con_periodo_anterior: z.boolean().default(false).describe("Si es true, compara contra el período previo de igual duración."),
};

export async function handler({ fecha_desde, fecha_hasta, agrupar_por, top, comparar_con_periodo_anterior }, client) {
  const dias = diffDays(fecha_desde, fecha_hasta);
  if (dias > 92) {
    throw new Error(`El rango solicitado es de ${dias} días (supera el límite de 92 días). Por favor acota las fechas o pártelas en tramos.`);
  }

  // Presupuesto de páginas: 20 páginas en total
  let maxPagesActual = comparar_con_periodo_anterior ? 12 : 20;

  // 1. Obtener comprobantes del período actual
  const actualRes = await client.paginatedGet("/comprobantes/search", { fechaDesde: fecha_desde, fechaHasta: fecha_hasta }, maxPagesActual, 300);
  let totalPaginasUsadas = actualRes.paginasLeidas;

  // 2. Si agrupa por rubro, traer mapa de rubros con caché
  let rubrosMap = new Map();
  if (agrupar_por === "rubro") {
    const rubrosRaw = await client.get("/conceptos/rubros", null, 1800);
    if (Array.isArray(rubrosRaw)) {
      for (const r of rubrosRaw) {
        if (r.Id && r.Nombre) rubrosMap.set(Number(r.Id), r.Nombre);
      }
    }
  }

  // Helper para procesar comprobantes y agrupar
  function procesarComprobantes(items) {
    const grupos = new Map();
    let totalGeneral = 0;
    let comprobantesGeneral = 0;
    let unidadesGeneral = 0;

    for (const c of items) {
      const tipo = (c.TipoFc || c.tipoFc || "").toUpperCase().trim();
      // Las notas de crédito restan
      const esNC = tipo.startsWith("NC");
      const multiplier = esNC ? -1 : 1;

      const rawMonto = parseAmount(c.ImporteTotalNeto ?? c.Total ?? c.ImporteTotalBruto ?? 0) * multiplier;
      totalGeneral += rawMonto;
      comprobantesGeneral += 1;

      if (agrupar_por === "mes") {
        const key = getYearMonth(c.FechaEmision || c.fechaEmision);
        const g = grupos.get(key) || { grupo: key, cantidad_comprobantes: 0, unidades: 0, total: 0 };
        g.cantidad_comprobantes += 1;
        g.total += rawMonto;
        grupos.set(key, g);
      } else if (agrupar_por === "semana") {
        const key = getIsoWeek(c.FechaEmision || c.fechaEmision);
        const g = grupos.get(key) || { grupo: key, cantidad_comprobantes: 0, unidades: 0, total: 0 };
        g.cantidad_comprobantes += 1;
        g.total += rawMonto;
        grupos.set(key, g);
      } else if (agrupar_por === "cliente") {
        const key = c.RazonSocial || c.razonSocial || "Consumidor Final";
        const g = grupos.get(key) || { grupo: key, cantidad_comprobantes: 0, unidades: 0, total: 0 };
        g.cantidad_comprobantes += 1;
        g.total += rawMonto;
        grupos.set(key, g);
      } else if (agrupar_por === "origen") {
        // En ventas de algunas integraciones Origen o Canal vienen vacíos (API-1213, 1239). Agrupar como "Sin origen informado", nunca como "Venta directa"
        const rawOrigen = (c.Origen || c.Canal || "").trim();
        const key = rawOrigen.length > 0 ? rawOrigen : "Sin origen informado";
        const g = grupos.get(key) || { grupo: key, cantidad_comprobantes: 0, unidades: 0, total: 0 };
        g.cantidad_comprobantes += 1;
        g.total += rawMonto;
        grupos.set(key, g);
      } else if (agrupar_por === "producto" || agrupar_por === "rubro") {
        const itemsFactura = Array.isArray(c.Items) ? c.Items : [];
        if (itemsFactura.length === 0) {
          const key = "Ítems no detallados";
          const g = grupos.get(key) || { grupo: key, cantidad_comprobantes: 0, unidades: 0, total: 0 };
          g.cantidad_comprobantes += 1;
          g.total += rawMonto;
          grupos.set(key, g);
        } else {
          for (const it of itemsFactura) {
            const cant = parseAmount(it.Cantidad ?? 1) * multiplier;
            const subtotal = parseAmount(it.Subtotal ?? it.PrecioUnitario * it.Cantidad ?? 0) * multiplier;
            unidadesGeneral += cant;

            let key = "Varios";
            if (agrupar_por === "producto") {
              key = it.Concepto || it.Nombre || it.Codigo || "Producto sin nombre";
            } else if (agrupar_por === "rubro") {
              const idRubro = Number(it.IdRubro || it.idRubro);
              key = rubrosMap.get(idRubro) || it.Rubro || "Sin rubro";
            }

            const g = grupos.get(key) || { grupo: key, cantidad_comprobantes: 0, unidades: 0, total: 0 };
            g.cantidad_comprobantes += 1;
            g.unidades += cant;
            g.total += subtotal;
            grupos.set(key, g);
          }
        }
      }
    }

    return {
      grupos,
      totalGeneral: Math.round(totalGeneral * 100) / 100,
      comprobantesGeneral,
      unidadesGeneral: Math.round(unidadesGeneral * 100) / 100,
    };
  }

  const actualData = procesarComprobantes(actualRes.items);
  let anteriorData = null;
  let truncadoTotal = actualRes.truncado;

  // 3. Comparación con período anterior si se solicitó
  if (comparar_con_periodo_anterior) {
    const prevHasta = subDays(fecha_desde, 1);
    const prevDesde = subDays(prevHasta, dias);

    const maxPagesAnterior = Math.max(1, 20 - totalPaginasUsadas);
    const anteriorRes = await client.paginatedGet("/comprobantes/search", { fechaDesde: prevDesde, fechaHasta: prevHasta }, maxPagesAnterior, 300);

    if (anteriorRes.truncado) truncadoTotal = true;
    anteriorData = procesarComprobantes(anteriorRes.items);
  }

  // Ordenar grupos por total descendente
  const sortedGrupos = Array.from(actualData.grupos.values())
    .map((g) => {
      const fila = {
        grupo: g.grupo,
        cantidad_comprobantes: g.cantidad_comprobantes,
        unidades: Math.round(g.unidades * 100) / 100,
        total: Math.round(g.total * 100) / 100,
      };

      if (anteriorData) {
        const prevG = anteriorData.grupos.get(g.grupo);
        const totalAnt = prevG ? Math.round(prevG.total * 100) / 100 : 0;
        fila.total_anterior = totalAnt;
        fila.variacion_pct = totalAnt !== 0 ? Math.round(((fila.total - totalAnt) / Math.abs(totalAnt)) * 1000) / 10 : null;
      }

      return fila;
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, top);

  const advertencias = [];
  if (agrupar_por === "origen") {
    advertencias.push("En ventas de algunas integraciones Origen o Canal vienen vacíos (API-1213, 1239). Se agrupan como 'Sin origen informado'.");
  }
  if (truncadoTotal) {
    advertencias.push("Consulta limitada por tope de 20 páginas. Se sugiere acotar el rango de fechas para mayor precisión.");
  }

  const resumen = `Ventas totales del período: ${formatCurrency(actualData.totalGeneral)} en ${actualData.comprobantesGeneral} comprobantes.${
    anteriorData ? ` Período anterior: ${formatCurrency(anteriorData.totalGeneral)}.` : ""
  }`;

  return formatToolResponse({
    datos: {
      totales_generales: {
        total_facturado: actualData.totalGeneral,
        cantidad_comprobantes: actualData.comprobantesGeneral,
        unidades: actualData.unidadesGeneral,
        ...(anteriorData
          ? {
              total_anterior: anteriorData.totalGeneral,
              variacion_total_pct:
                anteriorData.totalGeneral !== 0
                  ? Math.round(((actualData.totalGeneral - anteriorData.totalGeneral) / Math.abs(anteriorData.totalGeneral)) * 1000) / 10
                  : null,
            }
          : {}),
      },
      filas: sortedGrupos,
    },
    resumen,
    advertencias,
    truncado: truncadoTotal,
  });
}
