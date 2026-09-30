import { z } from "zod";
import { formatToolResponse, parseAmount } from "../utils.js";

export const schema = {
  deposito_id: z.number().int().optional().describe("ID del depósito específico a consultar (opcional; si se omite, consulta todos)."),
  codigo_producto: z.string().optional().describe("Código SKU específico para filtrar (opcional)."),
  filtro: z.enum(["todos", "sin_stock", "bajo_umbral"]).default("todos").describe("Filtro de existencias: todos, sin_stock (<= 0), o bajo_umbral."),
  umbral: z.number().int().optional().describe("Valor umbral de existencias disponibles (requerido si filtro = bajo_umbral)."),
};

export async function handler({ deposito_id, codigo_producto, filtro, umbral }, client) {
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
  let truncado = false;

  // Si se busca un solo producto por código SKU puntual
  if (codigo_producto && targetDepositos.length > 1) {
    try {
      const skuData = await client.get("/inventarios/getStockBySKU", { codigo: codigo_producto.trim() }, 300);
      if (skuData && typeof skuData === "object") {
        const actual = parseAmount(skuData.StockActual ?? 0);
        const reservado = parseAmount(skuData.StockReservado ?? 0);
        const disponible = actual - reservado;
        if (disponible < 0) huboSobreventa = true;

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

      if (res.truncado) truncado = true;

      for (const item of res.items) {
        const codigo = item.Codigo || item.codigo || "";
        if (codigo_producto && !codigo.toLowerCase().includes(codigo_producto.trim().toLowerCase())) {
          continue;
        }

        const stockActual = parseAmount(item.StockActual ?? item.stockActual ?? 0);
        const stockReservado = parseAmount(item.StockReservado ?? item.stockReservado ?? 0);
        // Regla: disponible = stock_actual - stock_reservado (no usar StockConReservas que se trunca a 0)
        const disponible = stockActual - stockReservado;

        if (disponible < 0) {
          huboSobreventa = true;
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

  const advertencias = [];
  if (huboSobreventa) {
    advertencias.push("Se detectó sobreventa (disponible negativo) en uno o más productos. El stock físico es menor que las reservas activas.");
  }
  if (truncado) {
    advertencias.push("Consulta limitada por tope de páginas de inventario. Se sugiere filtrar por depósito específico o SKU.");
  }

  const resumen = `Se encontraron ${todasLasFilas.length} registro(s) de stock con filtro '${filtro}'.`;

  return formatToolResponse({
    datos: todasLasFilas,
    resumen,
    advertencias,
    truncado,
  });
}
