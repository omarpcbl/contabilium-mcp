import { z } from "zod";
import { formatToolResponse, parseAmount } from "../utils.js";

// Caché en memoria para nombres comerciales de productos (SKU -> Nombre) (BUG-04)
const skuNameCache = new Map();

async function resolveProductNames(items, client) {
  if (!items || items.length === 0) return;

  const sinNombre = items.filter(
    (it) => it.codigo && (!it.producto || it.producto === it.codigo)
  );

  if (sinNombre.length === 0) return;

  // Límite de seguridad para no exceder presupuesto de peticiones
  const lote = sinNombre.slice(0, 25);

  for (const item of lote) {
    const sku = String(item.codigo).trim();
    if (!sku) continue;

    if (skuNameCache.has(sku)) {
      item.producto = skuNameCache.get(sku);
      continue;
    }

    try {
      const res = await client.get("/conceptos/search", { filtro: sku, pageSize: 5 }, 1800);
      let itemsConceptos = [];
      if (Array.isArray(res)) {
        itemsConceptos = res;
      } else if (res && Array.isArray(res.Items)) {
        itemsConceptos = res.Items;
      } else if (res && Array.isArray(res.items)) {
        itemsConceptos = res.items;
      }

      const match =
        itemsConceptos.find(
          (c) => String(c.Codigo || c.codigo || "").trim().toLowerCase() === sku.toLowerCase()
        ) || itemsConceptos[0];

      if (match) {
        const nombre = match.Nombre || match.nombre || match.Concepto || sku;
        skuNameCache.set(sku, nombre);
        item.producto = nombre;
      } else {
        skuNameCache.set(sku, sku);
      }
    } catch {
      skuNameCache.set(sku, sku);
    }
  }
}

export const schema = {
  deposito_id: z.number().int().optional().describe("ID del depósito específico a consultar (opcional; si se omite, consulta todos)."),
  codigo_producto: z.string().optional().describe("Código SKU específico para filtrar (opcional)."),
  filtro: z.enum(["todos", "sin_stock", "bajo_umbral"]).default("todos").describe("Filtro de existencias: todos, sin_stock (<= 0), o bajo_umbral."),
  umbral: z.number().int().optional().describe("Valor umbral de existencias disponibles (requerido si filtro = bajo_umbral)."),
  top: z.number().int().min(1).max(200).default(20).describe("Cantidad máxima de productos a devolver (por defecto 20)."),
  orden: z.enum(["menor_disponible", "mayor_disponible", "alfabetico"]).default("menor_disponible").describe("Criterio de ordenamiento de los productos."),
};

