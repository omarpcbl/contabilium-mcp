import { z } from "zod";
import { diffDays, formatToolResponse, parseAmount, formatCurrency } from "../utils.js";

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

  // Normalización de órdenes de venta
  const ordenesNormalizadas = items.map((o) => {
    const rawTotal = o.Total ?? o.total ?? o.ImporteTotal ?? o.ImporteTotalNeto ?? 0;
    const numeroOrden = o.NumeroOrden || o.numeroOrden || o.IdVentaIntegracion || o.Numero || o.numero || `ID ${o.Id || o.id}`;
    const idIntegracion = o.IdIntegracion || o.idIntegracion || null;
    const idComprobante = o.IdComprobante || o.idComprobante || o.IdFactura || o.idFactura || null;
    const estado = o.Estado || o.estado || o.Status || o.status || "Pendiente";
    const fecha = (o.Fecha || o.fecha || o.FechaCreacion || o.fechaCreacion || "").slice(0, 19);

    const clienteNombre = o.NombreCliente || o.nombreCliente || o.RazonSocial || o.razonSocial || o.Cliente;
    const clienteDoc = o.NroDoc || o.nroDoc || o.Cuit || o.cuit;

    const rawItems = Array.isArray(o.Items) ? o.Items : Array.isArray(o.items) ? o.items : [];
    const itemsDesglosados = rawItems.map((it) => ({
      sku: it.Codigo || it.codigo || it.Sku || it.sku || "",
      nombre: it.Descripcion || it.descripcion || it.Nombre || it.nombre || "",
      cantidad: Number(it.Cantidad || it.cantidad || 1),
      precio: parseAmount(it.Precio || it.precio || it.PrecioUnitario || it.precioUnitario || 0),
    }));

    return {
      id: o.Id || o.id,
      numero_orden: String(numeroOrden),
      id_venta_integracion: o.IdVentaIntegracion || o.idVentaIntegracion || null,
      id_integracion: idIntegracion ? Number(idIntegracion) : null,
      fecha,
      estado,
      facturada: Boolean(idComprobante),
      id_comprobante: idComprobante ? Number(idComprobante) : null,
      cliente: (clienteNombre || clienteDoc) ? {
        id: o.IdCliente || o.idCliente || null,
        nombre: typeof clienteNombre === "string" ? clienteNombre : null,
        documento: typeof clienteDoc === "string" || typeof clienteDoc === "number" ? String(clienteDoc) : null,
      } : null,
      total: parseAmount(rawTotal),
      items_cantidad: itemsDesglosados.length,
      items: itemsDesglosados.length > 0 ? itemsDesglosados : undefined,
    };
  });

  const cant = ordenesNormalizadas.length;
  let resumen = "";
  if (cant === 0) {
    const filtroMsg = filtro ? ` con filtro '${filtro}'` : "";
    const intMsg = id_integracion ? ` e integración ${id_integracion}` : "";
    resumen = `No se encontraron órdenes de venta entre el ${fecha_desde} y el ${fecha_hasta}${filtroMsg}${intMsg}.`;
  } else {
    const totalMonto = ordenesNormalizadas.reduce((acc, o) => acc + (o.total || 0), 0);
    const facturadas = ordenesNormalizadas.filter((o) => o.facturada).length;
    resumen = `Se encontraron ${cant} orden(es) de venta (Página ${page || 1}${totalPages ? ` de ${totalPages}` : ""}) por un total de ${formatCurrency(totalMonto)}. Facturadas: ${facturadas}/${cant}.`;
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
      ordenes: ordenesNormalizadas,
    },
    resumen,
    advertencias,
    truncado: false,
  });
}
