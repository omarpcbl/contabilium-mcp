import { z } from "zod";
import { diffDays, formatToolResponse, parseAmount } from "../utils.js";

export const schema = {
  fecha_desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD requerido").describe("Fecha inicial de emisión (YYYY-MM-DD)."),
  fecha_hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD requerido").describe("Fecha final de emisión (YYYY-MM-DD)."),
  cliente_id: z.number().int().optional().describe("ID del cliente para filtrar comprobantes (opcional)."),
  tipos: z.array(z.string()).optional().describe("Lista de tipos de comprobante a incluir, ej. ['FCA', 'FCB', 'NCA'] (opcional)."),
  incluir_items: z.boolean().default(false).describe("Si es true, incluye el detalle de productos/ítems facturados."),
};

export async function handler({ fecha_desde, fecha_hasta, cliente_id, tipos, incluir_items }, client) {
  // Validación de rango máximo de 92 días
  const dias = diffDays(fecha_desde, fecha_hasta);
  if (dias > 92) {
    throw new Error(`El rango solicitado es de ${dias} días (supera el límite de 92 días). Por favor acota las fechas o pártelas en tramos.`);
  }

  const baseParams = {
    fechaDesde: fecha_desde,
    fechaHasta: fecha_hasta,
  };
  if (cliente_id) {
    baseParams.idCliente = cliente_id;
  }

  // Paginación segura con tope de 20 páginas (1.000 registros)
  const { items, truncado, totalRegistros } = await client.paginatedGet("/comprobantes/search", baseParams, 20, 300);

  // Filtrado en memoria por tipos (la API ignora el filtro por tipo - API-1213)
  const tiposUpper = tipos && tipos.length > 0 ? tipos.map((t) => t.toUpperCase().trim()) : null;

  const filtered = items.filter((c) => {
    if (cliente_id && Number(c.IdCliente || c.idCliente) !== Number(cliente_id)) {
      return false;
    }
    if (tiposUpper) {
      const tipo = (c.TipoFc || c.tipoFc || "").toUpperCase().trim();
      if (!tiposUpper.includes(tipo)) return false;
    }
    return true;
  });

  const datos = filtered.map((c) => {
    const rawTotal = c.ImporteTotalNeto ?? c.Total ?? c.ImporteTotalBruto ?? 0;
    const rawSaldo = c.Saldo ?? c.saldo ?? 0;

    const comp = {
      id: c.Id ?? c.id,
      numero: c.Numero || c.numero || "Sin número",
      tipo: c.TipoFc || c.tipoFc || "Otro",
      fecha_emision: (c.FechaEmision || c.fechaEmision || "").slice(0, 10),
      cliente: c.RazonSocial || c.razonSocial || "Consumidor Final",
      total: parseAmount(rawTotal),
      saldo: parseAmount(rawSaldo),
      fecha_vencimiento: c.FechaVencimiento ? c.FechaVencimiento.slice(0, 10) : null,
      origen: c.Origen || c.Canal || "Sin origen informado",
    };

    if (incluir_items) {
      comp.items = Array.isArray(c.Items)
        ? c.Items.map((it) => ({
            codigo: it.Codigo || it.codigo || "",
            nombre: it.Concepto || it.nombre || it.Nombre || "",
            cantidad: parseAmount(it.Cantidad ?? 1),
            precio_unitario: parseAmount(it.PrecioUnitario ?? it.precioUnitario ?? 0),
            subtotal: parseAmount(it.Subtotal ?? it.subtotal ?? 0),
          }))
        : [];
    }

    return comp;
  });

  const advertencias = ["El filtro de fechas es por fecha de emisión, no de alta."];
  if (truncado) {
    advertencias.push(`Búsqueda cortada por límite de 20 páginas (se leyeron ${totalRegistros} comprobantes). Sugerido acotar el rango de fechas.`);
  }

  const resumen = `Se listaron ${datos.length} comprobante(s) entre ${fecha_desde} y ${fecha_hasta}.`;

  return formatToolResponse({
    datos,
    resumen,
    advertencias,
    truncado,
  });
}
