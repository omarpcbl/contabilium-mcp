import { z } from "zod";
import {
  classifyFiscalInvoice,
  diffDays,
  formatCurrency,
  formatIsoWeekLabel,
  formatToolResponse,
  formatYearMonthLabel,
  getIsoWeek,
  getYearMonth,
  parseAmount,
  renderProgressBar,
  subDays,
} from "../utils.js";

export const schema = {
  fecha_desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD requerido").describe("Fecha inicial de ventas (YYYY-MM-DD)."),
  fecha_hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD requerido").describe("Fecha final de ventas (YYYY-MM-DD)."),
  agrupar_por: z
    .enum(["dia", "mes", "semana", "cliente", "producto", "rubro", "origen"])
    .default("mes")
    .describe("Criterio de agrupación de las ventas: dia, mes, semana, cliente, producto, rubro u origen."),
  top: z.number().int().min(1).max(50).default(10).describe("Cantidad de filas principales a devolver (default 10)."),
  comparar_con_periodo_anterior: z.boolean().default(false).describe("Si es true, compara contra el período previo de igual duración."),
};

export async function handler({ fecha_desde, fecha_hasta, agrupar_por, top, comparar_con_periodo_anterior }, client) {
  const dias = diffDays(fecha_desde, fecha_hasta);
  if (dias > 92) {
    throw new Error(`El rango solicitado es de ${dias} días (supera el límite de 92 días). Por favor acota las fechas o pártelas en tramos.`);
  }

  // Presupuesto de páginas y consulta particionada por tramos (MEJ-17)
  const maxPagesActual = comparar_con_periodo_anterior ? 30 : 50;

  // 1. Obtener comprobantes del período actual
  const actualRes = client.chunkedDateGet
    ? await client.chunkedDateGet("/comprobantes/search", {}, fecha_desde, fecha_hasta, {
        chunkDays: 7,
        maxPagesPerChunk: 15,
        maxTotalPages: maxPagesActual,
        ttlSeconds: 300,
      })
    : await client.paginatedGet("/comprobantes/search", { fechaDesde: fecha_desde, fechaHasta: fecha_hasta }, maxPagesActual, 300);
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
    let totalFacturado = 0;
    let totalNotasCredito = 0;
    let cantidadFacturasGeneral = 0;
    let cantidadNcGeneral = 0;
    let unidadesGeneral = 0;
    let cotizacionesExcluidas = 0;
    let ultimaFechaLeida = null;
    const clientesUnicosGeneral = new Set();

    for (const c of items) {
      const fechaComp = (c.FechaEmision || c.fechaEmision || "").slice(0, 10);
      if (fechaComp) ultimaFechaLeida = fechaComp;

      const tipoRaw = c.TipoFc || c.tipoFc || "";
      const fiscal = classifyFiscalInvoice(tipoRaw);

      // Exclusión estricta de cotizaciones, presupuestos y tipos inválidos (BUG-11)
      if (!fiscal.esFiscal) {
        cotizacionesExcluidas += 1;
        continue;
      }

      const esNC = fiscal.esNC;
      const rawMontoAbsoluto = Math.abs(parseAmount(c.ImporteTotalNeto ?? c.Total ?? c.ImporteTotalBruto ?? 0));
      const rawMonto = esNC ? -rawMontoAbsoluto : rawMontoAbsoluto;

      if (esNC) {
        totalNotasCredito += rawMontoAbsoluto;
        cantidadNcGeneral += 1;
      } else {
        totalFacturado += rawMontoAbsoluto;
        cantidadFacturasGeneral += 1;
      }

      // Sanitización de cliente: excluir espacios vacíos y unificar Consumidor Final (BUG-13)
      let clienteRaw = String(c.RazonSocial || c.razonSocial || "").trim();
      let clienteIdentificador = clienteRaw.length > 0 && clienteRaw !== "0" && clienteRaw !== "-1" ? clienteRaw : "Consumidor Final";

      if (clienteIdentificador !== "Consumidor Final" && clienteIdentificador !== "Sin cliente informado") {
        clientesUnicosGeneral.add(clienteIdentificador);
      }

      let key = "Varios";
      let etiquetaPeriodo = null;
      if (agrupar_por === "dia") {
        key = fechaComp || "Sin fecha";
        etiquetaPeriodo = key;
      } else if (agrupar_por === "mes") {
        key = getYearMonth(c.FechaEmision || c.fechaEmision);
        etiquetaPeriodo = formatYearMonthLabel(key); // MEJ-15
      } else if (agrupar_por === "semana") {
        key = getIsoWeek(c.FechaEmision || c.fechaEmision);
        etiquetaPeriodo = formatIsoWeekLabel(key); // MEJ-15
      } else if (agrupar_por === "cliente") {
        key = clienteIdentificador;
      } else if (agrupar_por === "origen") {
        const rawOrigen = (c.Origen || c.Canal || "").trim();
        key = rawOrigen.length > 0 ? rawOrigen : "Sin origen informado";
      } else if (agrupar_por === "producto" || agrupar_por === "rubro") {
        const itemsFactura = Array.isArray(c.Items) ? c.Items : [];
        if (itemsFactura.length === 0) {
          key = "Ítems no detallados";
        }
      }

      if (agrupar_por !== "producto" && agrupar_por !== "rubro") {
        const g = grupos.get(key) || {
          grupo: key,
          etiqueta_periodo: etiquetaPeriodo || key,
          cantidad_comprobantes: 0,
          cantidad_facturas: 0,
          cantidad_nc: 0,
          unidades: 0,
          total: 0,
          total_facturado: 0,
          total_notas_credito: 0,
          clientes: new Set(),
        };
        g.cantidad_comprobantes += 1;
        if (esNC) {
          g.cantidad_nc += 1;
          g.total_notas_credito += rawMontoAbsoluto;
        } else {
          g.cantidad_facturas += 1;
          g.total_facturado += rawMontoAbsoluto;
        }
        g.total += rawMonto;
        g.clientes.add(clienteIdentificador);
        grupos.set(key, g);
      } else {
        // Agrupación por producto o rubro
        const itemsFactura = Array.isArray(c.Items) ? c.Items : [];
        if (itemsFactura.length === 0) {
          const fallbackKey = "Ítems no detallados";
          const g = grupos.get(fallbackKey) || {
            grupo: fallbackKey,
            etiqueta_periodo: fallbackKey,
            cantidad_comprobantes: 0,
            cantidad_facturas: 0,
            cantidad_nc: 0,
            unidades: 0,
            total: 0,
            total_facturado: 0,
            total_notas_credito: 0,
            clientes: new Set(),
          };
          g.cantidad_comprobantes += 1;
          if (esNC) {
            g.cantidad_nc += 1;
            g.total_notas_credito += rawMontoAbsoluto;
          } else {
            g.cantidad_facturas += 1;
            g.total_facturado += rawMontoAbsoluto;
          }
          g.total += rawMonto;
          g.clientes.add(clienteIdentificador);
          grupos.set(fallbackKey, g);
        } else {
          const multiplier = esNC ? -1 : 1;
          for (const it of itemsFactura) {
            const cant = parseAmount(it.Cantidad ?? 1) * multiplier;
            const subtotal = Math.abs(parseAmount(it.Subtotal ?? it.PrecioUnitario * it.Cantidad ?? 0)) * multiplier;
            unidadesGeneral += cant;

            let prodKey = "Varios";
            if (agrupar_por === "producto") {
              prodKey = it.Concepto || it.Nombre || it.Codigo || "Producto sin nombre";
            } else if (agrupar_por === "rubro") {
              const idRubro = Number(it.IdRubro || it.idRubro);
              prodKey = rubrosMap.get(idRubro) || it.Rubro || "Sin rubro";
            }

            const g = grupos.get(prodKey) || {
              grupo: prodKey,
              etiqueta_periodo: prodKey,
              cantidad_comprobantes: 0,
              cantidad_facturas: 0,
              cantidad_nc: 0,
              unidades: 0,
              total: 0,
              total_facturado: 0,
              total_notas_credito: 0,
              clientes: new Set(),
            };
            g.cantidad_comprobantes += 1;
            if (esNC) {
              g.cantidad_nc += 1;
              g.total_notas_credito += Math.abs(subtotal);
            } else {
              g.cantidad_facturas += 1;
              g.total_facturado += Math.abs(subtotal);
            }
            g.unidades += cant;
            g.total += subtotal;
            g.clientes.add(clienteIdentificador);
            grupos.set(prodKey, g);
          }
        }
      }
    }

    const totalNeto = totalFacturado - totalNotasCredito;
    const ticketPromedio = cantidadFacturasGeneral > 0 ? Math.round((totalFacturado / cantidadFacturasGeneral) * 100) / 100 : 0;
    const conteoClientesUnicos =
      clientesUnicosGeneral.size === 0 && (cantidadFacturasGeneral > 0 || cantidadNcGeneral > 0) ? 1 : clientesUnicosGeneral.size;

    return {
      grupos,
      totalNeto: Math.round(totalNeto * 100) / 100,
      totalFacturado: Math.round(totalFacturado * 100) / 100,
      totalNotasCredito: Math.round(totalNotasCredito * 100) / 100,
      comprobantesGeneral: cantidadFacturasGeneral + cantidadNcGeneral,
      cantidadFacturasGeneral,
      cantidadNcGeneral,
      unidadesGeneral: Math.round(unidadesGeneral * 100) / 100,
      clientesUnicosGeneral: conteoClientesUnicos,
      ticketPromedio,
      cotizacionesExcluidas,
      ultimaFechaLeida,
    };
  }

  const actualData = procesarComprobantes(actualRes.items);
  let anteriorData = null;
  let truncadoTotal = actualRes.truncado;

  // 3. Comparación con período anterior si se solicitó
  if (comparar_con_periodo_anterior) {
    const prevHasta = subDays(fecha_desde, 1);
    const prevDesde = subDays(prevHasta, dias);

    const maxPagesAnterior = Math.max(15, 60 - totalPaginasUsadas);
    const anteriorRes = client.chunkedDateGet
      ? await client.chunkedDateGet("/comprobantes/search", {}, prevDesde, prevHasta, {
          chunkDays: 7,
          maxPagesPerChunk: 15,
          maxTotalPages: maxPagesAnterior,
          ttlSeconds: 300,
        })
      : await client.paginatedGet("/comprobantes/search", { fechaDesde: prevDesde, fechaHasta: prevHasta }, maxPagesAnterior, 300);

    if (anteriorRes.truncado) truncadoTotal = true;
    anteriorData = procesarComprobantes(anteriorRes.items);
  }

  // Determinar valor máximo para las barras visuales (MEJ-16)
  const maxTotalFila = Math.max(1, ...Array.from(actualData.grupos.values()).map((g) => Math.max(0, g.total)));

  // Ordenar grupos por total descendente
  const sortedGrupos = Array.from(actualData.grupos.values())
    .map((g) => {
      const ticketPromedioGrupo = g.cantidad_facturas > 0 ? Math.round((g.total_facturado / g.cantidad_facturas) * 100) / 100 : 0;
      const fila = {
        grupo: g.grupo,
        etiqueta_periodo: g.etiqueta_periodo || g.grupo,
        total: Math.round(g.total * 100) / 100,
        barra_visual: renderProgressBar(g.total, maxTotalFila, 10), // MEJ-16: visualización segura sin riesgo de rotura
        total_facturado: Math.round(g.total_facturado * 100) / 100,
        total_notas_credito: Math.round(g.total_notas_credito * 100) / 100,
        cantidad_facturas: g.cantidad_facturas,
        cantidad_nc: g.cantidad_nc,
        cantidad_comprobantes: g.cantidad_comprobantes,
        clientes_unicos: g.clientes.size,
        ticket_promedio: ticketPromedioGrupo,
        unidades: Math.round(g.unidades * 100) / 100,
      };

      if (anteriorData) {
        const prevG = anteriorData.grupos.get(g.grupo);
        const totalAnt = prevG ? Math.round(prevG.total * 100) / 100 : 0;
        fila.total_anterior = totalAnt;
        fila.variacion_pct =
          truncadoTotal || totalAnt === 0 ? null : Math.round(((fila.total - totalAnt) / Math.abs(totalAnt)) * 1000) / 10;
      }

      return fila;
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, top);

  const advertencias = [
    "Se excluyen cotizaciones (COT/NCT), presupuestos y comprobantes no fiscales de los totales de venta.",
  ];

  if (actualData.cotizacionesExcluidas > 0) {
    advertencias.push(`Se detectaron y omitieron ${actualData.cotizacionesExcluidas} comprobantes no fiscales / cotizaciones.`);
  }
  if (agrupar_por === "origen") {
    advertencias.push("En ventas de algunas integraciones Origen o Canal vienen vacíos. Se agrupan como 'Sin origen informado'.");
  }
  if (truncadoTotal) {
    advertencias.push(
      `Consulta limitada por tope de páginas de la API (última fecha alcanzada: ${actualData.ultimaFechaLeida || "desconocida"}). Se sugiere acotar el rango de fechas para mayor precisión.`
    );
  }

  let encabezadoResumen = "";
  if (truncadoTotal) {
    encabezadoResumen = `[DATOS PARCIALES / TRUNCADOS] Lectura cortada por límite de páginas (se leyeron comprobantes hasta ${
      actualData.ultimaFechaLeida || "fecha de corte"
    }). No se calculan variaciones porcentuales sobre períodos incompletos. `;
  }

  const resumen = `${encabezadoResumen}Ventas netas del período: ${formatCurrency(actualData.totalNeto)} (Facturado bruto: ${formatCurrency(
    actualData.totalFacturado
  )} en ${actualData.cantidadFacturasGeneral} facturas, NC: ${formatCurrency(actualData.totalNotasCredito)} en ${
    actualData.cantidadNcGeneral
  } notas de crédito). Ticket promedio: ${formatCurrency(actualData.ticketPromedio)}. Clientes únicos: ${
    actualData.clientesUnicosGeneral
  }.${anteriorData && !truncadoTotal ? ` Período anterior (neto): ${formatCurrency(anteriorData.totalNeto)}.` : ""}`;

  return formatToolResponse({
    datos: {
      totales_generales: {
        total_neto: actualData.totalNeto,
        total_facturado_bruto: actualData.totalFacturado,
        total_notas_credito: actualData.totalNotasCredito,
        cantidad_facturas: actualData.cantidadFacturasGeneral,
        cantidad_notas_credito: actualData.cantidadNcGeneral,
        cantidad_comprobantes: actualData.comprobantesGeneral,
        clientes_unicos: actualData.clientesUnicosGeneral,
        ticket_promedio: actualData.ticketPromedio,
        unidades: actualData.unidadesGeneral,
        cotizaciones_excluidas: actualData.cotizacionesExcluidas,
        ...(anteriorData
          ? {
              total_anterior: anteriorData.totalNeto,
              variacion_total_pct:
                truncadoTotal || anteriorData.totalNeto === 0
                  ? null
                  : Math.round(((actualData.totalNeto - anteriorData.totalNeto) / Math.abs(anteriorData.totalNeto)) * 1000) / 10,
            }
          : {}),
      },
      filas: sortedGrupos,
      // Datos normalizados listos para componentes visuales o gráficas (MEJ-16)
      grafico: {
        tipo: "barras",
        eje_x: sortedGrupos.map((f) => f.etiqueta_periodo || f.grupo),
        eje_y: sortedGrupos.map((f) => f.total),
      },
    },
    resumen,
    advertencias,
    truncado: truncadoTotal,
  });
}
