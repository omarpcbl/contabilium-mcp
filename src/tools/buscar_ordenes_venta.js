import { z } from "zod";
import { diffDays, formatToolResponse, parseAmount, formatCurrency, getAccountIntegrations } from "../utils.js";

export const schema = {
  fecha_desde: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD requerido")
    .describe("Fecha inicial de la orden (YYYY-MM-DD)."),
  fecha_hasta: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD requerido")
    .describe("Fecha final de la orden (YYYY-MM-DD)."),
  filtro: z
    .string()
    .optional()
    .describe("Filtro de búsqueda: número de orden externa, referencia, nombre de cliente o IDVentaIntegracion (opcional)."),
  id_integracion: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("ID numérico de la integración e-commerce (opcional, ej: 27341 para filtrar por canal específico)."),
  page: z
    .number()
    .int()
    .min(1)
    .default(1)
    .optional()
    .describe("Número de página a consultar (por defecto 1)."),
};

export async function handler({ fecha_desde, fecha_hasta, filtro, id_integracion, page = 1 }, client) {
  // Validación de rango máximo de 92 días
  const dias = diffDays(fecha_desde, fecha_hasta);
  if (dias > 92) {
    throw new Error(`El rango solicitado es de ${dias} días (supera el límite de 92 días). Por favor acota las fechas o pártelas en tramos.`);
  }

  const queryParams = {
    fechaDesde: fecha_desde,
    fechaHasta: fecha_hasta,
    page: page || 1,
  };

  if (filtro && String(filtro).trim()) {
    queryParams.filtro = String(filtro).trim();
  }

  if (id_integracion !== undefined && id_integracion !== null) {
    queryParams.IDIntegracion = id_integracion;
  }

  // Llamada a /ordenesVenta/search
  const rawRes = await client.get("/ordenesVenta/search", queryParams, 60);

  let items = [];
  let totalItems = null;
  let totalPages = null;

  if (Array.isArray(rawRes)) {
    items = rawRes;
    totalItems = rawRes.length;
    totalPages = 1;
  } else if (rawRes && typeof rawRes === "object") {
    if (Array.isArray(rawRes.Items)) {
      items = rawRes.Items;
    } else if (Array.isArray(rawRes.items)) {
      items = rawRes.items;
    } else if (rawRes.Items && typeof rawRes.Items === "object") {
      items = [rawRes.Items];
    } else if (rawRes.items && typeof rawRes.items === "object") {
      items = [rawRes.items];
    }

    if (rawRes.TotalItems !== undefined) totalItems = Number(rawRes.TotalItems);
    else if (rawRes.totalItems !== undefined) totalItems = Number(rawRes.totalItems);

    if (rawRes.TotalPage !== undefined) totalPages = Number(rawRes.TotalPage);
    else if (rawRes.totalPage !== undefined) totalPages = Number(rawRes.totalPage);
  }

  // Si no se pasó id_integracion y la consulta retornó 0 resultados con filtro por referencia,
  // consultar en las integraciones activas de la cuenta para encontrar la orden
  if (items.length === 0 && id_integracion === undefined && filtro) {
    const integraciones = await getAccountIntegrations(client, fecha_desde, fecha_hasta);
    for (const discoveredId of integraciones) {
      try {
        const intRes = await client.get("/ordenesVenta/search", {
          ...queryParams,
          IDIntegracion: discoveredId,
        }, 60);
        const intItems = Array.isArray(intRes) ? intRes : (Array.isArray(intRes?.Items) ? intRes.Items : (Array.isArray(intRes?.items) ? intRes.items : []));
        if (intItems.length > 0) {
          for (const item of intItems) {
            item._queryIntegracion = discoveredId;
            items.push(item);
          }
          if (intRes?.TotalItems !== undefined) totalItems = (totalItems || 0) + Number(intRes.TotalItems);
          if (intRes?.TotalPage !== undefined) totalPages = Math.max(totalPages || 1, Number(intRes.TotalPage));
        }
      } catch {
        // Continuar con la siguiente integración
      }
    }
  }

  // Normalización exhaustiva de órdenes de venta soportando todas las convenciones de Contabilium
  const ordenesNormalizadas = items.map((o) => {
    const rawTotal = o.Total ?? o.total ?? o.ImporteTotal ?? o.ImporteTotalNeto ?? 0;
    
    // Mapeo exhaustivo de IDVentaIntegracion y NumeroOrden
    const rawIdVentaInt = o.IDVentaIntegracion || o.IdVentaIntegracion || o.idVentaIntegracion || o.NumeroOrden || o.numeroOrden || o.NroOrden || o.nroOrden || o.RefExterna || o.refExterna || null;
    const numeroOrden = String(o.NumeroOrden || o.numeroOrden || rawIdVentaInt || o.Numero || o.numero || (o.ID || o.Id ? `ID ${o.ID || o.Id}` : ""));
    
    // Mapeo exhaustivo de IDIntegracion y Canal (usando la integración consultada si vino vacía en el objeto)
    const rawIdIntegracion = o.IDIntegracion ?? o.IdIntegracion ?? o.idIntegracion ?? o._queryIntegracion ?? id_integracion ?? null;
    const idIntVal = (rawIdIntegracion !== undefined && rawIdIntegracion !== null && !isNaN(Number(rawIdIntegracion))) ? Number(rawIdIntegracion) : null;
    const nombreIntegracion = o.Integracion || o.integracion || o.Canal || o.canal || o.Origen || o.origen || null;
    
    // Mapeo exhaustivo de IDComprobante (incluyendo IDComprobante capitalizado de Contabilium)
    const rawIdComprobante = o.IDComprobante ?? o.IdComprobante ?? o.idComprobante ?? o.IDFactura ?? o.IdFactura ?? o.idFactura ?? o.ComprobanteId ?? o.comprobanteId;
    const numIdComprobante = (rawIdComprobante !== undefined && rawIdComprobante !== null && !isNaN(Number(rawIdComprobante))) ? Number(rawIdComprobante) : null;
    const idComprobante = (numIdComprobante && numIdComprobante > 0) ? numIdComprobante : null;
    
    // Estado y facturada calculado con precisión
    const estado = o.Estado || o.estado || o.Status || o.status || "Pendiente";
    const estadoLower = String(estado).trim().toLowerCase();
    const esEstadoFacturado = ["finalizada", "facturada", "emitida", "aprobada"].includes(estadoLower);
    const facturada = Boolean(idComprobante) || esEstadoFacturado;

    const fecha = (o.Fecha || o.fecha || o.FechaCreacion || o.fechaCreacion || "").slice(0, 19);

    // Mapeo exhaustivo de Cliente (Comprador, NroDocumento, TipoDocumento, IDPersona)
    const clienteNombre = o.Comprador || o.comprador || o.NombreCliente || o.nombreCliente || o.RazonSocial || o.razonSocial || o.Cliente || o.cliente;
    const clienteDoc = o.NroDocumento || o.nroDocumento || o.NroDoc || o.nroDoc || o.Cuit || o.cuit || o.Documento || o.documento;
    const tipoDoc = o.TipoDocumento || o.tipoDocumento || (clienteDoc ? (String(clienteDoc).replace(/\D/g, "").length === 11 ? "CUIT" : "DNI") : null);
    const idCliente = o.IDCliente ?? o.IdCliente ?? o.idCliente ?? o.IDPersona ?? o.IdPersona ?? o.idPersona ?? null;

    // Mapeo exhaustivo de Ítems (Concepto, Codigo, Cantidad, PrecioUnitario)
    const rawItems = Array.isArray(o.Items) ? o.Items : Array.isArray(o.items) ? o.items : [];
    const itemsDesglosados = rawItems.map((it) => ({
      id: it.Id ?? it.id ?? 0,
      sku: String(it.Codigo || it.codigo || it.Sku || it.sku || "").trim(),
      nombre: String(it.Concepto || it.concepto || it.Descripcion || it.descripcion || it.Nombre || it.nombre || "").trim(),
      cantidad: Number(it.Cantidad || it.cantidad || 1),
      precio: parseAmount(it.PrecioUnitario || it.precioUnitario || it.Precio || it.precio || it.Importe || 0),
      iva: it.Iva ?? it.iva ?? null,
    }));

    return {
      id: o.ID ?? o.Id ?? o.id,
      numero_orden: numeroOrden,
      id_venta_integracion: rawIdVentaInt ? String(rawIdVentaInt) : null,
      id_integracion: idIntVal,
      integracion: typeof nombreIntegracion === "string" ? nombreIntegracion : null,
      fecha,
      estado,
      facturada,
      id_comprobante: idComprobante,
      cliente: (clienteNombre || clienteDoc || idCliente) ? {
        id: idCliente !== null ? Number(idCliente) : null,
        nombre: typeof clienteNombre === "string" ? clienteNombre.trim() : null,
        tipo_documento: typeof tipoDoc === "string" ? tipoDoc.trim() : null,
        documento: clienteDoc !== undefined && clienteDoc !== null ? String(clienteDoc).trim() : null,
      } : null,
      total: parseAmount(rawTotal),
      items_cantidad: itemsDesglosados.length,
      items: itemsDesglosados.length > 0 ? itemsDesglosados : undefined,
    };
  });

  // Post-filtrado por referencia / texto si fue provisto
  let ordenesResultado = ordenesNormalizadas;
  if (filtro && String(filtro).trim()) {
    const fLower = String(filtro).trim().toLowerCase();
    ordenesResultado = ordenesNormalizadas.filter((o) => {
      const matchNum = o.numero_orden && o.numero_orden.toLowerCase().includes(fLower);
      const matchVentaInt = o.id_venta_integracion && o.id_venta_integracion.toLowerCase().includes(fLower);
      const matchId = String(o.id).includes(fLower);
      const matchCliNom = o.cliente?.nombre && o.cliente.nombre.toLowerCase().includes(fLower);
      const matchCliDoc = o.cliente?.documento && o.cliente.documento.includes(fLower);
      const matchComp = o.id_comprobante && String(o.id_comprobante).includes(fLower);
      return matchNum || matchVentaInt || matchId || matchCliNom || matchCliDoc || matchComp;
    });
  }

  // Hidratación de ítems e IDIntegracion si no vinieron en la respuesta de búsqueda
  if (ordenesResultado.length <= 5 || filtro) {
    for (const ord of ordenesResultado) {
      if ((!ord.items || ord.items.length === 0) && ord.id) {
        try {
          const detail = await client.get("/ordenesVenta", { id: ord.id }, 60);
          const detItems = Array.isArray(detail?.Items) ? detail.Items : (Array.isArray(detail?.items) ? detail.items : []);
          if (detItems.length > 0) {
            ord.items = detItems.map((it) => ({
              id: it.Id ?? it.id ?? 0,
              sku: String(it.Codigo || it.codigo || it.Sku || it.sku || "").trim(),
              nombre: String(it.Concepto || it.concepto || it.Descripcion || it.descripcion || it.Nombre || it.nombre || "").trim(),
              cantidad: Number(it.Cantidad || it.cantidad || 1),
              precio: parseAmount(it.PrecioUnitario || it.precioUnitario || it.Precio || it.precio || 0),
              iva: it.Iva ?? it.iva ?? null,
            }));
            ord.items_cantidad = ord.items.length;
          }
          if (!ord.id_integracion) {
            const rawDetInt = detail?.IDIntegracion ?? detail?.IdIntegracion ?? detail?.idIntegracion;
            if (rawDetInt) ord.id_integracion = Number(rawDetInt);
          }
        } catch {
          // Continuar con los datos disponibles
        }
      }

      // Si aún falta id_integracion y tiene id_comprobante, consultar comprobante
      if (!ord.id_integracion && ord.id_comprobante) {
        try {
          const compDetail = await client.get("/comprobantes", { id: ord.id_comprobante }, 60);
          const compInt = compDetail?.IDIntegracion ?? compDetail?.IdIntegracion;
          if (compInt) ord.id_integracion = Number(compInt);
        } catch {
          // Continuar
        }
      }
    }
  }

  const cant = ordenesResultado.length;
  let resumen = "";
  if (cant === 0) {
    const filtroMsg = filtro ? ` con filtro '${filtro}'` : "";
    const intMsg = id_integracion ? ` e integración ${id_integracion}` : "";
    resumen = `No se encontraron órdenes de venta entre el ${fecha_desde} y el ${fecha_hasta}${filtroMsg}${intMsg}.`;
  } else {
    const totalMonto = ordenesResultado.reduce((acc, o) => acc + (o.total || 0), 0);
    
    // Solo informar "Facturadas: X/Y" si al menos un registro tiene campo de facturación o estado válido
    const hayDatosFacturacion = items.some((raw) => {
      const c = raw.IDComprobante ?? raw.IdComprobante ?? raw.idComprobante ?? raw.IDFactura;
      const e = raw.Estado || raw.estado;
      return c !== undefined || (e && typeof e === "string");
    });

    let facturadasTexto = "";
    if (hayDatosFacturacion) {
      const facturadas = ordenesResultado.filter((o) => o.facturada).length;
      facturadasTexto = ` Facturadas: ${facturadas}/${cant}.`;
    } else {
      facturadasTexto = " (Estado de facturación no disponible en el listado).";
    }

    resumen = `Se encontraron ${cant} orden(es) de venta (Página ${page || 1}${totalPages ? ` de ${totalPages}` : ""}) por un total de ${formatCurrency(totalMonto)}.${facturadasTexto}`;
  }

  const advertencias = [];
  if (totalPages && (page || 1) < totalPages) {
    advertencias.push(`Existen más páginas de órdenes disponibles (${totalPages} en total). Pide la página ${(page || 1) + 1} para continuar.`);
  }

  return formatToolResponse({
    datos: {
      pagina_actual: page || 1,
      total_paginas: totalPages || 1,
      total_registros_estimados: totalItems ?? cant,
      id_integracion_consultado: id_integracion || null,
      ordenes: ordenesResultado,
    },
    resumen,
    advertencias,
    truncado: false,
  });
}
