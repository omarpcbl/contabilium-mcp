import { z } from "zod";
import { formatToolResponse, parseAmount } from "../utils.js";

/**
 * Control de acceso por cuenta para modificación y reemplazo de stock.
 * Por defecto está habilitado públicamente para todas las cuentas ("público hoy").
 * Configurable mediante variable de entorno:
 * MODIFICAR_STOCK_ALLOWED_ACCOUNTS=cuenta1@empresa.com,cuenta2@empresa.com
 * O reutiliza MODIFICAR_CONCEPTO_ALLOWED_ACCOUNTS si existe.
 */
export function isAccountAllowedToModifyStock(client) {
  const allowed =
    process.env.MODIFICAR_STOCK_ALLOWED_ACCOUNTS ||
    process.env.MODIFICAR_CONCEPTO_ALLOWED_ACCOUNTS ||
    process.env.CONCEPTO_WRITE_ALLOWED_ACCOUNTS;

  if (!allowed || allowed.trim() === "" || allowed.trim() === "*") {
    return { permitido: true };
  }

  const allowedList = allowed
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const accountId = String(client?.clientId || "").toLowerCase();

  const isAllowed = allowedList.some((entry) => accountId.includes(entry));
  if (isAllowed) {
    return { permitido: true };
  }

  return {
    permitido: false,
    motivo: `La cuenta conectada (${client?.clientId || "anónima"}) no tiene permisos habilitados para modificar el stock de conceptos.`,
  };
}

export const schema = {
  codigo: z
    .string()
    .optional()
    .describe("Código SKU del producto en Contabilium (opcional si se provee id)."),
  id: z
    .number()
    .int()
    .positive("El ID debe ser un entero positivo.")
    .optional()
    .describe("ID numérico único del concepto/producto en Contabilium (opcional si se provee codigo/SKU)."),
  cantidad: z
    .number()
    .describe("Nueva cantidad física de stock a establecer (reemplaza el stock existente en el depósito seleccionado)."),
  id_deposito: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("ID del depósito donde se actualizará el stock (opcional; si se omite, se utiliza el depósito central / principal activo)."),
  precio_unitario: z
    .number()
    .nonnegative("El precio unitario no puede ser negativo.")
    .optional()
    .describe("Nuevo precio unitario de venta (opcional; si se especifica, actualiza también el precio del producto)."),
};