export async function handler({ deposito_id, codigo_producto, filtro = "todos", umbral, top = 20, orden = "menor_disponible" }, client) {
  if (filtro === "bajo_umbral" && (umbral === undefined || umbral === null)) {
    throw new Error("El parámetro 'umbral' es obligatorio cuando el filtro es 'bajo_umbral'.");
  }

  // 1. Obtener lista de depósitos para tener los nombres
  const depositosRaw = await client.get("/inventarios/getDepositos", null, 1800);
  const depositosMap = new Map();
  const depositosActivos = [];

  if (Array.isArray(depositosRaw)) {
    for (const d of depositosRaw) {
      if (d.Id) {
        depositosMap.set(Number(d.Id), d.Nombre || `Depósito ${d.Id}`);
        if (d.Activo !== false) depositosActivos.push(Number(d.Id));
      }
    }
  }

  // 2. Determinar qué depósitos consultar
  const targetDepositos = deposito_id !== undefined ? [Number(deposito_id)] : depositosActivos;

  const todasLasFilas = [];
  let huboSobreventa = false;
  let huboStockNegativoSinReserva = false;
  let truncadoApi = false;

  // Si se busca un solo producto por código SKU puntual
  if (codigo_producto && targetDepositos.length > 1) {
    try {
      const skuData = await client.get("/inventarios/getStockBySKU", { codigo: codigo_producto.trim() }, 300);
      if (skuData && typeof skuData === "object") {
        const actual = parseAmount(skuData.StockActual ?? 0);
        const reservado = parseAmount(skuData.StockReservado ?? 0);
        const disponible = actual - reservado;

        if (reservado > 0 && actual < reservado) {
          huboSobreventa = true;
        } else if (actual < 0 && reservado <= 0) {
          huboStockNegativoSinReserva = true;
        }

        todasLasFilas.push({
          codigo: skuData.Codigo || codigo_producto,
          producto: skuData.Nombre || skuData.Codigo || codigo_producto,
          deposito: "Consolidado (Todos)",
          stock_actual: actual,
          stock_reservado: reservado,
          disponible,
        });
      }
    } catch {
      // Continuar por depósito individual
    }
  }

  if (todasLasFilas.length === 0) {
    for (const depId of targetDepositos) {
      const depNombre = depositosMap.get(depId) || `Depósito ${depId}`;
      const res = await client.paginatedGet("/inventarios/getStockByDeposito", { id: depId }, 10, 300);

      if (res.truncado) truncadoApi = true;

      for (const item of res.items) {
        const codigo = item.Codigo || item.codigo || "";
        if (codigo_producto && !codigo.toLowerCase().includes(codigo_producto.trim().toLowerCase())) {
          continue;
        }

        const stockActual = parseAmount(item.StockActual ?? item.stockActual ?? 0);
        const stockReservado = parseAmount(item.StockReservado ?? item.stockReservado ?? 0);
        const disponible = stockActual - stockReservado;

        if (stockReservado > 0 && stockActual < stockReservado) {
          huboSobreventa = true;
        } else if (stockActual < 0 && stockReservado <= 0) {
          huboStockNegativoSinReserva = true;
        }

        let cumpleFiltro = true;
        if (filtro === "sin_stock") {
          cumpleFiltro = disponible <= 0;
        } else if (filtro === "bajo_umbral") {
          cumpleFiltro = disponible <= umbral;
        }

        if (cumpleFiltro) {
          todasLasFilas.push({
            codigo,
            producto: item.Nombre || item.nombre || item.Concepto || codigo,
            deposito: depNombre,
            stock_actual: stockActual,
            stock_reservado: stockReservado,
            disponible,
          });
        }
      }
    }
  }

  // Ordenamiento según parámetro 'orden' (MEJ-07)
  if (orden === "menor_disponible") {
    todasLasFilas.sort((a, b) => a.disponible - b.disponible);
  } else if (orden === "mayor_disponible") {
    todasLasFilas.sort((a, b) => b.disponible - a.disponible);
  } else if (orden === "alfabetico") {
    todasLasFilas.sort((a, b) => (a.producto || a.codigo || "").localeCompare(b.producto || b.codigo || ""));
  }

  const totalEncontrados = todasLasFilas.length;
  const datos = todasLasFilas.slice(0, top);
  await resolveProductNames(datos, client);
  const esTruncadoPorTop = totalEncontrados > top;
  const truncado = truncadoApi || esTruncadoPorTop;

  const advertencias = [];
  if (huboSobreventa) {
    advertencias.push("Se detectó sobreventa: el stock físico es menor que las reservas activas comprometidas.");
  }
  if (huboStockNegativoSinReserva) {
    advertencias.push("Se detectaron existencias físicas negativas sin reservas activas registradas (posible desajuste de inventario).");
  }
  if (truncadoApi) {
    advertencias.push("Tope de 10 páginas de la API alcanzado. El total de productos en el depósito es superior a los registros leídos. Se sugiere filtrar por SKU o categoría.");
  }
  if (esTruncadoPorTop) {
    advertencias.push(`Se muestran ${datos.length} de ${totalEncontrados} productos leídos. Ajuste el parámetro 'top' si requiere más registros.`);
  }

  let resumen = "";
  if (truncadoApi) {
    resumen = `Se leyeron ${totalEncontrados} productos (tope máximo de 10 páginas de la API alcanzado; existen más registros en el depósito) con filtro '${filtro}' (mostrando los ${datos.length} principales ordenados por ${orden}).`;
  } else if (esTruncadoPorTop) {
    resumen = `Se encontraron ${totalEncontrados} producto(s) con filtro '${filtro}' (mostrando los ${datos.length} principales ordenados por ${orden}).`;
  } else {
    resumen = `Se encontraron ${totalEncontrados} producto(s) con filtro '${filtro}' (mostrando ${datos.length}).`;
  }

  return formatToolResponse({
    datos,
    resumen,
    advertencias,
    truncado,
  });
}
