import { z } from "zod";
import { formatToolResponse, parseAmount } from "../utils.js";

// Caché en memoria para nombres de proveedores (ID -> Nombre)
const providerNameCache = new Map();

async function getProviderName(client, id) {
  if (!id || Number(id) <= 0) return null;
  const numId = Number(id);
  if (providerNameCache.has(numId)) return providerNameCache.get(numId);

  try {
    const prov = await client.get(`/proveedores/obtener?id=${numId}`, null, 1800);
    const name = prov?.RazonSocial || prov?.NombreFantasia || `Proveedor #${numId}`;
    providerNameCache.set(numId, name);
    return name;
  } catch {
    return null;
  }
}

export const schema = {
  texto: z.string().describe("Código SKU o nombre del producto/servicio."),
  rubro: z.string().optional().describe("Nombre del rubro para filtrar (opcional)."),
  limite: z.number().int().min(1).max(50).default(20).describe("Límite de productos a retornar (máx. 50)."),
};

export async function handler({ texto, rubro, limite }, client) {
  const query = texto.trim().toLowerCase();

  // 1. Obtener rubros con caché de 30 min (1800s) para mapear IDRubro -> Nombre
  const rubrosRaw = await client.get("/conceptos/rubros", null, 1800);
  const rubrosMap = new Map();
  if (Array.isArray(rubrosRaw)) {
    for (const r of rubrosRaw) {
      if (r.Id && r.Nombre) rubrosMap.set(Number(r.Id), r.Nombre);
    }
  }

  // 2. Buscar conceptos en la API
  const res = await client.get("/conceptos/search", { pageSize: 50, filtro: texto.trim() }, 300);

  let items = [];
  if (Array.isArray(res)) {
    items = res;
  } else if (res && Array.isArray(res.Items)) {
    items = res.Items;
  } else if (res && Array.isArray(res.items)) {
    items = res.items;
  }

  const rubroFilter = rubro ? rubro.trim().toLowerCase() : null;

  // Filtrado en memoria
  const filtered = items.filter((p) => {
    const cod = (p.Codigo || p.codigo || "").toLowerCase();
    const nom = (p.Nombre || p.nombre || "").toLowerCase();
    const idRubro = Number(p.IdRubro || p.idRubro);
    const rubroNombre = rubrosMap.get(idRubro) || p.Rubro || "Sin rubro";

    const matchesText = cod.includes(query) || nom.includes(query);
    const matchesRubro = rubroFilter ? rubroNombre.toLowerCase().includes(rubroFilter) : true;

    return matchesText && matchesRubro;
  });

  const sliced = filtered.slice(0, limite);

  // 3. Resolver nombres de proveedores concurrentemente
  const datos = await Promise.all(
    sliced.map(async (p) => {
      const idRubro = Number(p.IdRubro || p.idRubro);
      const rubroNombre = rubrosMap.get(idRubro) || p.Rubro || "Sin rubro";

      // Tipo: P (Producto), S (Servicio), C (Combo)
      let tipo = p.Tipo || "P";
      if (typeof tipo === "number") {
        tipo = tipo === 1 ? "P" : tipo === 2 ? "S" : "C";
      }

      const idProveedor = p.IDProveedor ?? p.IdProveedor ?? p.idProveedor ?? p.IDPersona ?? p.idPersona ?? null;
      const proveedorNombre = idProveedor ? await getProviderName(client, idProveedor) : null;
      const codigoProveedor = p.CodigoProveedor ?? p.codigoProveedor ?? "";

      return {
        id: p.Id ?? p.id,
        codigo: p.Codigo || p.codigo || "",
        nombre: p.Nombre || p.nombre || "Sin nombre",
        descripcion: p.Descripcion || p.descripcion || "",
        tipo: String(tipo).toUpperCase(),
        precio: parseAmount(p.Precio ?? p.precio ?? p.PrecioFinal ?? 0),
        costo_interno: parseAmount(p.CostoInterno ?? p.costoInterno ?? 0),
        stock_total: parseAmount(p.StockTotal ?? p.stockTotal ?? p.StockActual ?? p.Stock ?? 0),
        rubro: rubroNombre,
        id_proveedor: idProveedor ? Number(idProveedor) : null,
        codigo_proveedor: codigoProveedor,
        proveedor: proveedorNombre,
      };
    })
  );

  const resumen = `Se encontraron ${datos.length} producto(s) para "${texto}"${rubro ? ` en el rubro "${rubro}"` : ""}.`;

  return formatToolResponse({
    datos,
    resumen,
    advertencias: [
      "stock_total suma todos los depósitos. Para stock por depósito, usar stock_por_deposito.",
      "costo_interno representa el costo interno asignado al producto en Contabilium (utilizado como costo de compra / reposición).",
    ],
    truncado: filtered.length > limite,
  });
}