export async function handler(args, client) {
  // 1. Validar control de acceso
  const checkAcceso = isAccountAllowedToModifyStock(client);
  if (!checkAcceso.permitido) {
    throw new Error(checkAcceso.motivo);
  }

  const { id, codigo, cantidad, id_deposito, precio_unitario } = args;

  if (!id && (!codigo || !codigo.trim())) {
    throw new Error("Debe especificar el 'codigo' (SKU) o el 'id' numérico del concepto para modificar su stock.");
  }

  if (cantidad === undefined || isNaN(Number(cantidad))) {
    throw new Error("Debe indicar la 'cantidad' de stock a fijar.");
  }

  const cantidadFisica = parseAmount(cantidad);

  // 2. Resolver datos del concepto (ID y SKU)
  let conceptoEncontrado = null;
  let skuTarget = (codigo || "").trim();
  let idTarget = id ? Number(id) : null;

  if (idTarget) {
    try {
      const res = await client.get("/conceptos", { id: idTarget });
      if (Array.isArray(res) && res.length > 0) {
        conceptoEncontrado = res.find((c) => Number(c.Id ?? c.id ?? c.IDConcepto) === idTarget) || res[0];
      } else if (res && typeof res === "object" && !res.Items && !res.items) {
        conceptoEncontrado = res;
      }
    } catch {
      // Continuar con fallback
    }

    if (!conceptoEncontrado) {
      try {
        const searchRes = await client.get("/conceptos/search", { pageSize: 50, filtro: String(idTarget) });
        const list = Array.isArray(searchRes) ? searchRes : (searchRes?.Items || searchRes?.items || []);
        conceptoEncontrado = list.find((c) => Number(c.Id ?? c.id ?? c.IDConcepto) === idTarget);
      } catch {
        // Continuar
      }
    }
  }

  if (!conceptoEncontrado && skuTarget) {
    try {
      const resByCod = await client.get("/conceptos/getByCodigo", { codigo: skuTarget });
      if (resByCod && typeof resByCod === "object") {
        conceptoEncontrado = resByCod;
      }
    } catch {
      // Continuar con search
    }

    if (!conceptoEncontrado) {
      try {
        const searchRes = await client.get("/conceptos/search", { pageSize: 50, filtro: skuTarget });
        const list = Array.isArray(searchRes) ? searchRes : (searchRes?.Items || searchRes?.items || []);
        conceptoEncontrado = list.find((c) => String(c.Codigo || c.codigo || "").trim().toLowerCase() === skuTarget.toLowerCase());
      } catch {
        // Continuar
      }
    }
  }

  if (!conceptoEncontrado) {
    throw new Error(
      `No se encontró ningún producto con ${idTarget ? `ID #${idTarget}` : `código SKU '${skuTarget}'`}. Verificá el catálogo usando 'buscar_productos'.`
    );
  }

  idTarget = Number(conceptoEncontrado.Id ?? conceptoEncontrado.id ?? conceptoEncontrado.IDConcepto ?? idTarget);
  skuTarget = String(conceptoEncontrado.Codigo || conceptoEncontrado.codigo || skuTarget).trim();
  const nombreProducto = String(conceptoEncontrado.Nombre || conceptoEncontrado.nombre || "Sin nombre").trim();

  // 3. Resolver depósito
  let targetDepositoId = id_deposito ? Number(id_deposito) : null;
  let targetDepositoNombre = "Depósito Principal";

  try {
    const depsRaw = await client.get("/inventarios/getDepositos", null, 1800);
    const listaDeps = Array.isArray(depsRaw) ? depsRaw : [];
    if (targetDepositoId) {
      const matchDep = listaDeps.find((d) => Number(d.Id ?? d.id) === targetDepositoId);
      if (matchDep) {
        targetDepositoNombre = matchDep.Nombre || matchDep.nombre || `Depósito #${targetDepositoId}`;
      } else {
        targetDepositoNombre = `Depósito #${targetDepositoId}`;
      }
    } else {
      // Seleccionar primer depósito activo
      const activo = listaDeps.find((d) => d.Activo !== false);
      if (activo) {
        targetDepositoId = Number(activo.Id ?? activo.id);
        targetDepositoNombre = activo.Nombre || activo.nombre || `Depósito #${targetDepositoId}`;
      } else if (listaDeps.length > 0) {
        targetDepositoId = Number(listaDeps[0].Id ?? listaDeps[0].id);
        targetDepositoNombre = listaDeps[0].Nombre || listaDeps[0].nombre || `Depósito #${targetDepositoId}`;
      } else {
        targetDepositoId = 1;
      }
    }
  } catch {
    targetDepositoId = targetDepositoId || 1;
  }

  // 4. Consultar stock anterior en ese depósito (para feedback informativo)
  let stockAnterior = 0;
  try {
    const stockInfo = await client.get("/inventarios/getStockBySKU", { codigo: skuTarget });
    const stockItems = stockInfo?.stock || stockInfo?.Stock || (Array.isArray(stockInfo) ? stockInfo : []);
    const depStock = stockItems.find((s) => Number(s.Id ?? s.id ?? s.IDInventario) === targetDepositoId);
    if (depStock) {
      stockAnterior = parseAmount(depStock.StockActual ?? depStock.stockActual ?? depStock.Stock ?? 0);
    }
  } catch {
    // Si falla la consulta previa de stock, continuar sin bloquear la actualización
  }

  // 5. Invocación a la API de Contabilium (reemplazo de stock)
  // El backend de Contabilium expone dos endpoints con [FromUri]:
  // a) POST /api/inventarios/actualizar?Codigo=...&Cantidad=...&IDDeposito=... (&PrecioUnitario=...)
  // b) POST /api/inventarios/modificarStock?ID=...&IDConcepto=...&Cantidad=...
  let operacionExitosa = false;
  let errorDetalle = null;

  if (skuTarget) {
    try {
      const params = {
        Codigo: skuTarget,
        Cantidad: cantidadFisica,
        IDDeposito: targetDepositoId,
      };
      if (precio_unitario !== undefined && precio_unitario !== null) {
        params.PrecioUnitario = parseAmount(precio_unitario);
      }
      await client.post("/inventarios/actualizar", {}, params);
      operacionExitosa = true;
    } catch (err) {
      errorDetalle = err.message;
    }
  }

  // Fallback con modificarStock si falló o si solo teníamos ID
  if (!operacionExitosa && idTarget) {
    try {
      const paramsStock = {
        ID: targetDepositoId,
        IDConcepto: idTarget,
        Cantidad: cantidadFisica,
      };
      await client.post("/inventarios/modificarStock", {}, paramsStock);
      operacionExitosa = true;
    } catch (errFallback) {
      throw new Error(
        `Error al actualizar stock en Contabilium: ${errFallback.message}${errorDetalle ? ` (Intento previo: ${errorDetalle})` : ""}`
      );
    }
  }

  if (!operacionExitosa) {
    throw new Error(`No se pudo actualizar el stock del producto en Contabilium: ${errorDetalle || "Error desconocido"}`);
  }

  // 6. Invalidar caché en memoria del cliente para inventarios y productos
  if (client.cache && typeof client.cache.keys === "function") {
    for (const key of client.cache.keys()) {
      if (key.includes("/inventarios") || key.includes("/conceptos")) {
        client.cache.delete(key);
      }
    }
  }

  const dif = Math.round((cantidadFisica - stockAnterior) * 100) / 100;
  const difStr = dif > 0 ? `+${dif}` : `${dif}`;

  let resumen = `Stock reemplazado exitosamente para "${nombreProducto}" (${skuTarget}, ID #${idTarget}) en "${targetDepositoNombre}": ${stockAnterior} -> ${cantidadFisica} unidades (${difStr}).`;
  if (precio_unitario !== undefined && precio_unitario !== null) {
    resumen += ` Precio unitario actualizado a $ ${parseAmount(precio_unitario)}.`;
  }

  return formatToolResponse({
    datos: {
      id: idTarget,
      codigo: skuTarget,
      producto: nombreProducto,
      id_deposito: targetDepositoId,
      deposito: targetDepositoNombre,
      stock_anterior: stockAnterior,
      stock_nuevo: cantidadFisica,
      diferencia: dif,
      ...(precio_unitario !== undefined && precio_unitario !== null ? { precio_unitario: parseAmount(precio_unitario) } : {}),
    },
    resumen,
    advertencias: [
      "Esta operación reemplazó el stock físico existente en el depósito indicado.",
      "El nuevo valor impacta inmediatamente en el inventario comercial de Contabilium.",
    ],
  });
}
